// The reader behind the "New Claude Request" tab: only what you typed, newest first, secrets masked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrompts, mask } from '../lib/prompts.mjs';

let root;
const line = (o) => `${JSON.stringify(o)}\n`;
const human = (text, extra = {}) => ({
  type: 'user', uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), sessionId: 'sess-1', cwd: 'C:\\Users\\dev\\site',
  origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra,
});

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-prompts-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('masks keys, tokens and private keys, and long random-looking strings', () => {
  const out = mask('use sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123 then password: hunter2 and AKIAABCDEFGHIJKLMNOP');
  assert.ok(!/sk-abcdef|ghp_abc|hunter2|AKIAABC/.test(out));
  assert.match(out, /\[hidden\]/);
  assert.equal(mask('plain words only'), 'plain words only');
  assert.ok(!mask('x'.repeat(8) + 'A1b2C3d4'.repeat(8)).includes('A1b2C3d4A1b2C3d4'));
});

test('keeps only what a person typed, with its session, folder and permission mode', () => {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    line({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'sess-1' }),
    line(human('compile a list of sites')),
    line(human('tool output', { origin: { kind: 'task-notification' } })),
    line(human('<system-reminder>not typed</system-reminder>')),
    line(human('[Request interrupted by user for tool use]')),
    line({ ...human('x'), message: { role: 'user', content: [{ type: 'tool_result', content: 'big output' }] } }),
    line(human('side agent says hi', { isSidechain: true })),
    line(human('and the second question', { timestamp: new Date(Date.now() + 5000).toISOString() })),
  ].join(''));
  const p = createPrompts({ root });
  p.refresh();
  const got = p.list(10);
  assert.deepEqual(got.map((x) => x.text), ['and the second question', 'compile a list of sites']);
  assert.equal(got[0].sessionId, 'sess-1');
  assert.equal(got[0].cwd, 'C:\\Users\\dev\\site');
  assert.equal(got[0].mode, 'bypassPermissions');
});

test('picks up a question typed later, once, without re-reading the old ones', () => {
  const dir = path.join(root, 'proj2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, line(human('first')));
  const p = createPrompts({ root });
  p.refresh();
  p.refresh();
  assert.equal(p.list(50).filter((x) => x.text === 'first').length, 1);
  fs.appendFileSync(file, line(human('second', { timestamp: new Date(Date.now() + 9000).toISOString() })));
  p.refresh();
  const texts = p.list(50).map((x) => x.text);
  assert.equal(texts[0], 'second');
  assert.equal(texts.filter((t) => t === 'second').length, 1);
});

test('cards get numbers, oldest first, and keep them after a restart', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ids-'));
  const projects = path.join(base, 'projects', 'p');
  fs.mkdirSync(projects, { recursive: true });
  const idsFile = path.join(base, 'data', 'request-ids.json');
  const t0 = Date.now() - 60000;
  const at = (n) => new Date(t0 + n * 1000).toISOString();
  const file = path.join(projects, 'n.jsonl');
  fs.writeFileSync(file, [line(human('third', { timestamp: at(3) })), line(human('first', { timestamp: at(1) })), line(human('second', { timestamp: at(2) }))].join(''));
  const a = createPrompts({ root: path.join(base, 'projects'), idsFile });
  a.refresh();
  const nums = Object.fromEntries(a.list(10).map((x) => [x.text, x.n]));
  assert.deepEqual(nums, { first: 1, second: 2, third: 3 });
  assert.ok(fs.existsSync(idsFile));
  assert.ok(!fs.readFileSync(idsFile, 'utf8').includes('second'), 'the numbers file holds no prompt text');

  fs.appendFileSync(file, line(human('fourth', { timestamp: at(4) })));
  const b = createPrompts({ root: path.join(base, 'projects'), idsFile });
  b.refresh();
  const again = Object.fromEntries(b.list(10).map((x) => [x.text, x.n]));
  assert.deepEqual(again, { first: 1, second: 2, third: 3, fourth: 4 });
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('very long prompts are cut and marked; old transcripts and a missing folder are ignored', () => {
  const dir = path.join(root, 'proj3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'long.jsonl'), line(human('word '.repeat(600))));
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, line(human('from last month')));
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  const p = createPrompts({ root });
  p.refresh();
  const long = p.list(50).find((x) => x.text.startsWith('word word'));
  assert.equal(long.cut, true);
  assert.ok(long.text.length <= 1500);
  assert.ok(!p.list(50).some((x) => x.text === 'from last month'));
  const none = createPrompts({ root: path.join(root, 'nope') });
  none.refresh();
  assert.deepEqual(none.list(5), []);
});
