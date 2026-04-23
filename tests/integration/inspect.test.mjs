// PROCESS.md step 4 — `node iterate.js inspect` prints backdrop / foreground
// bbox / suggested MASK_BOX rect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, cleanupWorkspace, runCLI } from '../helpers/workspace.mjs';

let ws, result;
before(async () => {
    ws = await makeWorkspace();
    result = await runCLI(ws, ['inspect']);
});
after(() => cleanupWorkspace(ws));

test('inspect exits 0', () => {
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
});

test('stdout reports fixture dimensions, backdrop, and foreground bbox', () => {
    assert.match(result.stdout, /100×100/);
    assert.match(result.stdout, /Backdrop estimate/);
    assert.match(result.stdout, /Foreground bbox/);
    assert.match(result.stdout, /Suggested MASK_BOX/);
});

test('suggested MASK_BOX rect is within the canvas', () => {
    const m = result.stdout.match(/const MASK_BOX = \{ x: (\d+), y: (\d+), width: (\d+), height: (\d+) \}/);
    assert.ok(m, 'MASK_BOX line not found');
    const [x, y, w, h] = m.slice(1).map(Number);
    assert.ok(x + w <= 100, `rect extends past canvas width: x=${x} w=${w}`);
    assert.ok(y + h <= 100, `rect extends past canvas height: y=${y} h=${h}`);
});
