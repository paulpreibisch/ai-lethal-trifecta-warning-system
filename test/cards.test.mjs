import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCards } from '../server/cards.mjs';

test('rejects a card without a line, keeps a valid one', () => {
  const c = createCards();
  assert.equal(c.add({}), null);
  assert.equal(c.add(null), null);
  assert.equal(c.add({ line: '   ' }), null);
  const card = c.add({ line: 'Claude wants to stop a container.', summary: 'Stop proxy', tool: 'Bash', project: 'my-app' });
  assert.match(card.id, /^[0-9a-f]{12}$/);
  assert.equal(c.list().length, 1);
});

test('caps field lengths, strips control characters and unsafe project characters', () => {
  const card = createCards().add({ line: 'x'.repeat(5000), summary: 'a\u0000b\nc', tool: 't'.repeat(500), project: '../evil<script>' });
  assert.equal(card.line.length, 600);
  assert.equal(card.summary, 'a b c');
  assert.equal(card.tool.length, 80);
  assert.equal(card.project, '..evilscript');
});

test('keeps only the newest `max`, newest first', () => {
  const c = createCards({ max: 20 });
  for (let i = 0; i < 25; i++) c.add({ line: `line ${i}` });
  assert.equal(c.list().length, 20);
  assert.equal(c.list()[0].line, 'line 24');
});

test('keeps the folder and a well-formed session id, nothing that could break the resume command', () => {
  const c = createCards();
  const good = c.add({ line: 'a b c', cwd: 'D:\\efblockmexico', sessionId: '3f2a9c1e-7b44-4c1d-9a0e-5d6f7a8b9c0d' });
  assert.equal(good.cwd, 'D:\\efblockmexico');
  assert.equal(good.sessionId, '3f2a9c1e-7b44-4c1d-9a0e-5d6f7a8b9c0d');
  const bad = c.add({ line: 'a b c', cwd: 'C:\\x" && del *', sessionId: 'abc; rm -rf /' });
  assert.ok(!bad.cwd.includes('"'));
  assert.equal(bad.sessionId, '');
});

test('takes a valid voice and rejects an unsafe one', () => {
  const c = createCards();
  assert.equal(c.add({ line: 'a b c', voice: 'af_heart', provider: 'kokoro' }).voice, 'af_heart');
  assert.equal(c.add({ line: 'a b c', voice: '$(evil)', provider: 'x y' }).voice, '');
});

test("takes the hook's id, refuses a duplicate or malformed one", () => {
  const c = createCards();
  assert.equal(c.add({ id: 'a1b2c3d4e5f6', line: 'a b c' }).id, 'a1b2c3d4e5f6');
  assert.equal(c.add({ id: 'a1b2c3d4e5f6', line: 'again' }), null);
  assert.notEqual(c.add({ id: '../../etc', line: 'x y z' }).id, '../../etc');
  assert.ok(c.has('a1b2c3d4e5f6'));
});

test('records allowed or denied with the time, nothing else', () => {
  const c = createCards({ now: () => 5000 });
  const card = c.add({ line: 'a b c' });
  assert.equal(card.answer, '');
  assert.equal(c.answer(card.id, 'maybe'), null);
  assert.equal(c.answer('ffffffffffff', 'allowed'), null);
  assert.equal(c.answer(card.id, 'denied', 7000).answeredAt, 7000);
  assert.equal(c.list()[0].answer, 'denied');
  assert.equal(c.answer(card.id, 'allowed').answeredAt, 5000);
});

test('hydrate replays the log: newest first, answers applied, bad lines skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-log-'));
  try {
    const file = path.join(dir, 'attention-log.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'card', card: { id: '111111111111', line: 'first one', createdAt: 1000 } }),
      '{"type":"card","card":{broken',
      JSON.stringify({ type: 'card', card: { id: '222222222222', line: 'second one', createdAt: 2000 } }),
      JSON.stringify({ type: 'answer', id: '111111111111', answer: 'allowed', answeredAt: 1500 }),
      JSON.stringify({ type: 'card', card: { id: '111111111111', line: 'dupe', createdAt: 3000 } }),
      '{"type":"answer","id":"2222',
    ].join('\n'));
    const c = createCards();
    assert.equal(c.hydrate(file), 2);
    const [a, b] = c.list();
    assert.equal(a.id, '222222222222');
    assert.deepEqual([b.line, b.answer, b.answeredAt], ['first one', 'allowed', 1500]);
    assert.equal(createCards().hydrate(path.join(dir, 'missing.jsonl')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list() returns copies', () => {
  const c = createCards();
  c.add({ line: 'hello there' });
  c.list()[0].line = 'mutated';
  assert.equal(c.list()[0].line, 'hello there');
});
