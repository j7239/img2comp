import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Project root: defaults to the directory holding this file, but tests override
// via IMG2COMP_ROOT so they can run against an isolated fixture workspace
// without mutating the real `.iterate/` output.
const __dirname = process.env.IMG2COMP_ROOT
    ? path.resolve(process.env.IMG2COMP_ROOT)
    : path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.join(__dirname, 'reference.png');
const INDEX_HTML = path.join(__dirname, 'index.html');
const CONFIG_PATH = path.join(__dirname, 'iterate.config.json');

// All generated output lives under .iterate/ — keeps the repo root as the
// base template surface (code, config, docs, user's reference.png).
const OUT_DIR = path.join(__dirname, '.iterate');
const SHOTS = path.join(OUT_DIR, 'screenshots');
const PALETTE = path.join(OUT_DIR, 'palette.json');
const SCORES = path.join(OUT_DIR, 'scores.log');
const ANALYSIS = path.join(OUT_DIR, 'analysis.json');
const HISTORY = path.join(OUT_DIR, 'history.jsonl');
const REPORT = path.join(SHOTS, 'diff-report.json');

function ensureOutDir() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

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
  node iterate.js [FLAGS]          Render + diff once, append score to .iterate/scores.log
  node iterate.js init             Analyze reference + write .iterate/analysis.json + print briefing
  node iterate.js sample           Sample palette from reference into .iterate/palette.json
  node iterate.js inspect          Print bounding boxes, backdrop, suggested maskBox
  node iterate.js watch [FLAGS]    Keep server + browser alive, re-diff on index.html save

Flags:
  --with-sidebyside                Also write .iterate/screenshots/default.png (side-by-side)
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

    ensureOutDir();
    fs.writeFileSync(PALETTE, JSON.stringify({
        sampledAt: new Date().toISOString(),
        reference: path.basename(REFERENCE),
        dimensions: [width, height],
        hasAlpha,
        points,
        palette,
    }, null, 2));
    console.log(`\n✓ ${path.relative(__dirname, PALETTE)} written`);
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

async function detectEditedProps() {
    try {
        const { stdout } = await gitExec('diff', 'HEAD', '--', 'index.html');
        if (!stdout.trim()) return '';
        const props = new Set();
        for (const line of stdout.split('\n')) {
            if (!line.startsWith('+') || line.startsWith('+++')) continue;
            const m = line.match(/^\+\s*([a-z][a-z-]+)\s*:/);
            if (m) props.add(m[1]);
        }
        return [...props].slice(0, 3).join(',');
    } catch { return ''; }
}

async function appendScore(mismatched, total, pct, report = null) {
    ensureOutDir();
    const maskTag = MASK_BOX ? ' mask=on' : '';
    // Dedupe: skip if the last logged entry has the same score + pixels (watch-mode spam)
    if (fs.existsSync(SCORES)) {
        const tail = fs.readFileSync(SCORES, 'utf8').trimEnd().split('\n').pop() || '';
        const m = tail.match(/score=([\d.]+)%\s+pixels=(\d+)\/(\d+)/);
        if (m && m[1] === pct.toFixed(2) && +m[2] === mismatched && +m[3] === total) return false;
    }
    const extras = report
        ? `  ΔE=${report.deltaE}  lumΔ=${report.lumDelta >= 0 ? '+' : ''}${report.lumDelta}  edges=${report.edgePct.toFixed(2)}%`
        : '';
    const props = await detectEditedProps();
    const propsTag = props ? `  edits=${props}` : '';
    const line = `${new Date().toISOString()}  score=${pct.toFixed(2)}%  pixels=${mismatched}/${total}${maskTag}${extras}${propsTag}\n`;
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

// sRGB → CIE Lab (D65). Used for perceptual color distance (ΔE76).
function rgbToLab(r, g, b) {
    const lin = v => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
    const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
    const f = v => v > 0.008856 ? Math.cbrt(v) : (7.787 * v + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Sobel magnitude map on greyscale luminance. Returns Uint8Array (W*H).
function edgeMap(raw, W, H) {
    const lum = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
        lum[i] = 0.299 * raw[p] + 0.587 * raw[p + 1] + 0.114 * raw[p + 2];
    }
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const gx = -lum[i - W - 1] + lum[i - W + 1]
                     - 2 * lum[i - 1] + 2 * lum[i + 1]
                     - lum[i + W - 1] + lum[i + W + 1];
            const gy = -lum[i - W - 1] - 2 * lum[i - W] - lum[i - W + 1]
                     +  lum[i + W - 1] + 2 * lum[i + W] + lum[i + W + 1];
            out[i] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
        }
    }
    return out;
}

