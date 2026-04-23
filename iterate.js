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
const CONFIG_PATH = path.join(__dirname, 'iterate.config.json');

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const MASK_BOX = CONFIG.maskBox ?? null;
const SAMPLE_POINTS = CONFIG.samplePoints ?? {};
const IMPROVE_THRESHOLD_PP = CONFIG.improveThresholdPp ?? 0.5;
const SELECTOR = CONFIG.selector ?? '.button-preview';

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
  node iterate.js init             Analyze reference + print visual questionnaire for briefing
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
    const sized = await page.evaluate((sel, w, h) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        return true;
    }, SELECTOR, refW, refH);
    if (!sized) {
        console.error(`✗ ${SELECTOR} not found in index.html — cannot size or screenshot.`);
        return null;
    }

    if (flags.withSidebyside) {
        await page.screenshot({ path: path.join(SHOTS, 'default.png'), omitBackground: false });
        console.log('✓ screenshots/default.png         (side-by-side, human review)');
    }

    const target = await page.$(SELECTOR);
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
        const { stdout: status } = await gitExec('status', '--porcelain', 'index.html');
        if (!status.trim()) {
            console.log(`  → already at HEAD, skipping revert`);
            return false;
        }
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

// Strip all <style> blocks from HTML for structural comparison.
function stripStyles(html) {
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
}

// Concatenate all <style> block contents from HTML.
function extractStyles(html) {
    return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
}

