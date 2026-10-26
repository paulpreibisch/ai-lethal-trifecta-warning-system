// The real server, in its own process, with a temp HOME (never the live log).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39880;
const BASE = `http://127.0.0.1:${PORT}`;
let home, child;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: BASE } : {}), ...headers },
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function subscribe() {
  const events = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get(`${BASE}/events`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buf = buf.slice(i + 2);
          if (line) { const ev = JSON.parse(line.slice(6)); events.push(ev); if (ev.type === 'connected') resolve(); }
        }
      });
    });
    req.on('error', reject);
  });
  return { events, ready, close: () => req.destroy() };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); }
  return null;
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-srv-'));
  // A card from before the server started: it must come back from the log.
  fs.mkdirSync(path.join(home, '.claude-attention'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-attention', 'attention-log.jsonl'),
    `${JSON.stringify({ type: 'card', card: { id: 'abcabcabcabc', line: 'From the log.', createdAt: 1000 } })}\n`);
  // A question you typed earlier: the "New Claude Request" tab reads it from your transcripts.
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-tmp-site'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-tmp-site', 'abc.jsonl'),
    `${JSON.stringify({ type: 'user', uuid: 'q1', timestamp: new Date().toISOString(), sessionId: 'sess-xyz', cwd: '/tmp/site', origin: { kind: 'human' }, message: { role: 'user', content: 'compile a list of sites' } })}\n`);
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_ATTENTION_PORT: String(PORT), AGENTVIBES_URL: 'http://127.0.0.1:1' },
    stdio: 'ignore',
  });
  for (let n = 0; n < 80; n++) {
    try { if ((await request('GET', '/health')).json?.app === 'claude-attention') return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server never came up');
});

after(async () => {
  if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('serves the page and its script', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('app.js'));
  assert.equal((await request('GET', '/app.js')).status, 200);
});

test('cards from the log are back after a start, with a total and a page version', async () => {
  const r = (await request('GET', '/attention?limit=500')).json;
  assert.ok(r.cards.some(c => c.id === 'abcabcabcabc' && c.line === 'From the log.'));
  assert.equal(r.total, r.cards.length);
  assert.match(r.ui, /^\d/);
  // The log card is from 1970: too old for the day and week counts.
  assert.ok(Array.isArray(r.recent));
  assert.ok(!r.recent.some(h => h.createdAt === 1000));
});

test('a card reaches the open window, which counts as a viewer', async () => {
  const page = subscribe();
  await page.ready;
  try {
    const r = await request('POST', '/attention', { line: 'Claude wants to stop the proxy.', tool: 'Bash' });
    assert.equal(r.status, 200);
    assert.equal(r.json.viewers, 1);
    const ev = await waitFor(() => page.events.find(e => e.type === 'attention'));
    assert.equal(ev.card.line, 'Claude wants to stop the proxy.');
    const risky = await request('POST', '/attention', { line: 'Claude wants to wipe it.', risk: 'critical', riskReason: 'wipes a disk' });
    const { cards, recent } = (await request('GET', '/attention?limit=5')).json;
    assert.equal(cards.find(c => c.id === risky.json.id).risk, 'critical');
    assert.ok(recent.some(h => h.risk === 'critical' && h.answer === ''));
    const odd = await request('POST', '/attention', { line: 'x y z', risk: 'apocalyptic' });
    assert.equal((await request('GET', '/attention?limit=5')).json.cards.find(c => c.id === odd.json.id).risk, '');
  } finally {
    page.close();
  }
});

test('an answer reaches the window and the list; a card known from the log is not added twice', async () => {
  const page = subscribe();
  await page.ready;
  try {
    assert.equal((await request('POST', '/attention', { id: 'abcabcabcabc', line: 'From the log.' })).status, 200);
    assert.equal(page.events.filter(e => e.type === 'attention').length, 0);
    assert.equal((await request('POST', '/attention/answer', { id: 'abcabcabcabc', answer: 'allowed', answeredAt: 4242 })).status, 200);
    const ev = await waitFor(() => page.events.find(e => e.type === 'attention-answer'));
    assert.deepEqual([ev.id, ev.answer, ev.answeredAt], ['abcabcabcabc', 'allowed', 4242]);
    const listed = (await request('GET', '/attention?limit=500')).json.cards.find(c => c.id === 'abcabcabcabc');
    assert.equal(listed.answer, 'allowed');
    assert.equal((await request('POST', '/attention/answer', { id: 'ffffffffffff', answer: 'allowed' })).status, 404);
    assert.equal((await request('POST', '/attention/answer', { id: 'abcabcabcabc', answer: 'maybe' })).status, 404);
  } finally {
    page.close();
  }
});

test('a card without a line, bad JSON or an unknown route is refused', async () => {
  assert.equal((await request('POST', '/attention', { summary: 'x' })).status, 400);
  assert.equal((await request('DELETE', '/attention')).status, 404);
});

test('another website and a foreign Host are refused', async () => {
  assert.equal((await request('POST', '/attention', { line: 'x y z' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('GET', '/attention', null, { Host: 'evil.example:39880' })).status, 421);
});

test('serves the New Claude Request tab and the questions you typed', async () => {
  const page = await request('GET', '/');
  assert.ok(page.text.includes('tab-requests'));
  assert.equal((await request('GET', '/requests.js')).status, 200);
  assert.equal((await request('GET', '/flow.js')).status, 200);
  const r = (await request('GET', '/requests?limit=5')).json;
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].text, 'compile a list of sites');
  assert.equal(r.requests[0].sessionId, 'sess-xyz');
  assert.equal(r.requests[0].n, 1);
  assert.equal(r.voice, 'af_heart');
  assert.equal(r.provider, 'kokoro');
  assert.equal(r.requests[0].cwd, '/tmp/site');
  assert.equal(r.total, 1);
  // Like the rest of the server: not for another website's page or a rebinding name.
  assert.equal((await request('GET', '/requests', null, { Host: 'evil.example:39880' })).status, 421);
});

test('the pre-check hook can announce a prompt: it shows at once and the window is told to jump to it', async () => {
  const page = subscribe();
  await page.ready;
  try {
    const r = await request('POST', '/requests/preview', { text: 'compile a list of sites and their contact email address', sessionId: 'sess-p', cwd: '/tmp/site', mode: 'bypassPermissions', held: true, focus: true });
    assert.equal(r.status, 200);
    assert.ok(r.json.n >= 2);
    const ev = await waitFor(() => page.events.find((e) => e.type === 'request-focus'));
    assert.equal(ev.n, r.json.n);
    assert.equal(ev.held, true);
    const list = (await request('GET', '/requests?limit=5')).json.requests;
    assert.ok(list.some((x) => x.pending && x.held && x.n === r.json.n && x.sessionId === 'sess-p'));
    assert.equal((await request('POST', '/requests/preview', { text: '   ' })).status, 400);
    assert.equal((await request('POST', '/requests/preview', { text: 'x y z' }, { Origin: 'https://evil.example' })).status, 403);
  } finally {
    page.close();
  }
});

test('replay without AgentVibes answers 503, so the page uses the browser voice', async () => {
  assert.equal((await request('POST', '/synth', { text: 'hello there', voice: 'af_heart' })).status, 503);
});
