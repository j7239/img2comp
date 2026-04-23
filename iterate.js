import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.join(__dirname, 'reference.png');
const INDEX_HTML = path.join(__dirname, 'index.html');
const SHOTS = path.join(__dirname, 'screenshots');
const PALETTE = path.join(__dirname, 'palette.json');
const SCORES = path.join(__dirname, 'scores.log');

// Optional foreground mask. When set, the diff score only counts mismatched
// pixels inside this rectangle (coords in reference-pixel space). Leave null
// to score the full image. Run `node iterate.js inspect` for a suggested rect.
const MASK_BOX = null; // { x: 0, y: 0, width: 0, height: 0 }

// Named coordinates for color sampling, expressed as fractions of the reference image dims.
const SAMPLE_POINTS = {
    base:           [0.40, 0.47],
    topHighlight:   [0.47, 0.23],
    topLeftTint:    [0.32, 0.28],
    topRightTint:   [0.62, 0.28],
    bottomShadow:   [0.47, 0.60],
    leftEdge:       [0.28, 0.44],
    rightEdge:      [0.66, 0.44],
};

const IMPROVE_THRESHOLD_PP = 0.5;  // min drop required for auto-commit

function parseArgs() {
    const args = process.argv.slice(2);
    const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'diff';
    return {
        mode,
        flags: {
            withSidebyside: args.includes('--with-sidebyside'),
            commitOnImprove: args.includes('--commit-on-improve'),
            revertOnRegress: args.includes('--revert-on-regress'),
            help: args.includes('--help') || args.includes('-h'),
        },
    };
}

function printUsage() {
    console.log(`Usage:
  node iterate.js [FLAGS]          Render + diff once, append score to scores.log
  node iterate.js sample           Sample palette from reference into palette.json
  node iterate.js inspect          Print bounding boxes, backdrop, suggested MASK_BOX
  node iterate.js watch [FLAGS]    Keep server + browser alive, re-diff on index.html save

Flags:
  --with-sidebyside                Also write screenshots/default.png (side-by-side review)
  --commit-on-improve              git-commit index.html if score drops ≥ ${IMPROVE_THRESHOLD_PP}pp
  --revert-on-regress              git-checkout index.html if score goes up at all
  -h, --help                       Show this message

Scoring mask:
  Set MASK_BOX at the top of this file to a { x, y, width, height } rect
  (reference-pixel coords) to limit scoring to a foreground region.
`);
}

function assertReferenceIsPng() {
    if (!fs.existsSync(REFERENCE)) {
        throw new Error(`reference.png not found at ${REFERENCE}. Place a reference image named exactly "reference.png" in the project root.`);
    }
    const header = fs.readFileSync(REFERENCE).subarray(0, 8);
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!header.equals(pngMagic)) {
        throw new Error('reference.png is not a valid PNG file. This tool only supports PNG references.');
    }
}

function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function startServer(port = 8080) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath;
            let contentType = 'text/html';
            if (req.url === '/' || req.url === '') {
                filePath = INDEX_HTML;
            } else if (req.url === '/reference.png') {
                filePath = REFERENCE;
                contentType = 'image/png';
            } else {
                res.writeHead(404); res.end('Not Found'); return;
            }
            try {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(fs.readFileSync(filePath));
            } catch {
                res.writeHead(404); res.end('Not Found');
            }
        });
        server.listen(port, () => resolve(server));
    });
}

async function sampleColors() {
    const img = sharp(REFERENCE);
    const { width, height, hasAlpha } = await img.metadata();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;

    console.log(`\nSampling ${path.basename(REFERENCE)} (${width}×${height}${hasAlpha ? ', RGBA' : ', RGB'}):`);
    if (hasAlpha) {
        console.log('  Note: reference has alpha channel. Sampled RGB values are raw — transparent pixels read as their raw channel values, not as composited colors.');
    }

    const palette = {};
    const points = {};
    for (const [name, [fx, fy]] of Object.entries(SAMPLE_POINTS)) {
        const x = Math.floor(fx * width);
        const y = Math.floor(fy * height);
        const idx = (y * width + x) * channels;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const a = channels === 4 ? data[idx + 3] : 255;
        const hex = toHex(r, g, b);
        palette[name] = hex;
        points[name] = { x, y, rgb: [r, g, b], alpha: a, hex };
        console.log(`  ${name.padEnd(14)} (${x}, ${y})  rgb(${r}, ${g}, ${b})${channels === 4 ? ` a=${a}` : ''}  ${hex}`);
    }

    fs.writeFileSync(PALETTE, JSON.stringify({
        sampledAt: new Date().toISOString(),
        reference: path.basename(REFERENCE),
        dimensions: [width, height],
        hasAlpha,
        points,
        palette,
    }, null, 2));
    console.log(`\n✓ palette.json written`);
    return palette;
}