// Signed overlay: dim reference as base; tint red where impl is too bright,
// green where impl is too dark. Lets the AI read direction, not just magnitude.
function writeSignedOverlay(implRaw, refRaw, W, H, outPath) {
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        const rL = 0.299 * refRaw[o] + 0.587 * refRaw[o + 1] + 0.114 * refRaw[o + 2];
        const iL = 0.299 * implRaw[o] + 0.587 * implRaw[o + 1] + 0.114 * implRaw[o + 2];
        const delta = iL - rL;
        let r = refRaw[o] * 0.35, g = refRaw[o + 1] * 0.35, b = refRaw[o + 2] * 0.35;
        if (Math.abs(delta) > 8) {
            const mag = Math.min(1, Math.abs(delta) / 80);
            if (delta > 0) { r = Math.min(255, r + 220 * mag); g *= (1 - mag); b *= (1 - mag); }
            else { g = Math.min(255, g + 220 * mag); r *= (1 - mag); b *= (1 - mag); }
        }
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
    fs.writeFileSync(outPath, PNG.sync.write(png));
}

// Prescriptive next-action hint from the raw metrics. Encodes the same mapping
// PROCESS.md step 6 describes in prose (deltaE → color, lumDelta → tone,
// edgePct → geometry, else positional), so the per-iteration decision is a
// lookup for the agent rather than open-ended reasoning.
const GRID_REGIONS = [
    ['top-left',    'top-center',    'top-right'],
    ['middle-left', 'center',        'middle-right'],
    ['bottom-left', 'bottom-center', 'bottom-right'],
];

function computeSuggestedEdit(report, prev) {
    const { deltaE, lumDelta, edgePct, pixelmatchPct, grid } = report;

    let maxCell = 0, maxR = 1, maxC = 1;
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            if (grid[r][c] > maxCell) { maxCell = grid[r][c]; maxR = r; maxC = c; }
        }
    }
    const region = GRID_REGIONS[maxR][maxC];
    const cellFocused = maxCell > pixelmatchPct * 1.5 && maxCell > 2;

    let axis, hint, cssTargets, confidence;
    if (deltaE > 6) {
        axis = 'color';
        hint = `Fill color is wrong${cellFocused ? ` — worst in ${region}` : ' overall'}. Adjust \`background\` gradient stops or switch interpolation to \`in oklch\` / \`in oklab\`.`;
        cssTargets = ['background', 'background-color', 'background-image'];
        confidence = Math.min(1, deltaE / 15);
    } else if (Math.abs(lumDelta) > 12) {
        axis = 'tone';
        const dir = lumDelta > 0 ? 'too bright' : 'too dark';
        hint = `Implementation is globally ${dir} (lumΔ=${lumDelta >= 0 ? '+' : ''}${lumDelta}). Shift gradient midpoint, lightness, or shadow opacity — don't touch geometry.`;
        cssTargets = ['background', 'opacity', 'box-shadow'];
        confidence = Math.min(1, Math.abs(lumDelta) / 30);
    } else if (edgePct > Math.max(1, pixelmatchPct * 0.4)) {
        axis = 'geometry';
        hint = `Edge mismatch dominates (edges=${edgePct.toFixed(2)}% vs score=${pixelmatchPct.toFixed(2)}%). Check \`border-radius\`, border width, shadow spread, or element dimensions — colors are likely fine.`;
        cssTargets = ['border-radius', 'border', 'box-shadow', 'width', 'height', 'aspect-ratio'];
        confidence = Math.min(1, edgePct / 5);
    } else {
        axis = 'position';
        hint = cellFocused
            ? `Localized mismatch in ${region} (${maxCell.toFixed(2)}%) with clean color + edges — likely a small-feature or alignment issue. Read diff.png in that region.`
            : `Residual noise only — color, tone, and edges are all low. Consider calling it done or look at diff.png for remaining visible gaps.`;
        cssTargets = [];
        confidence = cellFocused ? 0.5 : 0.25;
    }

    // Stall detection: if the previous run suggested the same axis AND score
    // didn't drop meaningfully, don't keep pulling the same lever — flag a
    // structural rethink (flip gradient direction, change base shadow, etc).
    let stalled = false;
    if (prev && prev.suggestedEdit && prev.suggestedEdit.axis === axis) {
        const drop = prev.pixelmatchPct - pixelmatchPct;
        if (drop < 0.25) stalled = true;
    }

    return {
        axis,
        region,
        regionGrid: [maxR, maxC],
        regionSeverity: +maxCell.toFixed(2),
        confidence: +confidence.toFixed(2),
        cssTargets,
        stalled,
        hint: stalled ? `STALLED (${axis} axis unchanged last run). Structural rethink — ${hint}` : hint,
    };
}

