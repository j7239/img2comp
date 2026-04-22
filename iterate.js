import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.join(__dirname, 'reference.png');
const SHOTS = path.join(__dirname, 'screenshots');
const PALETTE = path.join(__dirname, 'palette.json');
const SCORES = path.join(__dirname, 'scores.log');

// Named coordinates for color sampling, expressed as fractions of the reference image dims
// so they remain valid if the reference is swapped for one at a different resolution.
const SAMPLE_POINTS = {
    base:           [0.50, 0.50],
    topHighlight:   [0.50, 0.18],
    topLeftTint:    [0.28, 0.22],
    topRightTint:   [0.72, 0.22],
    bottomShadow:   [0.50, 0.82],
    leftEdge:       [0.20, 0.50],
    rightEdge:      [0.80, 0.50],
};

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

function startServer(port = 8080) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath;
            let contentType = 'text/html';

            if (req.url === '/' || req.url === '') {
                filePath = path.join(__dirname, 'index.html');
            } else if (req.url === '/reference.png') {
                filePath = REFERENCE;
                contentType = 'image/png';
            } else {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            try {
                const content = fs.readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            } catch {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        server.listen(port, () => resolve(server));
    });
}

function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
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

function appendScore(mismatched, total, pct) {
    const line = `${new Date().toISOString()}  score=${pct.toFixed(2)}%  pixels=${mismatched}/${total}\n`;
    fs.appendFileSync(SCORES, line);
}

async function renderAndDiff() {
    // Read reference dims up-front so we can size .button-preview to match.
    const refMeta = await sharp(REFERENCE).metadata();
    const { width: refW, height: refH, hasAlpha: refAlpha } = refMeta;

    const server = await startServer(8080);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

    try {
        const page = await browser.newPage();
        // Pin deviceScaleFactor to 1 so screenshot dims match CSS dims exactly.
        // Viewport just needs to fit the side-by-side layout at reference size.
        await page.setViewport({
            width: Math.max(1200, refW * 2 + 200),
            height: Math.max(800, refH + 200),
            deviceScaleFactor: 1,
        });
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

        // Auto-size .button-preview to exactly match reference dims.
        // This is the canvas alignment — no resize/stretching needed at diff time.
        const sized = await page.evaluate((w, h) => {
            const el = document.querySelector('.button-preview');
            if (!el) return false;
            el.style.width = w + 'px';
            el.style.height = h + 'px';
            return true;
        }, refW, refH);
        if (!sized) {
            console.error('✗ .button-preview not found in index.html — cannot size or screenshot.');
            return;
        }

        // Full-page screenshot (human review of side-by-side layout)
        await page.screenshot({ path: path.join(SHOTS, 'default.png'), omitBackground: false });
        console.log('✓ screenshots/default.png         (side-by-side, human review)');

        // Element-level screenshot of .button-preview — now exactly refW × refH
        const target = await page.$('.button-preview');
        const implPath = path.join(SHOTS, 'implementation.png');
        await target.screenshot({ path: implPath });
        console.log('✓ screenshots/implementation.png  (element crop, diff input)');

        const impl = PNG.sync.read(fs.readFileSync(implPath));
        if (impl.width !== refW || impl.height !== refH) {
            // Safety net: something went wrong with sizing. Fall back to resize.
            console.warn(`⚠ impl dims (${impl.width}×${impl.height}) ≠ ref dims (${refW}×${refH}). Falling back to cover-fit resize.`);
            const refResizedBuf = await sharp(REFERENCE)
                .resize(impl.width, impl.height, { fit: 'cover', position: 'center' })
                .png()
                .toBuffer();
            const ref = PNG.sync.read(refResizedBuf);
            return runDiff(impl, ref);
        }

        const ref = PNG.sync.read(fs.readFileSync(REFERENCE));
        runDiff(impl, ref, refAlpha);
    } finally {
        await browser.close();
        server.close();
    }
}

function runDiff(impl, ref, refAlpha) {
    const diff = new PNG({ width: impl.width, height: impl.height });
    const mismatched = pixelmatch(
        impl.data, ref.data, diff.data,
        impl.width, impl.height,
        { threshold: 0.1 }
    );
    const total = impl.width * impl.height;
    const pct = (mismatched / total) * 100;

    fs.writeFileSync(path.join(SHOTS, 'diff.png'), PNG.sync.write(diff));
    console.log(`✓ screenshots/diff.png            (mismatched regions)`);
    console.log(`\nDiff score: ${mismatched.toLocaleString()} / ${total.toLocaleString()} px  (${pct.toFixed(2)}%)`);
    if (refAlpha) {
        console.log('Note: reference has alpha — transparent regions contribute to the diff against the opaque preview.');
    }
    appendScore(mismatched, total, pct);
    console.log(`  (appended to scores.log)`);
}

async function main() {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

    try {
        assertReferenceIsPng();
    } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exitCode = 1;
        return;
    }

    const mode = process.argv[2];
    try {
        if (mode === 'sample') {
            await sampleColors();
        } else {
            await renderAndDiff();
        }
    } catch (err) {
        console.error('Error:', err);
        process.exitCode = 1;
    }
}

main();
