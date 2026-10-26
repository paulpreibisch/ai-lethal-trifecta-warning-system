// prompts.mjs — the questions you typed to Claude Code, for the "New Claude Request" tab.
//
// Read-only: it follows your own transcripts under ~/.claude/projects (the only place the
// tool reads from) and keeps the last few days in memory. Nothing is written or logged.
// Secret-looking strings are masked and long prompts are cut before they reach the page.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { home } from './common.mjs';
import { classifyTool, MAX_ACTS, MAX_REPLY } from './activity.mjs';
import { detectInjection } from '../public/flow.js';

// Cheap, deliberately looser pre-screen than detectInjection's own rules, run against the RAW
// (still JSON-escaped) transcript line before it's worth a full parse. A tool result is normally
// a file or a web page and can be huge; this keeps those from ever being parsed just to be
// ignored, while still catching every phrasing the real rules look for.
const INJECTION_HINT = /ignore|disregard|forget|instructions?|rules?|DAN|jailbroken|unrestricted|system prompt|exfiltrate|credentials?|secrets?|api[ _-]?key/i;

// Pulls plain text out of a tool_result's `content`, which is either a bare string or a list of
// content blocks (the shape Claude Code's transcript uses for most tools).
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ');
  return '';
}

const TAIL_BYTES = 8 * 1024 * 1024;  // how far back into a big transcript the first look goes
const MAX_CHUNK = 16 * 1024 * 1024;  // most that one pass reads from one file
const MAX_KEEP = 600;
export const MAX_TEXT = 1500;