function readPreviousReport() {
    try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return null; }
}

async function appendHistory(entry) {
    ensureOutDir();
    fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}

async function runDiff(implBuf, refBuf, refMeta) {
    const refW = refMeta.width, refH = refMeta.height;
    const rect = MASK_BOX
        ? { x: MASK_BOX.x, y: MASK_BOX.y, width: MASK_BOX.width, height: MASK_BOX.height }
        : { x: 0, y: 0, width: refW, height: refH };
    const { x, y, width: W, height: H } = rect;

    // Pre-crop once with sharp.extract — no full-canvas allocations for masked runs.
    const [implRaw, refRaw] = await Promise.all([
        sharp(implBuf).ensureAlpha().extract({ left: x, top: y, width: W, height: H }).raw().toBuffer(),
        sharp(refBuf).ensureAlpha().extract({ left: x, top: y, width: W, height: H }).raw().toBuffer(),
    ]);

    // --- pixelmatch on cropped region ---
    const diffData = Buffer.alloc(W * H * 4);
    const mismatched = pixelmatch(implRaw, refRaw, diffData, W, H, { threshold: 0.1 });
    const total = W * H;
    const pct = (mismatched / total) * 100;

    // --- ΔE (CIE76, sampled every 4th pixel) + luminance delta ---
    let deltaESum = 0, deltaECount = 0;
    let lumSumImpl = 0, lumSumRef = 0;
    const STRIDE = 4;
    for (let py = 0; py < H; py += STRIDE) {
        for (let px = 0; px < W; px += STRIDE) {
            const o = (py * W + px) * 4;
            const [L1, a1, b1] = rgbToLab(implRaw[o], implRaw[o + 1], implRaw[o + 2]);
            const [L2, a2, b2] = rgbToLab(refRaw[o], refRaw[o + 1], refRaw[o + 2]);
            const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
            deltaESum += Math.sqrt(dL * dL + da * da + db * db);
            deltaECount++;
            lumSumImpl += 0.299 * implRaw[o] + 0.587 * implRaw[o + 1] + 0.114 * implRaw[o + 2];
            lumSumRef += 0.299 * refRaw[o] + 0.587 * refRaw[o + 1] + 0.114 * refRaw[o + 2];
        }
    }
    const deltaE = deltaESum / deltaECount;
    const lumDelta = (lumSumImpl - lumSumRef) / deltaECount;

    // --- edge score: % of pixels where sobel magnitude differs by > 24 ---
    const eI = edgeMap(implRaw, W, H);
    const eR = edgeMap(refRaw, W, H);
    let edgeMismatch = 0;
    for (let i = 0; i < eI.length; i++) if (Math.abs(eI[i] - eR[i]) > 24) edgeMismatch++;
    const edgePct = (edgeMismatch / eI.length) * 100;

    // --- 3×3 grid breakdown (RGB L1 distance > 30 per cell) ---
    const CELLS = 3;
    const grid = Array.from({ length: CELLS }, () => Array(CELLS).fill(0));
    const cellCounts = Array.from({ length: CELLS }, () => Array(CELLS).fill(0));
    for (let py = 0; py < H; py++) {
        const cy = Math.min(CELLS - 1, Math.floor(py * CELLS / H));
        for (let px = 0; px < W; px++) {
            const cx = Math.min(CELLS - 1, Math.floor(px * CELLS / W));
            cellCounts[cy][cx]++;
            const o = (py * W + px) * 4;
            const d = Math.abs(implRaw[o] - refRaw[o])
                    + Math.abs(implRaw[o + 1] - refRaw[o + 1])
                    + Math.abs(implRaw[o + 2] - refRaw[o + 2]);
            if (d > 30) grid[cy][cx]++;
        }
    }
    const gridPct = grid.map((row, cy) =>
        row.map((n, cx) => +(n / cellCounts[cy][cx] * 100).toFixed(2))
    );

    // --- outputs ---
    writeSignedOverlay(implRaw, refRaw, W, H, path.join(SHOTS, 'diff.png'));
    console.log(`✓ .iterate/screenshots/diff.png   (signed: red=impl too bright, green=impl too dark)`);

    // Capture previous report before we overwrite — used for stall detection.
    const prevReport = readPreviousReport();

    const report = {
        timestamp: new Date().toISOString(),
        rect,
        masked: !!MASK_BOX,
        pixelmatchPct: +pct.toFixed(3),
        mismatched,
        total,
        deltaE: +deltaE.toFixed(2),
        lumDelta: +lumDelta.toFixed(2),
        edgePct: +edgePct.toFixed(3),
        grid: gridPct,
    };
    report.suggestedEdit = computeSuggestedEdit(report, prevReport);
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

    const maskNote = MASK_BOX ? ` (mask ${W}×${H} at ${x},${y})` : '';
    console.log(`\nDiff score: ${mismatched.toLocaleString()} / ${total.toLocaleString()} px${maskNote}  (${pct.toFixed(2)}%)`);
    console.log(`  ΔE(Lab): ${report.deltaE}   lumΔ: ${report.lumDelta >= 0 ? '+' : ''}${report.lumDelta}   edges: ${report.edgePct.toFixed(2)}%`);
    console.log(`  grid 3×3 (% mismatch per cell, row-major):`);
    gridPct.forEach(row => console.log(`    ${row.map(v => v.toFixed(2).padStart(6)).join('  ')}`));
    const sx = report.suggestedEdit;
    console.log(`\n▶ next edit: ${sx.axis}/${sx.region} (conf ${sx.confidence})${sx.stalled ? ' — STALLED' : ''}`);
    console.log(`  ${sx.hint}`);
    if (sx.cssTargets.length) console.log(`  targets: ${sx.cssTargets.join(', ')}`);
    if (refMeta.hasAlpha && !MASK_BOX) {
        console.log('Note: reference has alpha — transparent regions contribute to the diff against the opaque preview.');
    }
    const logged = await appendScore(mismatched, total, pct, report);
    console.log(logged ? `  (appended to scores.log)` : `  (identical to previous — skipped scores.log append)`);
    return { pct, report, prevReport };
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

    // Wait for webfonts + two rAF to let backdrop-filter / compositor settle.
    // Without this, 0.2–0.5% of diff is glyph + compositor noise that varies run-to-run.
    await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
    await page.evaluate(() => new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(r))
    ));

    if (flags.withSidebyside) {
        await page.screenshot({ path: path.join(SHOTS, 'default.png'), omitBackground: false });
        console.log('✓ .iterate/screenshots/default.png (side-by-side, human review)');
    }

    const target = await page.$(SELECTOR);
    const implBuf = await target.screenshot({ encoding: 'binary' });
    const implPath = path.join(SHOTS, 'implementation.png');
    fs.writeFileSync(implPath, implBuf);
    console.log('✓ .iterate/screenshots/implementation.png  (element crop, diff input)');
    return { implPath, implBuf };
}

