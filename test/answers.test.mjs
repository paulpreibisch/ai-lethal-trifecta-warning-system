import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createAnswerWatcher, transcriptPath } from '../lib/answers.mjs';

const use = (id, input, at = new Date().toISOString()) => JSON.stringify({
  type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
const res = (id, { error = false, text = 'ok', tur = { stdout: 'ok' }, at = new Date().toISOString() } = {}) => JSON.stringify({
  type: 'user', timestamp: at, toolUseResult: tur,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: [{ type: 'text', text }] }] } });
const REJECT = { error: true, text: "The user doesn't want to proceed with this tool use.", tur: 'User rejected tool use' };

test('a rejected call reads as denied', () => {
  const w = createAnswerWatcher('Bash', { command: 'rm x' });
  w.feed(use('t0', { command: 'rm x' }));
  assert.equal(w.answer(), null);
  w.feed(res('t0', REJECT));
  assert.equal(w.answer().answer, 'denied');
});

test('a call that ran and failed still counts as allowed', () => {
  const w = createAnswerWatcher('Bash', { command: 'false' });
  w.feed(use('t1', { command: 'false' }));
  w.feed(res('t1', { error: true, text: 'Exit code 1', tur: 'Error: Exit code 1' }));
  assert.equal(w.answer().answer, 'allowed');
});

test('an older identical call is not taken for this one', () => {
  const since = Date.now();
  const w = createAnswerWatcher('Bash', { command: 'ls' }, since);
  w.feed(use('old', { command: 'ls' }, new Date(since - 10 * 60 * 1000).toISOString()));
  w.feed(res('old'));
  assert.equal(w.answer(), null);
  w.feed(use('new', { command: 'ls' }));
  w.feed(res('new', REJECT));
  assert.equal(w.answer().answer, 'denied');
});

test('REGRESSION: denied, then the same command re-run and allowed, reads as denied', () => {
  // From a real transcript: the user rejected a call and Claude ran the identical
  // command again seconds later; a poll that sees all four lines at once must not
  // switch to the second call.
  const w = createAnswerWatcher('Bash', { command: 'cat x' });
  w.feed(use('first', { command: 'cat x' }));
  w.feed(res('first', REJECT));
  w.feed(use('second', { command: 'cat x' }));
  w.feed(res('second'));
  assert.equal(w.answer().answer, 'denied');
});

test('a result from before the prompt is ignored', () => {
  const w = createAnswerWatcher('Bash', { command: 'ls' }, Date.now());
  w.feed(use('t3', { command: 'ls' }));
  w.feed(res('t3', { at: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(w.answer(), null);
});

test('matches on the command when Claude Code adds fields to the input', () => {
  const w = createAnswerWatcher('Bash', { command: 'ls', description: 'List' });
  w.feed(use('t2', { command: 'ls' }));
  w.feed('not json at all');
  w.feed(res('t2'));
  assert.equal(w.answer().answer, 'allowed');
});

test('only a .jsonl under Claude’s projects folder is accepted', () => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  assert.equal(transcriptPath(path.join(projects, 'p', 's.jsonl')), path.join(projects, 'p', 's.jsonl'));
  assert.equal(transcriptPath(path.join(projects, 'p', 's.txt')), '');
  assert.equal(transcriptPath(path.join(projects, '..', 'x.jsonl')), '');
  assert.equal(transcriptPath(path.join(os.tmpdir(), 'x.jsonl')), '');
  assert.equal(transcriptPath(undefined), '');
});