const MASKS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(password|passphrase|secret|token|api[ _-]?key)\s*[:=]\s*\S+/gi,
  /[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

export function mask(s) {
  let out = String(s);
  for (const re of MASKS) out = out.replace(re, (m, g1) => (g1 ? `${g1}: [hidden]` : '[hidden]'));
  return out;
}

export function createPrompts({ root = path.join(home(), '.claude', 'projects'), maxAgeMs = 3 * 24 * 3600 * 1000, idsFile } = {}) {
  const items = [];
  const seen = new Set();
  const files = new Map();

  // Card numbers, so a request can be referred to as "card 12". Kept in a small file of
  // id -> number (no prompt text) so the numbers survive a restart. Oldest gets the lowest.
  const numbers = new Map();
  let next = 1;
  if (idsFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
      for (const [k, v] of Object.entries(saved.ids || {})) if (Number.isInteger(v)) numbers.set(k, v);
      next = Number.isInteger(saved.next) && saved.next > 0 ? saved.next : Math.max(0, ...numbers.values()) + 1;
    } catch { /* first run, or an unreadable file: start numbering fresh */ }
  }
  function saveNumbers() {
    if (!idsFile) return;
    try {
      fs.mkdirSync(path.dirname(idsFile), { recursive: true });
      const tmp = `${idsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ next, ids: Object.fromEntries(numbers) }), { mode: 0o600 });
      fs.renameSync(tmp, idsFile);
    } catch { /* the numbers still work for this run */ }
  }
  // Prompts the pre-check hook reported before Claude wrote them to the transcript (or that it held and
  // never will). They show at once, with a number; when the real record arrives it takes that number.
  const pending = [];
  const PENDING_MS = 10 * 60 * 1000;
  const sameAsk = (a, b) => a.sessionId === b.sessionId && a.text === b.text;
  function dropOldPending() {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) if (now - pending[i].createdAt > PENDING_MS) pending.splice(i, 1);
  }

  function numberNew() {
    const fresh = items.filter((p) => !numbers.has(p.id)).sort((a, b) => a.createdAt - b.createdAt);
    if (!fresh.length) return;
    for (const p of fresh) {
      const at = pending.findIndex((x) => sameAsk(x, p));
      if (at >= 0) { numbers.set(p.id, pending[at].n); pending.splice(at, 1); } else numbers.set(p.id, next++);
    }
    saveNumbers();
  }

  // Called by the server when the hook posts a prompt. The same text again (a held prompt sent a second
  // time) updates the earlier entry and keeps its number.
  function preview({ sessionId = '', cwd = '', mode = '', text = '', held = false, preview: isPreview = false } = {}) {
    let c = String(text).trim();
    if (!c) return null;
    const cut = c.length > MAX_TEXT;
    const entry = { sessionId: String(sessionId), cwd: String(cwd), mode: String(mode), text: mask(cut ? c.slice(0, MAX_TEXT) : c), cut };
    dropOldPending();
    // The transcript may already have it (the scan can win the race against the hook): no second card.
    const known = items.find((x) => sameAsk(x, entry) && Date.now() - x.createdAt < 2 * 60 * 1000);
    if (known) return { ...known, n: numbers.get(known.id) || 0 };
    const prior = pending.find((x) => sameAsk(x, entry));
    if (prior) { prior.createdAt = Date.now(); prior.held = !!held; prior.preview = !!isPreview; return { ...prior }; }
    const made = {
      id: `pending-${crypto.randomBytes(5).toString('hex')}`, n: next++, createdAt: Date.now(), held: !!held, preview: !!isPreview, pending: true, ...entry,
    };
    pending.push(made);
    saveNumbers();
    return { ...made };
  }

  // What Claude did after a request: its tool calls, its last words, and whether the turn is over.
  function onAssistant(o, cur) {
    const blocks = Array.isArray(o.message && o.message.content) ? o.message.content : [];
    const at = Date.parse(o.timestamp) || Date.now();
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_use') {
        cur.status = 'running';
        cur.afterTool = true;
        const a = classifyTool(b.name, b.input, mask);
        if (a && cur.acts.length < MAX_ACTS) cur.acts.push({ ...a, at, toolUseId: b.id });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        // The reply is the text after the last tool call.
        if (cur.afterTool) { cur.reply = ''; cur.afterTool = false; }
        cur.reply = mask(`${cur.reply ? `${cur.reply}\n\n` : ''}${b.text.trim()}`).slice(0, MAX_REPLY);
      }
    }
    cur.lastAt = at;
    if (o.message && o.message.stop_reason === 'end_turn') { cur.status = 'done'; cur.endedAt = at; }
  }

  function take(line, ctx) {
    // Most lines are tool output, often huge. Only parse the kinds that matter.
    const typed = line.includes('"kind":"human"') || (line.includes('"type":"user"') && !line.includes('"tool_result"'));
    const said = line.includes('"type":"assistant"') && !line.includes('"type":"api-request');
    const ended = line.includes('"subtype":"turn_duration"');
    const resultHint = line.includes('"tool_result"') && INJECTION_HINT.test(line);
    if (!typed && !said && !ended && !resultHint && !line.includes('"type":"permission-mode"')) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.type === 'permission-mode' && o.permissionMode) { ctx.state.mode = o.permissionMode; return; }
    const cur = ctx.state.current;
    if (o.type === 'assistant') { if (cur && !o.isSidechain) onAssistant(o, cur); return; }
    if (o.type === 'system') {
      if (cur && o.subtype === 'turn_duration') { cur.status = 'done'; cur.endedAt = Date.parse(o.timestamp) || Date.now(); }
      return;
    }
    const said0 = o.type === 'user' && o.message ? [].concat(o.message.content || []).map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join(' ') : '';
    if (cur && !o.isSidechain && said0.startsWith('[Request interrupted')) {
      cur.status = 'stopped'; cur.endedAt = Date.parse(o.timestamp) || Date.now();
      return;
    }
    if (o.type !== 'user' || o.isSidechain || o.isMeta) return;
    if (o.origin && o.origin.kind && o.origin.kind !== 'human') return;
    let c = o.message && o.message.content;
    if (Array.isArray(c)) {
      const results = c.filter((x) => x && x.type === 'tool_result');
      if (results.length) {
        // Flag the act itself, not just what you typed or Claude's own reply, so text an injection
        // was hiding in a fetched page or a read file still gets caught even if Claude never echoes it.
        if (cur) {
          for (const r of results) {
            const inj = detectInjection(resultText(r.content));
            if (!inj) continue;
            const act = cur.acts.find((a) => a.toolUseId === r.tool_use_id);
            if (act) act.inj = inj;
          }
        }
        return;
      }
      c = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
    }
    if (typeof c !== 'string') return;
    c = c.trim();
    if (!c || c.startsWith('<') || c.startsWith('[Request interrupted') || c.startsWith('This session is being continued') || c.startsWith('Caveat:')) return;
    const id = o.uuid || `${ctx.file}:${o.timestamp}`;
    if (seen.has(id)) return;
    seen.add(id);
    const ts = Date.parse(o.timestamp) || Date.now();
    // A new request ends the one before it, even when no end was written (a crash, a closed window).
    if (cur && cur.status === 'running') cur.status = 'done';
    const item = {
      id,
      createdAt: ts,
      sessionId: String(o.sessionId || ''),
      cwd: String(o.cwd || ''),
      mode: String(o.permissionMode || ctx.state.mode || ''),
      text: mask(c.length > MAX_TEXT ? c.slice(0, MAX_TEXT) : c),
      cut: c.length > MAX_TEXT,
      status: 'running', acts: [], reply: '', lastAt: ts, endedAt: 0, afterTool: false,
    };
    items.push(item);
    ctx.state.current = item;
  }

  // A turn with no end and nothing new for a while has died (the window closed): stop showing it live.
  const STALE_MS = 20 * 60 * 1000;
  function shown(p) {
    const { afterTool, ...rest } = p;
    if (rest.status === 'running' && Date.now() - rest.lastAt > STALE_MS) rest.status = 'done';
    return rest;
  }

  function refresh() {
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
    const now = Date.now();
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      let names;
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of names) {
        const file = path.join(dir, f);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs > maxAgeMs) continue;
        let state = files.get(file);
        if (!state) { state = { pos: Math.max(0, st.size - TAIL_BYTES), mode: '', first: true, carry: '' }; files.set(file, state); }
        if (st.size < state.pos) { state.pos = 0; state.first = false; state.carry = ''; }
        if (st.size === state.pos) continue;
        const len = Math.min(st.size - state.pos, MAX_CHUNK);
        let buf;
        try {
          const fd = fs.openSync(file, 'r');
          try { buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, state.pos); } finally { fs.closeSync(fd); }
        } catch { continue; }
        const start = state.pos;
        state.pos += len;
        const lines = (state.carry + buf.toString('utf8')).split('\n');
        state.carry = lines.pop();
        if (state.first && start > 0) lines.shift();   // a first look can land mid-line
        state.first = false;
        const ctx = { state, file };
        for (const line of lines) if (line) take(line, ctx);
      }
    }
    numberNew();
    items.sort((a, b) => b.createdAt - a.createdAt);
    if (items.length > MAX_KEEP) items.length = MAX_KEEP;
  }

  return {
    refresh,
    preview,
    list: (limit = 30) => {
      dropOldPending();
      const real = items.map((p) => ({ ...shown(p), n: numbers.get(p.id) || 0 }));
      return [...pending.map((p) => ({ ...p })), ...real].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    size: () => items.length + pending.length,
  };
}
