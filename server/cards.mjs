// cards.mjs — the cards behind the window: one per explained permission prompt,
// plus how it was answered.
//
// The hooks append every card and answer to ~/.claude-attention/attention-log.jsonl;
// the server loads its cards from it on start (hydrate) and never writes it, so
// nothing is lost when the server is down or restarts. The full command never
// reaches either place, only the sanitised explanation and Claude's one-line
// description.

import crypto from 'node:crypto';
import fs from 'node:fs';

export const MAX_CARDS = 500;
const LIMITS = { line: 600, summary: 300, tool: 80, project: 120, cwd: 1024 };
const ID_RE = /^[0-9a-f]{12}$/;
const ANSWERS = new Set(['allowed', 'denied']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const DAY_MS = 24 * 60 * 60 * 1000;

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function time(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createCards({ now = Date.now, max = MAX_CARDS } = {}) {
  const cards = [];   // newest first
  const history = new Map();   // id -> { createdAt, answer, risk }, never trimmed

  // Returns the stored card, or null when there is nothing to show (or the id is
  // already known: the same card can arrive by POST and from the log).
  function add(body, { createdAt } = {}) {
    if (!body || typeof body !== 'object') return null;
    const line = str(body.line, LIMITS.line);
    if (!line) return null;
    const id = ID_RE.test(body.id || '') ? body.id : crypto.randomBytes(6).toString('hex');
    if (history.has(id)) return null;
    const card = {
      id,
      line,
      summary: str(body.summary, LIMITS.summary),
      tool: str(body.tool, LIMITS.tool),
      project: str(body.project, LIMITS.project).replace(/[^A-Za-z0-9 ._-]/g, ''),
      // Shown as copyable text: `cd "<cwd>" && claude --resume <sessionId>`.
      cwd: str(body.cwd, LIMITS.cwd).replace(/"/g, ''),
      sessionId: /^[A-Za-z0-9-]{8,64}$/.test(body.sessionId || '') ? body.sessionId : '',
      risk: RISKS.has(body.risk) ? body.risk : '',
      riskReason: str(body.riskReason, 120),
      createdAt: time(createdAt, now()),
      // The AgentVibes voice that spoke it, so the play button can use it again.
      voice: /^[A-Za-z0-9_.-]{1,80}$/.test(body.voice || '') ? body.voice : '',
      provider: /^[A-Za-z0-9_.-]{1,40}$/.test(body.provider || '') ? body.provider : '',
      answer: '',
      answeredAt: 0,
    };
    history.set(id, { createdAt: card.createdAt, answer: '', risk: card.risk });
    // Cards from the log arrive oldest first; keep the list ordered by time.
    const at = cards.findIndex(c => c.createdAt <= card.createdAt);
    if (at < 0) cards.push(card); else cards.splice(at, 0, card);
    cards.length = Math.min(cards.length, max);
    return card;
  }

  // Records how the prompt was answered; null for an unknown card or answer.
  function answer(id, value, answeredAt) {
    if (!ANSWERS.has(value)) return null;
    const past = history.get(id);
    if (past) past.answer = value;
    const card = cards.find(c => c.id === id);
    if (!card) return null;
    card.answer = value;
    card.answeredAt = time(answeredAt, now());
    return card;
  }

  // Every card ever loaded, small, for the day and week counts (the card list
  // itself keeps only the newest `max`).
  function recent(days = 8) {
    const since = now() - days * DAY_MS;
    return [...history.values()].filter(h => h.createdAt >= since).map(h => ({ ...h }));
  }

  const has = id => history.has(id) || cards.some(c => c.id === id);
  const list = (limit = max) => cards.slice(0, Math.max(0, limit)).map(c => ({ ...c }));
  const size = () => cards.length;

  // Replays the log. Bad lines are skipped: many hook processes append to it and a
  // half-written last line must not lose the rest.
  function hydrate(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    let n = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev?.type === 'card' && ev.card && add(ev.card, { createdAt: ev.card.createdAt })) n++;
      else if (ev?.type === 'answer') answer(ev.id, ev.answer, ev.answeredAt);
    }
    return n;
  }

  return { add, answer, has, list, size, hydrate, recent };
}
