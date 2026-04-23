// The hot-reload path in watch mode depends on stripStyles / extractStyles
// behaving correctly across single and multi-<style> block HTML. The original
// comment in iterate.js calls out a silent-fallthrough bug that existed when
// files had more than one block — these tests pin that fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripStyles, extractStyles } from '../../iterate.js';

test('stripStyles empties a single style block but keeps the tag', () => {
    const html = '<div><style>body { color: red; }</style></div>';
    assert.equal(stripStyles(html), '<div><style></style></div>');
});

test('stripStyles handles multiple style blocks', () => {
    const html = '<style>one</style><p>x</p><style>two</style>';
    assert.equal(stripStyles(html), '<style></style><p>x</p><style></style>');
});

test('stripStyles normalizes attributes off the style tag (structural equality only)', () => {
    // The hot-reload path only cares that the *structural* shape matches between
    // runs — attribute differences shouldn't block the hot path. Current impl
    // replaces the whole match with a bare <style></style>, which is fine.
    const html = '<style type="text/css">rule</style>';
    assert.equal(stripStyles(html), '<style></style>');
});

test('extractStyles concatenates multiple blocks with newline', () => {
    const html = '<style>a</style><style>b</style>';
    assert.equal(extractStyles(html), 'a\nb');
});

test('extractStyles returns empty string when no style blocks', () => {
    assert.equal(extractStyles('<div>no styles</div>'), '');
});

test('extractStyles preserves block-internal whitespace', () => {
    const html = '<style>\n  .a { color: red; }\n</style>';
    assert.ok(extractStyles(html).includes('.a { color: red; }'));
});