async function setupContext(flags = {}) {
    const server = await startServer(8080);
    const [browser, refMeta, refBuf] = await Promise.all([
        puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--font-render-hinting=none',
                '--disable-lcd-text',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
            ],
        }),
        sharp(REFERENCE).metadata(),
        Promise.resolve(fs.readFileSync(REFERENCE)),
    ]);
    const page = await browser.newPage();

    // Viewport: just enough to contain the element unless sidebyside is requested.
    // Shrinking the paint area is the largest per-cycle speedup for big references.
    const vw = flags.withSidebyside
        ? Math.max(1200, refMeta.width * 2 + 200)
        : Math.max(480, refMeta.width + 80);
    const vh = flags.withSidebyside
        ? Math.max(800, refMeta.height + 200)
        : Math.max(480, refMeta.height + 80);
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });

    // Pin font smoothing globally so subpixel AA doesn't flicker between runs.
    await page.evaluateOnNewDocument(() => {
        const s = document.createElement('style');
        s.textContent = `*,*::before,*::after{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:geometricPrecision}`;
        (document.head || document.documentElement).appendChild(s);
    });

    await page.goto('http://localhost:8080', { waitUntil: 'load' });

    return {
        server, browser, page, refMeta, refBuf,
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
    if (prev == null) return null;
    const drop = prev - pct;
    if (flags.commitOnImprove && drop >= IMPROVE_THRESHOLD_PP) {
        return (await autoCommit(pct)) ? 'committed' : null;
    } else if (flags.revertOnRegress && drop < 0) {
        return (await autoRevert()) ? 'reverted' : null;
    }
    return null;
}