async function inspect() {
    const img = sharp(REFERENCE);
    const meta = await img.metadata();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height } = meta;
    const channels = info.channels;

    // Backdrop estimate: mode of border pixels (quantized to 8-unit buckets).
    // Walks the outer 4-px ring and counts each quantized color; the most common
    // bucket is the backdrop. Robust against corner artifacts (shadows, panels).
    const bucketCounts = new Map();
    const addSample = (r, g, b) => {
        const key = `${r >> 3},${g >> 3},${b >> 3}`;
        const entry = bucketCounts.get(key);
        if (entry) { entry.n++; entry.sum[0] += r; entry.sum[1] += g; entry.sum[2] += b; }
        else bucketCounts.set(key, { n: 1, sum: [r, g, b] });
    };
    const sampleRow = (y) => {
        for (let x = 0; x < width; x += 2) {
            const i = (y * width + x) * channels;
            addSample(data[i], data[i + 1], data[i + 2]);
        }
    };
    const sampleCol = (x) => {
        for (let y = 0; y < height; y += 2) {
            const i = (y * width + x) * channels;
            addSample(data[i], data[i + 1], data[i + 2]);
        }
    };
    for (const y of [0, 2, height - 3, height - 1]) sampleRow(y);
    for (const x of [0, 2, width - 3, width - 1]) sampleCol(x);
    const topBucket = [...bucketCounts.values()].sort((a, b) => b.n - a.n)[0];
    const backdrop = topBucket.sum.map(v => Math.round(v / topBucket.n));

    // Foreground bbox: pixels ≥ THRESH channels from backdrop
    const THRESH = 15;
    let fx1 = width, fy1 = height, fx2 = -1, fy2 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * channels;
            const dr = Math.abs(data[i] - backdrop[0]);
            const dg = Math.abs(data[i + 1] - backdrop[1]);
            const db = Math.abs(data[i + 2] - backdrop[2]);
            if (dr > THRESH || dg > THRESH || db > THRESH) {
                if (x < fx1) fx1 = x;
                if (y < fy1) fy1 = y;
                if (x > fx2) fx2 = x;
                if (y > fy2) fy2 = y;
            }
        }
    }

    // Icon bbox: darkest pixels (luminance < 220) inside foreground bbox
    const ICON_LUM = 220;
    let ix1 = width, iy1 = height, ix2 = -1, iy2 = -1;
    if (fx2 >= fx1) {
        for (let y = fy1; y <= fy2; y++) {
            for (let x = fx1; x <= fx2; x++) {
                const i = (y * width + x) * channels;
                const lum = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
                if (lum < ICON_LUM) {
                    if (x < ix1) ix1 = x;
                    if (y < iy1) iy1 = y;
                    if (x > ix2) ix2 = x;
                    if (y > iy2) iy2 = y;
                }
            }
        }
    }

    console.log(`reference.png: ${width}×${height}, ${channels === 4 ? 'RGBA' : 'RGB'}, hasAlpha=${!!meta.hasAlpha}\n`);
    console.log('Backdrop estimate (mode of border-ring samples):');
    console.log(`  rgb(${backdrop.join(', ')})  ${toHex(...backdrop)}\n`);

    console.log(`Foreground bbox (pixels ≥ ${THRESH}/channel from backdrop):`);
    if (fx2 < fx1) {
        console.log('  (no foreground detected — reference may be too uniform)\n');
    } else {
        const fw = fx2 - fx1 + 1, fh = fy2 - fy1 + 1;
        const coverage = (fw * fh) / (width * height);
        console.log(`  (${fx1}, ${fy1}) → (${fx2}, ${fy2})   ${fw}×${fh}   coverage=${(coverage * 100).toFixed(0)}%`);
        console.log(`  center: (${(fx1 + fx2) >> 1}, ${(fy1 + fy2) >> 1})`);
        const pad = 15;
        const mx = Math.max(0, fx1 - pad);
        const my = Math.max(0, fy1 - pad);
        const mx2 = Math.min(width, fx2 + 1 + pad);
        const my2 = Math.min(height, fy2 + 1 + pad);
        console.log(`\n  Suggested MASK_BOX (foreground + ${pad}px pad):`);
        console.log(`    const MASK_BOX = { x: ${mx}, y: ${my}, width: ${mx2 - mx}, height: ${my2 - my} };`);
        if (coverage > 0.7) {
            console.log(`\n  ⚠ foreground covers ${(coverage * 100).toFixed(0)}% of the canvas — the reference`);
            console.log(`    likely has multiple non-target regions (panels, textures, scenery).`);
            console.log(`    Set MASK_BOX by hand to the target element's bbox (measure in step 4).`);
        }
        console.log('');
    }

    if (ix2 >= ix1) {
        const iw = ix2 - ix1 + 1, ih = iy2 - iy1 + 1;
        console.log(`Icon bbox (pixels with luminance < ${ICON_LUM} inside foreground):`);
        console.log(`  (${ix1}, ${iy1}) → (${ix2}, ${iy2})   ${iw}×${ih}`);
        console.log(`  center: (${(ix1 + ix2) >> 1}, ${(iy1 + iy2) >> 1})`);
    } else {
        console.log('Icon: none detected (no dark pixels inside foreground)');
    }
}

