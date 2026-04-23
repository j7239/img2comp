// PROCESS.md step 1 — `node iterate.js init` writes .iterate/analysis.json
// with the automated measurements the main session reads before the Q1–Q10
// briefing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, cleanupWorkspace, runCLI, readJson } from '../helpers/workspace.mjs';

let ws;
before(async () => { ws = await makeWorkspace(); });
after(() => cleanupWorkspace(ws));

test('init exits 0 and writes analysis.json', async () => {
    const { code, stdout, stderr } = await runCLI(ws, ['init']);
    assert.equal(code, 0, `expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.match(stdout, /INIT REPORT/);
    // All ten briefing questions must be printed — the main session depends on them.
    for (let q = 1; q <= 10; q++) {
        assert.match(stdout, new RegExp(`Q${q}\\.`), `missing Q${q} in stdout`);
    }
});

test('analysis.json has the fields the main session + iter-edit agent rely on', () => {
    const analysis = readJson(ws, '.iterate/analysis.json');
    assert.deepEqual(analysis.dimensions, [100, 100]);
    assert.ok(analysis.backdrop.hex.match(/^#[0-9a-f]{6}$/), 'backdrop hex');
    assert.ok(analysis.foreground, 'foreground detected');
    assert.ok(analysis.foreground.width > 0 && analysis.foreground.height > 0);
    assert.ok(Array.isArray(analysis.gridColors) && analysis.gridColors.length === 9,
        '3×3 color grid has 9 entries');
    assert.ok(typeof analysis.gradientHint === 'string');
});

test('analysis.json backdrop matches the fixture (light grey)', () => {
    const analysis = readJson(ws, '.iterate/analysis.json');
    const [r, g, b] = analysis.backdrop.rgb;
    // Fixture uses rgb(240, 240, 240). Allow ±4 per channel for the mode-bucket rounding.
    assert.ok(Math.abs(r - 240) <= 4 && Math.abs(g - 240) <= 4 && Math.abs(b - 240) <= 4,
        `backdrop rgb(${r},${g},${b}) not close to (240,240,240)`);
});

test('analysis.json foreground bbox brackets the fixture square', () => {
    const analysis = readJson(ws, '.iterate/analysis.json');
    const { x, y, width, height } = analysis.foreground;
    // Fixture square is at (30, 30) → (69, 69), 40×40.
    assert.ok(x >= 28 && x <= 32, `fg x=${x} not near 30`);
    assert.ok(y >= 28 && y <= 32, `fg y=${y} not near 30`);
    assert.ok(width >= 38 && width <= 42, `fg width=${width} not near 40`);
    assert.ok(height >= 38 && height <= 42, `fg height=${height} not near 40`);
});
