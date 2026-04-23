// Pure-function tests for the axis/region/stall prescription logic in
// computeSuggestedEdit. These are the rules the iter-edit subagent and the
// main session follow every iteration — regression risk is high, so they get
// the most coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSuggestedEdit, GRID_REGIONS } from '../../iterate.js';

const baseReport = (overrides = {}) => ({
    pixelmatchPct: 2.0,
    deltaE: 2.0,
    lumDelta: 0,
    edgePct: 0.5,
    grid: [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    ...overrides,
});

test('high deltaE routes to color axis with background targets', () => {
    const edit = computeSuggestedEdit(baseReport({ deltaE: 10 }), null);
    assert.equal(edit.axis, 'color');
    assert.ok(edit.cssTargets.includes('background'));
    assert.match(edit.hint, /gradient stops|oklch|oklab/i);
});

test('moderate deltaE + positive lumDelta routes to tone (too bright)', () => {
    const edit = computeSuggestedEdit(baseReport({ deltaE: 3, lumDelta: 20 }), null);
    assert.equal(edit.axis, 'tone');
    assert.match(edit.hint, /too bright/);
    assert.ok(edit.cssTargets.includes('box-shadow'));
});

test('moderate deltaE + negative lumDelta routes to tone (too dark)', () => {
    const edit = computeSuggestedEdit(baseReport({ deltaE: 3, lumDelta: -20 }), null);
    assert.equal(edit.axis, 'tone');
    assert.match(edit.hint, /too dark/);
});

test('high edgePct relative to score routes to geometry axis', () => {
    const edit = computeSuggestedEdit(
        baseReport({ deltaE: 2, lumDelta: 1, edgePct: 4, pixelmatchPct: 2 }),
        null
    );
    assert.equal(edit.axis, 'geometry');
    assert.ok(edit.cssTargets.includes('border-radius'));
    assert.match(edit.hint, /edge/i);
});

test('all-low metrics fall through to position axis', () => {
    const edit = computeSuggestedEdit(
        baseReport({ deltaE: 1, lumDelta: 1, edgePct: 0.2, pixelmatchPct: 0.5 }),
        null
    );
    assert.equal(edit.axis, 'position');
    assert.equal(edit.cssTargets.length, 0);
});

test('region name and regionGrid match the worst cell', () => {
    const grid = [[0, 0, 0], [0, 0, 0], [0, 50, 0]];
    const edit = computeSuggestedEdit(baseReport({ grid, pixelmatchPct: 5 }), null);
    assert.equal(edit.region, 'bottom-center');
    assert.deepEqual(edit.regionGrid, [2, 1]);
    assert.equal(edit.regionSeverity, 50);
});

test('GRID_REGIONS covers all 9 cells with unique names', () => {
    const flat = GRID_REGIONS.flat();
    assert.equal(flat.length, 9);
    assert.equal(new Set(flat).size, 9);
});

test('stall flag set when prev suggested same axis and score did not drop', () => {
    const prev = { pixelmatchPct: 2.0, suggestedEdit: { axis: 'color' } };
    const curr = baseReport({ deltaE: 10, pixelmatchPct: 2.0 });
    const edit = computeSuggestedEdit(curr, prev);
    assert.equal(edit.stalled, true);
    assert.match(edit.hint, /STALLED/);
});

test('no stall when score dropped ≥ 0.25pp', () => {
    const prev = { pixelmatchPct: 5.0, suggestedEdit: { axis: 'color' } };
    const curr = baseReport({ deltaE: 10, pixelmatchPct: 2.0 });
    const edit = computeSuggestedEdit(curr, prev);
    assert.equal(edit.stalled, false);
});

test('no stall when prev is null (first run)', () => {
    const edit = computeSuggestedEdit(baseReport({ deltaE: 10 }), null);
    assert.equal(edit.stalled, false);
});

test('no stall when prev had a different axis', () => {
    const prev = { pixelmatchPct: 2.0, suggestedEdit: { axis: 'geometry' } };
    const curr = baseReport({ deltaE: 10, pixelmatchPct: 2.0 });
    const edit = computeSuggestedEdit(curr, prev);
    assert.equal(edit.stalled, false);
});

test('confidence is clamped to [0, 1] for extreme inputs', () => {
    for (const extreme of [
        { deltaE: 100 },
        { deltaE: 3, lumDelta: 500 },
        { deltaE: 1, lumDelta: 1, edgePct: 100, pixelmatchPct: 10 },
    ]) {
        const edit = computeSuggestedEdit(baseReport(extreme), null);
        assert.ok(edit.confidence >= 0 && edit.confidence <= 1,
            `confidence ${edit.confidence} out of range for ${JSON.stringify(extreme)}`);
    }
});

test('report shape is stable — all required fields present', () => {
    const edit = computeSuggestedEdit(baseReport({ deltaE: 10 }), null);
    for (const key of ['axis', 'region', 'regionGrid', 'regionSeverity', 'confidence', 'cssTargets', 'stalled', 'hint']) {
        assert.ok(key in edit, `missing field: ${key}`);
    }
});
