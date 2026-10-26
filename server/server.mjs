#!/usr/bin/env node
//
// claude-attention — the cards server: the cards window (GET /) and the routes the
// hooks post to. Loopback only. Started by the hooks when it isn't running; or by
// hand with `npm run serve`.
//
//   GET  /health              { app: 'claude-attention' } so the hooks know it's ours
//   GET  /events              SSE: { type: 'attention', card } / 'attention-answer'
//   GET  /attention?limit=N   newest cards, total, and a version of the page files
//   GET  /requests?limit=N    your newest questions to Claude Code (the "New Claude Request" tab)
//   POST /requests/preview    the pre-check hook: a prompt just typed (or held), { text, sessionId, cwd, mode, held, preview, focus }
//   POST /attention           a card from the permission hook -> { id, viewers }
//   POST /attention/answer    { id, answer: allowed|denied, answeredAt }
//   POST /synth               re-voice a card through AgentVibes, when it is running

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadConfig, logFile, dataDir, isMainModule } from '../lib/common.mjs';
import { createCards } from './cards.mjs';
import { createPrompts } from '../lib/prompts.mjs';

const MAX_BODY = 64 * 1024;
const PUBLIC = path.join(ROOT, 'public');
const JS = 'application/javascript; charset=utf-8';
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', JS],
  '/requests.js': ['requests.js', JS],
  '/flow.js': ['flow.js', JS],
};

// The page reloads itself when its own files change.
function uiVersion() {
  return Object.values(FILES)
    .map(([f]) => { try { return fs.statSync(path.join(PUBLIC, f)).mtimeMs; } catch { return 0; } })
    .join('-');
}

// Another website's page must not drive this server (CSRF), and a DNS name that
// points at 127.0.0.1 must not reach it either (rebinding).
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const u = new URL(o); return u.hostname === '127.0.0.1' || u.hostname === 'localhost'; } catch { return false; }
}

function hostOk(req, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || ''));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Asks a running AgentVibes viewport to voice the text; the page plays the URL.
async function synth(body) {
  const base = process.env.AGENTVIBES_URL || 'http://127.0.0.1:3747';
  const text = typeof body?.text === 'string' ? body.text.slice(0, 600) : '';
  if (!text || !body.voice) return null;
  try {
    const r = await fetch(`${base}/synth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: body.voice, provider: body.provider }),
      signal: AbortSignal.timeout(30000),
    });
    const { audioUrl } = r.ok ? await r.json() : {};
    return typeof audioUrl === 'string' && audioUrl.startsWith('/') ? `${base}${audioUrl}` : null;
  } catch { return null; }
}

export function createServer({ port, log = logFile(), projects } = {}) {
  const cards = createCards();
  cards.hydrate(log);
  const prompts = createPrompts({ ...(projects ? { root: projects } : {}), idsFile: path.join(dataDir(), 'request-ids.json') });
  const clients = new Map();

  function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients.values()) { try { res.write(data); } catch { /* gone */ } }
  }

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req, port)) { send(res, 421, { error: 'wrong host' }); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = url.pathname;

    if (req.method === 'GET' && FILES[route]) {
      const [file, type] = FILES[route];
      fs.readFile(path.join(PUBLIC, file), (err, buf) => {
        if (err) { send(res, 404, { error: 'missing' }); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }

    if (req.method === 'GET' && route === '/health') { send(res, 200, { app: 'claude-attention', cards: cards.size() }); return; }

    if (req.method === 'GET' && route === '/events') {
      const id = crypto.randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      clients.set(id, res);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25000);
      req.on('close', () => { clearInterval(beat); clients.delete(id); });
      return;
    }

    if (req.method === 'GET' && route === '/attention') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      // `recent` (8 days of { createdAt, answer, risk }) feeds the page's day and week
      // counts, which it works out in the viewer's own time zone.
      send(res, 200, { cards: cards.list(limit), total: cards.size(), recent: cards.recent(), ui: uiVersion() });
      return;
    }

    // The "New Claude Request" tab: the questions typed to Claude Code, newest first, read from
    // your own transcripts. Nothing is stored; secret-looking strings are masked.
    if (req.method === 'GET' && route === '/requests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
      prompts.refresh();
      // The voice the page uses when you press play (Kokoro through AgentVibes, set with `voice <name>`).
      const { voice, provider } = loadConfig('');
      send(res, 200, { requests: prompts.list(limit), total: prompts.size(), voice, provider });
      return;
    }

    if (req.method !== 'POST' || !['/attention', '/attention/answer', '/synth', '/requests/preview'].includes(route)) {
      send(res, 404, { error: 'not found' });
      return;
    }
    if (!originOk(req)) { send(res, 403, { error: 'origin' }); return; }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: 'bad json' }); return; }

    if (route === '/attention') {
      // Already known (loaded from the log first): nothing new to show.
      const known = body && cards.has(body.id);
      const card = known ? null : cards.add(body);
      if (!card && !known) { send(res, 400, { error: 'need line' }); return; }
      if (card) broadcast({ type: 'attention', card });
      send(res, 200, { id: card ? card.id : body.id, viewers: clients.size });
      return;
    }

    // The pre-check hook announces a prompt the moment it is typed, before Claude has written it down.
    // `focus` asks any open window to jump to its card.
    if (route === '/requests/preview') {
      const entry = body && typeof body === 'object' ? prompts.preview(body) : null;
      if (!entry) { send(res, 400, { error: 'need text' }); return; }
      if (body.focus) broadcast({ type: 'request-focus', n: entry.n, id: entry.id, held: entry.held });
      send(res, 200, { n: entry.n, viewers: clients.size });
      return;
    }

    if (route === '/attention/answer') {
      // A card posted while this server was down is only in the log.
      if (body && !cards.has(body.id)) cards.hydrate(log);
      const card = body ? cards.answer(body.id, body.answer, body.answeredAt) : null;
      if (!card) { send(res, 404, { error: 'unknown card or answer' }); return; }
      broadcast({ type: 'attention-answer', id: card.id, answer: card.answer, answeredAt: card.answeredAt });
      send(res, 200, { ok: true });
      return;
    }

    const audioUrl = await synth(body);
    if (audioUrl) send(res, 200, { audioUrl }); else send(res, 503, { error: 'no AgentVibes voice' });
  });

  return { server, cards, clients };
}

if (isMainModule(import.meta.url)) {
  const { port } = loadConfig('');
  const { server } = createServer({ port });
  server.on('error', (e) => {
    // Another copy already serves this port: nothing to do.
    if (e.code === 'EADDRINUSE') process.exit(0);
    throw e;
  });
  server.listen(port, '127.0.0.1');
}
