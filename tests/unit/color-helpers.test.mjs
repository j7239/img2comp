import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, rgbToLab } from '../../iterate.js';

test('toHex zero-pads each channel', () => {
    assert.equal(toHex(0, 0, 0), '#000000');
    assert.equal(toHex(255, 255, 255), '#ffffff');
    assert.equal(toHex(128, 64, 32), '#804020');
    assert.equal(toHex(1, 2, 3), '#010203');
});

test('rgbToLab black → L ≈ 0', () => {
    const [L] = rgbToLab(0, 0, 0);
    assert.ok(Math.abs(L) < 0.5, `expected L≈0, got ${L}`);
});

test('rgbToLab white → L ≈ 100', () => {
    const [L] = rgbToLab(255, 255, 255);
    assert.ok(Math.abs(L - 100) < 0.5, `expected L≈100, got ${L}`);
});

test('rgbToLab mid-grey has near-zero a* and b*', () => {
    const [, a, b] = rgbToLab(128, 128, 128);
    assert.ok(Math.abs(a) < 1, `expected a*≈0, got ${a}`);
    assert.ok(Math.abs(b) < 1, `expected b*≈0, got ${b}`);
});

test('rgbToLab pure red has strongly positive a*', () => {
    const [, a] = rgbToLab(255, 0, 0);
    assert.ok(a > 50, `expected a*>50 for red, got ${a}`);
});

test('rgbToLab pure blue has strongly negative b*', () => {
    const [, , b] = rgbToLab(0, 0, 255);
    assert.ok(b < -50, `expected b*<-50 for blue, got ${b}`);
});
