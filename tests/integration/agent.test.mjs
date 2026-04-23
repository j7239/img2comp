// PROCESS.md step 6 — the `iter-edit` subagent is the fast-loop delegate. The
// agent file is consumed by Claude Code's agent loader, which requires valid
// frontmatter. This test guards the file against accidental breakage (malformed
// YAML, missing required fields, model downgrade typos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../helpers/workspace.mjs';

const AGENT_PATH = path.join(REPO_ROOT, '.claude/agents/iter-edit.md');

test('iter-edit agent file exists', () => {
    assert.ok(fs.existsSync(AGENT_PATH), `missing: ${AGENT_PATH}`);
});

test('frontmatter parses and contains required fields', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    assert.ok(match, 'frontmatter block not found');
    const fm = match[1];
    assert.match(fm, /^name:\s*iter-edit\s*$/m, 'name must be iter-edit');
    assert.match(fm, /^description:\s*\S/m, 'description required');
    assert.match(fm, /^tools:\s*\S/m, 'tools required');
    assert.match(fm, /^model:\s*haiku\s*$/m, 'model must be haiku (fast-loop optimization)');
});

test('agent body references the diff-report.json + suggestedEdit contract', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    assert.match(content, /diff-report\.json/, 'must reference diff-report.json');
    assert.match(content, /suggestedEdit/, 'must reference suggestedEdit field');
    assert.match(content, /stalled/, 'must handle the stalled flag');
});

test('agent output contract is pinned (single line: axis/region: target)', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    // The main session relies on this exact shape to parse the return.
    assert.match(content, /<axis>\/<region>:\s*<one-sentence named target>/);
});