function appendScore(mismatched, total, pct) {
    const maskTag = MASK_BOX ? ' mask=on' : '';
    // Dedupe: skip if the last logged entry has the same score + pixels (watch-mode spam)
    if (fs.existsSync(SCORES)) {
        const tail = fs.readFileSync(SCORES, 'utf8').trimEnd().split('\n').pop() || '';
        const m = tail.match(/score=([\d.]+)%\s+pixels=(\d+)\/(\d+)/);
        if (m && m[1] === pct.toFixed(2) && +m[2] === mismatched && +m[3] === total) return false;
    }
    const line = `${new Date().toISOString()}  score=${pct.toFixed(2)}%  pixels=${mismatched}/${total}${maskTag}\n`;
    fs.appendFileSync(SCORES, line);
    return true;
}

function readPreviousScore() {
    if (!fs.existsSync(SCORES)) return null;
    const lines = fs.readFileSync(SCORES, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/score=([\d.]+)%/);
        if (m) return parseFloat(m[1]);
    }
    return null;
}

function cloneBuffer(png) {
    const copy = new PNG({ width: png.width, height: png.height });
    png.data.copy(copy.data);
    return copy;
}

function runDiff(implIn, refIn, refAlpha) {
    let impl = implIn, ref = refIn, total;
    if (MASK_BOX) {
        // Clone so we don't mutate cached buffers; zero pixels outside the mask
        impl = cloneBuffer(implIn);
        ref = cloneBuffer(refIn);
        const { x, y, width: mw, height: mh } = MASK_BOX;
        const W = impl.width, H = impl.height;
        for (let iy = 0; iy < H; iy++) {
            for (let ix = 0; ix < W; ix++) {
                if (ix >= x && ix < x + mw && iy >= y && iy < y + mh) continue;
                const i = (iy * W + ix) * 4;
                impl.data[i] = ref.data[i] = 0;
                impl.data[i + 1] = ref.data[i + 1] = 0;
                impl.data[i + 2] = ref.data[i + 2] = 0;
                impl.data[i + 3] = ref.data[i + 3] = 255;
            }
        }
        total = mw * mh;
    } else {
        total = impl.width * impl.height;
    }

    const diff = new PNG({ width: impl.width, height: impl.height });
    const mismatched = pixelmatch(
        impl.data, ref.data, diff.data,
        impl.width, impl.height,
        { threshold: 0.1 }
    );
    const pct = (mismatched / total) * 100;

    fs.writeFileSync(path.join(SHOTS, 'diff.png'), PNG.sync.write(diff));
    console.log(`✓ screenshots/diff.png            (mismatched regions)`);

    const maskNote = MASK_BOX
        ? ` (mask ${MASK_BOX.width}×${MASK_BOX.height} at ${MASK_BOX.x},${MASK_BOX.y})`
        : '';
    console.log(`\nDiff score: ${mismatched.toLocaleString()} / ${total.toLocaleString()} px${maskNote}  (${pct.toFixed(2)}%)`);
    if (refAlpha && !MASK_BOX) {
        console.log('Note: reference has alpha — transparent regions contribute to the diff against the opaque preview.');
    }
    const logged = appendScore(mismatched, total, pct);
    console.log(logged ? `  (appended to scores.log)` : `  (identical to previous — skipped scores.log append)`);
    return pct;
}

async function renderFrame(page, refMeta, flags) {
    const { width: refW, height: refH } = refMeta;
    const sized = await page.evaluate((w, h) => {
        const el = document.querySelector('.button-preview');
        if (!el) return false;
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        return true;
    }, refW, refH);
    if (!sized) {
        console.error('✗ .button-preview not found in index.html — cannot size or screenshot.');
        return null;
    }

    if (flags.withSidebyside) {
        await page.screenshot({ path: path.join(SHOTS, 'default.png'), omitBackground: false });
        console.log('✓ screenshots/default.png         (side-by-side, human review)');
    }

    const target = await page.$('.button-preview');
    const implPath = path.join(SHOTS, 'implementation.png');
    await target.screenshot({ path: implPath });
    console.log('✓ screenshots/implementation.png  (element crop, diff input)');
    return implPath;
}