async function logHistory(prevPct, result) {
    if (!result) return;
    const { report, prevReport } = result;
    const props = await detectEditedProps();
    const prevAxis = prevReport?.suggestedEdit?.axis ?? null;
    const entry = {
        ts: report.timestamp,
        score: report.pixelmatchPct,
        prev: prevPct,
        delta: prevPct != null ? +(report.pixelmatchPct - prevPct).toFixed(3) : null,
        axis: report.suggestedEdit.axis,
        region: report.suggestedEdit.region,
        stalled: report.suggestedEdit.stalled,
        edits: props || null,
        // Link outcome to the axis that *drove* this edit (prev report's suggestion),
        // not the axis being suggested for the next iteration.
        drivenBy: prevAxis,
        outcome: result.gitAction ?? (prevPct == null ? 'baseline' : (report.pixelmatchPct < prevPct - 0.001 ? 'improved' : (report.pixelmatchPct > prevPct + 0.001 ? 'regressed' : 'noop'))),
    };
    await appendHistory(entry);
}

async function singleRun(flags) {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const prev = readPreviousScore();
    const ctx = await setupContext(flags);
    try {
        const rendered = await renderFrame(ctx.page, ctx.refMeta, flags);
        if (!rendered) return;
        const result = await runDiff(rendered.implBuf, ctx.refBuf, ctx.refMeta);
        result.gitAction = await handleGitAutomation(prev, result.pct, flags);
        await logHistory(prev, result);
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
    const ctx = await setupContext(flags);
    let running = false;
    let pendingReload = false;
    let lastHtml = null;

    // Returns 'hot' (CSS inject, no reload) or 'full' (setContent, no HTTP).
    // Hot path replaces every <style> block's content with the concatenated new
    // styles — avoids the silent-fallthrough bug when a file has multiple blocks.
    async function applyUpdate(newHtml) {
        if (lastHtml !== null && stripStyles(lastHtml) === stripStyles(newHtml)) {
            const ok = await ctx.page.evaluate((styles) => {
                const nodes = document.querySelectorAll('style');
                if (nodes.length === 0) return false;
                nodes.forEach((n, i) => { n.textContent = i === 0 ? styles : ''; });
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
            const rendered = await renderFrame(ctx.page, ctx.refMeta, flags);
            if (!rendered) return;
            const result = await runDiff(rendered.implBuf, ctx.refBuf, ctx.refMeta);
            result.gitAction = await handleGitAutomation(prev, result.pct, flags);
            await logHistory(prev, result);
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

    // ── Persist structured analysis for deterministic AI consumption ──────────
    const analysis = {
        reference: path.basename(REFERENCE),
        dimensions: [width, height],
        channels,
        hasAlpha: !!meta.hasAlpha,
        backdrop: { rgb: backdrop, hex: toHex(...backdrop) },
        foreground: fw ? { x: fx1, y: fy1, width: fw, height: fh, aspectRatio: +aspectRatio } : null,
        gradientHint,
        topStripLum: +topAvg.toFixed(1),
        bottomStripLum: +botAvg.toFixed(1),
        hasTransparentForeground: hasTransparentPixels,
        gridColors,
    };
    ensureOutDir();
    fs.writeFileSync(ANALYSIS, JSON.stringify(analysis, null, 2));

    // ── Print report ──────────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════════');
    console.log('  INIT REPORT — read this before looking at reference.png');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`  (structured data also written to ${path.relative(__dirname, ANALYSIS)})\n`);

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

// Only auto-run the CLI when invoked directly — not when tests import this
// module to reach the pure helpers below.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

export {
    computeSuggestedEdit,
    GRID_REGIONS,
    stripStyles,
    extractStyles,
    toHex,
    rgbToLab,
    readPreviousScore,
    readPreviousReport,
};
