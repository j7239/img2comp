// Shared helpers for integration tests. Each test gets an isolated tmp
// workspace (reference.png + index.html + iterate.config.json) so CLI runs
// don't mutate the real project's .iterate/ output. iterate.js honors
// IMG2COMP_ROOT to make this work.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const ITERATE_PATH = path.join(REPO_ROOT, 'iterate.js');

// Synthesize a deterministic 100×100 PNG: light-grey backdrop with a centered
// 40×40 dark-blue square. Gives `init` / `inspect` / `sample` something real
// to detect — foreground bbox, backdrop mode, gradient hint — without depending
// on the user's actual reference.png.
async function writeFixtureReference(dest) {
    const W = 100, H = 100;
    const buf = Buffer.alloc(W * H * 3);
    const bg = [240, 240, 240];
    const fg = [60, 60, 180];
    for (let i = 0; i < W * H; i++) {
        buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2];
    }
    for (let y = 30; y < 70; y++) {
        for (let x = 30; x < 70; x++) {
            const i = y * W + x;
            buf[i * 3] = fg[0]; buf[i * 3 + 1] = fg[1]; buf[i * 3 + 2] = fg[2];
        }
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toFile(dest);
}

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; background: #f0f0f0; display: grid; place-items: center; min-height: 100vh; }
.button-preview { width: 100px; height: 100px; background: #3c3cb4; }
</style></head><body><div class="button-preview"></div></body></html>`;

export async function makeWorkspace({ samplePoints } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2comp-test-'));
    await writeFixtureReference(path.join(dir, 'reference.png'));
    fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE_HTML);
    fs.writeFileSync(path.join(dir, 'iterate.config.json'), JSON.stringify({
        selector: '.button-preview',
        improveThresholdPp: 0.25,
        maskBox: null,
        samplePoints: samplePoints ?? {},
    }, null, 2));
    return dir;
}

export function cleanupWorkspace(dir) {
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

export function runCLI(workspace, args = [], { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [ITERATE_PATH, ...args], {
            env: { ...process.env, IMG2COMP_ROOT: workspace },
            cwd: workspace,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

export function readJson(workspace, relPath) {
    return JSON.parse(fs.readFileSync(path.join(workspace, relPath), 'utf8'));
}

export function readLines(workspace, relPath) {
    const full = path.join(workspace, relPath);
    if (!fs.existsSync(full)) return [];
    return fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean);
}
