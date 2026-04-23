// PROCESS.md step 6 — the core diff loop. Heavy: spins up puppeteer + an HTTP
// server. This test verifies the wiring end-to-end: implementation.png +
// diff.png + diff-report.json (with suggestedEdit) + history.jsonl are all
// produced and well-shaped. It asserts structure, not specific scores — pixel
// scores depend on puppeteer version, fonts, and anti-aliasing on the host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { makeWorkspace, cleanupWorkspace, runCLI, readJson, readLines } from '../helpers/workspace.mjs';

let ws, result;
before(async () => {
    ws = await makeWorkspace();
    // 60s timeout: puppeteer cold start can be slow on first run when the Chromium
    // download cache is cold. Subsequent runs are ~3s.
    result = await runCLI(ws, [], { timeoutMs: 60000 });
}, { timeout: 70000 });
after(() => cleanupWorkspace(ws));

test('diff run exits 0', () => {
    assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout.slice(-500)}`);
});

test('diff run produces all three screenshot outputs', () => {
    for (const rel of [
        '.iterate/screenshots/implementation.png',
        '.iterate/screenshots/diff.png',
        '.iterate/screenshots/diff-report.json',
    ]) {
        assert.ok(fs.existsSync(path.join(ws, rel)), `missing output: ${rel}`);
    }
});

test('diff-report.json has every metric the prescription logic needs', () => {
    const report = readJson(ws, '.iterate/screenshots/diff-report.json');
    for (const key of ['pixelmatchPct', 'deltaE', 'lumDelta', 'edgePct', 'grid', 'suggestedEdit']) {
        assert.ok(key in report, `missing: ${key}`);
    }
    assert.equal(report.grid.length, 3);
    assert.equal(report.grid[0].length, 3);
});

test('suggestedEdit has valid axis, region, and confidence', () => {
    const { suggestedEdit } = readJson(ws, '.iterate/screenshots/diff-report.json');
    assert.ok(['color', 'tone', 'geometry', 'position'].includes(suggestedEdit.axis));
    assert.ok(/^(top|middle|bottom)-(left|center|right)$|^center$/.test(suggestedEdit.region));
    assert.ok(suggestedEdit.confidence >= 0 && suggestedEdit.confidence <= 1);
    assert.ok(Array.isArray(suggestedEdit.cssTargets));
    assert.equal(typeof suggestedEdit.stalled, 'boolean');
    assert.equal(typeof suggestedEdit.hint, 'string');
});

test('history.jsonl has one baseline entry for this run', () => {
    const lines = readLines(ws, '.iterate/history.jsonl');
    assert.ok(lines.length >= 1, 'history.jsonl is empty');
    const entry = JSON.parse(lines[lines.length - 1]);
    for (const key of ['ts', 'score', 'axis', 'region', 'stalled', 'outcome']) {
        assert.ok(key in entry, `missing in history entry: ${key}`);
    }
    // First run has no prev → outcome should be 'baseline'.
    assert.equal(entry.outcome, 'baseline');
    assert.equal(entry.prev, null);
});

test('stdout shows the prescribed next edit for the main session / iter-edit agent', () => {
    assert.match(result.stdout, /▶ next edit:/);
    assert.match(result.stdout, /(color|tone|geometry|position)\//);
});