async function watchMode(flags) {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const ctx = await setupContext();
    let running = false;
    let pendingReload = false;
    let lastHtml = null;

    // Returns 'hot' (CSS inject, no reload) or 'full' (setContent, no HTTP).
    async function applyUpdate(newHtml) {
        if (lastHtml !== null && stripStyles(lastHtml) === stripStyles(newHtml)) {
            // Only <style> changed — inject directly into the live DOM.
            const ok = await ctx.page.evaluate((styles) => {
                const el = document.querySelector('style');
                if (!el) return false;
                el.textContent = styles;
                return true;
            }, extractStyles(newHtml));
            if (ok) { lastHtml = newHtml; return 'hot'; }
        }
        // Structural change or first run — push content directly (no HTTP round-trip).
        const withBase = newHtml.replace(/(<head[^>]*>)/i, '$1<base href="http://localhost:8080/">');
        await ctx.page.setContent(withBase, { waitUntil: 'domcontentloaded' });
        lastHtml = newHtml;
        return 'full';
    }

    async function runOnce() {
        if (running) { pendingReload = true; return; }
        running = true;
        const t0 = Date.now();
        try {
            const prev = readPreviousScore();
            const newHtml = fs.readFileSync(INDEX_HTML, 'utf8');
            const updateType = await applyUpdate(newHtml);
            console.log(`↺ ${updateType === 'hot' ? '⚡ hot (CSS inject)' : '⟳ full (setContent)'}`);
            const implPath = await renderFrame(ctx.page, ctx.refMeta, flags);
            if (!implPath) return;
            const impl = PNG.sync.read(fs.readFileSync(implPath));
            const pct = runDiff(impl, ctx.ref, ctx.refMeta.hasAlpha);
            await handleGitAutomation(prev, pct, flags);
            // Sync lastHtml to whatever the file is now (may differ if reverted/committed).
            // The watcher skips runs where content matches lastHtml, so this prevents
            // git-op file changes from re-triggering the loop.
            try { lastHtml = fs.readFileSync(INDEX_HTML, 'utf8'); } catch {}
            console.log(`  cycle: ${Date.now() - t0}ms\n`);
        } catch (err) {
            console.error('✗ run error:', err.message, '\n');
        } finally {
            running = false;
            if (pendingReload) { pendingReload = false; runOnce(); }
        }
    }

    await runOnce();
    console.log(`👀 watching ${path.basename(INDEX_HTML)} — save to re-diff, Ctrl+C to exit\n`);

    // Watch the directory instead of the file — on macOS, git checkout and
    // editor atomic-saves replace the inode, silently killing a file watcher.
    // Content check in the debounce callback skips runs when git ops wrote the file
    // back to a state we already processed, preventing re-trigger loops.
    let debounceTimer = null;
    fs.watch(__dirname, (_eventType, filename) => {
        if (filename !== path.basename(INDEX_HTML)) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            try { if (fs.readFileSync(INDEX_HTML, 'utf8') === lastHtml) return; } catch {}
            runOnce();
        }, 100);
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

async function init() {
    // ── Automated analysis ────────────────────────────────────────────────────
    const img = sharp(REFERENCE);
    const meta = await img.metadata();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height } = meta;
    const channels = info.channels;

    // Backdrop: mode of outer-ring samples
    const bucketCounts = new Map();
    const addSample = (r, g, b) => {
        const key = `${r >> 3},${g >> 3},${b >> 3}`;
        const e = bucketCounts.get(key);
        if (e) { e.n++; e.sum[0] += r; e.sum[1] += g; e.sum[2] += b; }
        else bucketCounts.set(key, { n: 1, sum: [r, g, b] });
    };
    const sampleRow = y => { for (let x = 0; x < width; x += 2) { const i = (y * width + x) * channels; addSample(data[i], data[i+1], data[i+2]); } };
    const sampleCol = x => { for (let y = 0; y < height; y += 2) { const i = (y * width + x) * channels; addSample(data[i], data[i+1], data[i+2]); } };
    for (const y of [0, 2, height-3, height-1]) sampleRow(y);
    for (const x of [0, 2, width-3, width-1]) sampleCol(x);
    const topBucket = [...bucketCounts.values()].sort((a,b) => b.n - a.n)[0];
    const backdrop = topBucket.sum.map(v => Math.round(v / topBucket.n));

    // Foreground bbox
    const THRESH = 15;
    let fx1 = width, fy1 = height, fx2 = -1, fy2 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * channels;
            if (Math.abs(data[i]-backdrop[0]) > THRESH || Math.abs(data[i+1]-backdrop[1]) > THRESH || Math.abs(data[i+2]-backdrop[2]) > THRESH) {
                if (x < fx1) fx1 = x; if (y < fy1) fy1 = y;
                if (x > fx2) fx2 = x; if (y > fy2) fy2 = y;
            }
        }
    }
    const fw = fx2 >= fx1 ? fx2 - fx1 + 1 : 0;
    const fh = fx2 >= fx1 ? fy2 - fy1 + 1 : 0;
    const aspectRatio = fw && fh ? (fw / fh).toFixed(3) : 'unknown';

    // Sample 9 points across the foreground (3×3 grid) for color variety
    const gridColors = [];
    if (fw && fh) {
        for (const [gx, gy] of [[0.25,0.25],[0.5,0.25],[0.75,0.25],[0.25,0.5],[0.5,0.5],[0.75,0.5],[0.25,0.75],[0.5,0.75],[0.75,0.75]]) {
            const px = Math.floor(fx1 + gx * fw);
            const py = Math.floor(fy1 + gy * fh);
            const i = (py * width + px) * channels;
            gridColors.push({ gx, gy, hex: toHex(data[i], data[i+1], data[i+2]), a: channels === 4 ? data[i+3] : 255 });
        }
    }

    // Edge brightness: top vs bottom strip of foreground (helps identify gradient direction)
    let topLum = 0, botLum = 0, topN = 0, botN = 0;
    if (fw && fh) {
        const stripH = Math.max(1, Math.floor(fh * 0.15));
        for (let y = fy1; y < fy1 + stripH; y++) {
            for (let x = fx1; x <= fx2; x++) {
                const i = (y * width + x) * channels;
                topLum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]; topN++;
            }
        }
        for (let y = fy2 - stripH + 1; y <= fy2; y++) {
            for (let x = fx1; x <= fx2; x++) {
                const i = (y * width + x) * channels;
                botLum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]; botN++;
            }
        }
    }
    const topAvg = topN ? topLum / topN : 0;
    const botAvg = botN ? botLum / botN : 0;
    const gradientHint = topAvg > botAvg + 10 ? 'lighter at top → darker at bottom (top-to-bottom gradient likely)'
        : botAvg > topAvg + 10 ? 'lighter at bottom → darker at top (bottom-to-top or inner-bottom-glow likely)'
        : 'top/bottom brightness similar (radial or no strong vertical gradient)';

    // Alpha channel presence in foreground
    let hasTransparentPixels = false;
    if (channels === 4 && fw) {
        for (let y = fy1; y <= fy2 && !hasTransparentPixels; y++) {
            for (let x = fx1; x <= fx2; x++) {
                if (data[(y * width + x) * 4 + 3] < 240) { hasTransparentPixels = true; break; }
            }
        }
    }

    // ── Print report ──────────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════════');
    console.log('  INIT REPORT — read this before looking at reference.png');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('AUTOMATED MEASUREMENTS');
    console.log('──────────────────────');
    console.log(`  Canvas:        ${width} × ${height}px  (${channels === 4 ? 'RGBA' : 'RGB'})`);
    console.log(`  Backdrop:      rgb(${backdrop.join(', ')})  ${toHex(...backdrop)}`);
    if (fw) {
        console.log(`  Foreground:    ${fw} × ${fh}px  at (${fx1}, ${fy1})  aspect ${aspectRatio}`);
        console.log(`  Gradient hint: ${gradientHint}`);
        console.log(`  Alpha pixels:  ${hasTransparentPixels ? 'YES — element has transparency (glass/frosted likely)' : 'none detected in foreground'}`);
        console.log('\n  3×3 color grid across foreground (row-major, top-left → bottom-right):');
        gridColors.forEach(({ gx, gy, hex, a }) => {
            const label = `(${Math.round(gx*100)}%,${Math.round(gy*100)}%)`;
            console.log(`    ${label.padEnd(12)} ${hex}${a < 255 ? `  alpha=${a}` : ''}`);
        });
    } else {
        console.log('  Foreground:    none detected');
    }

    // ── Questions ─────────────────────────────────────────────────────────────
    console.log('\n\nVISUAL QUESTIONS — answer these by examining reference.png');
    console.log('────────────────────────────────────────────────────────────\n');

    const q = (n, label, options) => {
        console.log(`  Q${n}. ${label}`);
        if (options) options.forEach(o => console.log(`       ${o}`));
        console.log('');
    };

    q(1, 'BACKGROUND FILL — what kind of fill does the element have?',
        ['[ ] solid color', '[ ] linear gradient (note direction + approximate stops)',
         '[ ] radial gradient (note center position)', '[ ] mesh / multi-stop complex gradient',
         '[ ] none / fully transparent body']);

    q(2, 'GLASS / BLUR — is there a backdrop-filter blur effect?',
        ['[ ] yes — frosted/glass (blurred content shows through)',
         '[ ] no — opaque or only color-transparent (rgba), no blur']);

    q(3, 'BORDER — describe the border(s)',
        ['[ ] none', '[ ] solid uniform color', '[ ] gradient border (note angle + color stops)',
         '[ ] inner highlight line (top edge brighter)', '[ ] multiple stacked borders']);

    q(4, 'OUTER SHADOWS — how many distinct outer shadows?',
        ['For each: direction (top/bottom/left/right/ambient), color, approximate spread/blur']);

    q(5, 'INNER SHADOWS / INNER GLOW — any inset depth effects?',
        ['For each: which edge (top/bottom/etc.), color (light or dark), approximate size']);

    q(6, 'HIGHLIGHT / SHEEN — is there a specular highlight or gloss?',
        ['[ ] top-edge bright line', '[ ] interior gradient highlight', '[ ] none']);

    q(7, 'CORNER RADIUS — approximate',
        ['[ ] sharp (0)', '[ ] slight (4–8px)', '[ ] medium (12–20px)',
         '[ ] large (24–40px)', '[ ] pill / fully rounded']);

    q(8, 'ICON / LABEL — inner content?',
        ['[ ] none', '[ ] icon only (describe: line/filled, style, approx size)',
         '[ ] text only (describe: weight, case, approx size)',
         '[ ] icon + text']);

    q(9, 'OVERALL DEPTH STYLE — pick the closest',
        ['[ ] flat (no shadows/highlights)', '[ ] subtle elevation (single drop shadow)',
         '[ ] neumorphic (dual shadow + inset)',
         '[ ] glass / frosted (blur + translucency)', '[ ] layered / rich (multiple effects)']);

    q(10, 'ANYTHING ELSE — effects not covered above',
        ['(noise texture, outline glow, gradient border animation, clip-path shape, etc.)']);

    console.log('═══════════════════════════════════════════════════════');
    console.log('  Paste your answers alongside reference.png when starting.');
    console.log('  The more specific the answers, the closer the first pass.');
    console.log('═══════════════════════════════════════════════════════\n');
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
        if (mode === 'init') return await init();
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
