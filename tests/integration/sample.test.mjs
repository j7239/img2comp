// PROCESS.md step 4 — `node iterate.js sample` sampling into .iterate/palette.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, cleanupWorkspace, runCLI, readJson } from '../helpers/workspace.mjs';

let ws;
before(async () => {
    ws = await makeWorkspace({
        samplePoints: {
            // On the fixture (dark square at 30-69), [0.5,0.5] hits the foreground,
            // [0.1,0.1] hits the backdrop. Pinning both lets us assert the sampler
            // actually reads the pixels at the configured fractions.
            center: [0.5, 0.5],
            corner: [0.1, 0.1],
        },
    });
});
after(() => cleanupWorkspace(ws));

test('sample exits 0 and writes palette.json', async () => {
    const { code, stderr } = await runCLI(ws, ['sample']);
    assert.equal(code, 0, `expected exit 0, got ${code}. stderr: ${stderr}`);
});

test('palette.json contains every configured SAMPLE_POINT', () => {
    const palette = readJson(ws, '.iterate/palette.json');
    assert.ok(palette.points.center, 'center point missing');
    assert.ok(palette.points.corner, 'corner point missing');
    for (const p of Object.values(palette.points)) {
        assert.match(p.hex, /^#[0-9a-f]{6}$/);
        assert.equal(p.rgb.length, 3);
    }
});

test('center sample lands on foreground (dark blue), corner on backdrop (light grey)', () => {
    const palette = readJson(ws, '.iterate/palette.json');
    const [cr, cg, cb] = palette.points.center.rgb;
    // Fixture foreground is rgb(60, 60, 180) — sum ~300
    assert.ok(cr + cg + cb < 500, `center rgb sum=${cr + cg + cb} — expected dark foreground`);

    const [kr, kg, kb] = palette.points.corner.rgb;
    // Backdrop is rgb(240, 240, 240) — sum ~720
    assert.ok(kr + kg + kb > 600, `corner rgb sum=${kr + kg + kb} — expected light backdrop`);
});