async function setupContext() {
    const server = await startServer(8080);
    const [browser, refMeta, refBuf] = await Promise.all([
        puppeteer.launch({ headless: true, args: ['--no-sandbox'] }),
        sharp(REFERENCE).metadata(),
        Promise.resolve(fs.readFileSync(REFERENCE)),
    ]);
    const ref = PNG.sync.read(refBuf);
    const page = await browser.newPage();
    await page.setViewport({
        width: Math.max(1200, refMeta.width * 2 + 200),
        height: Math.max(800, refMeta.height + 200),
        deviceScaleFactor: 1,
    });
    await page.goto('http://localhost:8080', { waitUntil: 'load' });

    return {
        server, browser, page, ref, refMeta,
        close: async () => { await browser.close(); server.close(); },
    };
}

async function gitExec(...args) {
    return execFileAsync('git', args, { cwd: __dirname });
}

async function autoCommit(pct) {
    try {
        const { stdout: status } = await gitExec('status', '--porcelain', 'index.html');
        if (!status.trim()) return false;
        await gitExec('add', 'index.html');
        await gitExec('commit', '-m', `iter auto: ${pct.toFixed(2)}%`);
        console.log(`  → git commit: iter auto: ${pct.toFixed(2)}%`);
        return true;
    } catch (err) {
        console.error('  → auto-commit failed:', err.stderr || err.message);
        return false;
    }
}

async function autoRevert() {
    try {
        await gitExec('checkout', '--', 'index.html');
        console.log(`  → git checkout -- index.html (reverted)`);
        return true;
    } catch (err) {
        console.error('  → auto-revert failed:', err.stderr || err.message);
        return false;
    }
}

async function handleGitAutomation(prev, pct, flags) {
    if (prev == null) return;
    const drop = prev - pct;
    if (flags.commitOnImprove && drop >= IMPROVE_THRESHOLD_PP) {
        await autoCommit(pct);
    } else if (flags.revertOnRegress && drop < 0) {
        await autoRevert();
    }
}

async function singleRun(flags) {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const prev = readPreviousScore();
    const ctx = await setupContext();
    try {
        const implPath = await renderFrame(ctx.page, ctx.refMeta, flags);
        if (!implPath) return;
        const impl = PNG.sync.read(fs.readFileSync(implPath));
        const pct = runDiff(impl, ctx.ref, ctx.refMeta.hasAlpha);
        await handleGitAutomation(prev, pct, flags);
    } finally {
        await ctx.close();
    }
}

async function watchMode(flags) {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const ctx = await setupContext();
    let running = false;
    let pendingReload = false;

    async function runOnce() {
        if (running) { pendingReload = true; return; }
        running = true;
        try {
            const prev = readPreviousScore();
            await ctx.page.reload({ waitUntil: 'load' });
            const implPath = await renderFrame(ctx.page, ctx.refMeta, flags);
            if (!implPath) return;
            const impl = PNG.sync.read(fs.readFileSync(implPath));
            const pct = runDiff(impl, ctx.ref, ctx.refMeta.hasAlpha);
            await handleGitAutomation(prev, pct, flags);
            console.log('');
        } catch (err) {
            console.error('✗ run error:', err.message, '\n');
        } finally {
            running = false;
            if (pendingReload) { pendingReload = false; runOnce(); }
        }
    }

    await runOnce();
    console.log(`👀 watching ${path.basename(INDEX_HTML)} — save to re-diff, Ctrl+C to exit\n`);

    let debounceTimer = null;
    fs.watch(INDEX_HTML, (eventType) => {
        if (eventType !== 'change') return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runOnce, 300);
    });

    let closing = false;
    const cleanup = async () => {
        if (closing) return;
        closing = true;
        console.log('\nclosing...');
        await ctx.close();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    return new Promise(() => {}); // keep alive
}

async function main() {
    const { mode, flags } = parseArgs();
    if (flags.help) { printUsage(); return; }

    try {
        assertReferenceIsPng();
    } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exitCode = 1;
        return;
    }

    try {
        if (mode === 'sample') return await sampleColors();
        if (mode === 'inspect') return await inspect();
        if (mode === 'watch') return await watchMode(flags);
        if (mode === 'diff') return await singleRun(flags);
        console.error(`Unknown mode: ${mode}\n`);
        printUsage();
        process.exitCode = 1;
    } catch (err) {
        console.error('Error:', err);
        process.exitCode = 1;
    }
}

main();
