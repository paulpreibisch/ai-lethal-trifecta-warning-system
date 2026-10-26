// app.js — the cards window: one card per explained permission prompt
// and how it was answered. Cards arrive over /events; the play button
// re-voices a card through AgentVibes (/synth) in the voice that first spoke it,
// or the browser's own speech when no voice is known yet.
//
// Every card field is set with textContent: the explanation is model output and
// the summary is Claude's own description of a command, so neither is trusted HTML.

import { initRequests } from './requests.js';

const listEl = document.getElementById('cards');
const connEl = document.getElementById('conn');
const BASE_TITLE = document.title;

const cards = [];            // newest first, mirrors the server's list
let total = 0;               // how many the server holds (it loads the log on start)
let recent = [];             // 8 days of { createdAt, answer, risk } for the counts

// --- Counts for today and this week (Monday on), in this computer's time zone ---

const statsEl = document.getElementById('stats');
const WAIT_MS = 2 * 60 * 60 * 1000;   // the hook stops watching for an answer after this

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek() {
  const d = new Date(startOfToday());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function period(title, since) {
  const rows = recent.filter(r => r.createdAt >= since);
  const allowed = rows.filter(r => r.answer === 'allowed').length;
  const denied = rows.filter(r => r.answer === 'denied').length;
  const waiting = rows.filter(r => !r.answer && Date.now() - r.createdAt < WAIT_MS).length;
  const box = el('div', 'period');
  box.append(el('h3', null, title));
  const nums = el('div', 'nums');
  const num = (cls, n, label) => { const s = el('span', `num ${cls}`); s.append(el('b', null, String(n)), document.createTextNode(label)); return s; };
  nums.append(num('asked', rows.length, 'asked'), num('answered', allowed + denied, 'answered'),
    num('allowed', allowed, '✓ allowed'), num('denied', denied, '✗ denied'));
  if (waiting) nums.append(num('waiting', waiting, 'waiting'));
  box.append(nums);
  // How risky the period's prompts were, as one coloured bar.
  if (rows.length) {
    const bar = el('div', 'riskbar');
    for (const level of ['low', 'medium', 'high', 'critical']) {
      const n = rows.filter(r => r.risk === level).length;
      if (!n) continue;
      const seg = el('i', `risk-${level}`);
      seg.style.width = `${(100 * n) / rows.length}%`;
      seg.style.background = 'var(--risk)';
      seg.title = `${n} ${level} risk`;
      bar.append(seg);
    }
    box.append(bar);
  }
  return box;
}

function renderStats() {
  statsEl.replaceChildren(period('Today', startOfToday()), period('This week', startOfWeek()));
}

// Counts only, without re-rendering the cards (that would replay the newest one's entrance).
async function refreshStats() {
  try {
    const { recent: past } = await (await fetch('/attention?limit=1', { cache: 'no-store' })).json();
    if (Array.isArray(past)) { recent = past; renderStats(); }
  } catch { /* the 5 s check catches up */ }
}
let freshId = null;          // the card that just arrived, for its entrance animation
let player = null;           // { id, stop() } for whatever is playing now
let flashTimer = null;

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z"/></svg>';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

// The computer's own clock and time zone, e.g. "Thu, Oct 22, 2026, 1:45:07 PM PDT".
function stamp(ms) {
  return new Date(ms).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

const CALENDAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M7 3v3M17 3v3M4 9h16M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/></svg>';

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical' };

// Top right of a card: the risk, then the exact date and time, then the age.
function when(card) {
  const box = el('div', 'when');
  if (RISK_LABEL[card.risk]) {
    const badge = el('div', 'riskbadge', RISK_LABEL[card.risk]);
    if (card.riskReason) badge.append(el('span', 'why', `· ${card.riskReason}`));
    badge.title = card.riskReason ? `${RISK_LABEL[card.risk]}: ${card.riskReason}` : RISK_LABEL[card.risk];
    box.append(badge);
  }
  const top = el('div', 'stamp');
  top.innerHTML = CALENDAR_ICON;
  top.append(el('span', null, stamp(card.createdAt)));
  box.append(top, el('div', 'age', ago(card.createdAt)));
  return box;
}

function resumeCommand(card) {
  if (!card.sessionId) return '';
  return card.cwd ? `cd "${card.cwd}" && claude --resume ${card.sessionId}` : `claude --resume ${card.sessionId}`;
}

// A labelled, selectable line with a copy button; a dimmed placeholder without one
// when the hook did not send the value (cards from before a field existed).
function copyRow(label, value) {
  if (!value) {
    const row = el('div', 'copyrow missing');
    row.append(el('span', 'label', label), el('code', null, 'not recorded'));
    return row;
  }
  const row = el('div', 'copyrow');
  const code = el('code', null, value);
  const btn = el('button', 'copy', 'Copy');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.execCommand('copy');
    }
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500);
  });
  row.append(el('span', 'label', label), code, btn);
  return row;
}

// The hook watches the session for up to two hours; after that an unanswered
// card most likely ended with the session.
const WATCH_MS = 2 * 60 * 60 * 1000;

// ✓ Allowed / ✗ Denied with the exact time, or that the answer is still due.
function answerBadge(card) {
  if (card.answer === 'allowed' || card.answer === 'denied') {
    const ok = card.answer === 'allowed';
    const b = el('div', `answer ${card.answer}`);
    b.append(el('span', 'mark', ok ? '✓' : '✗'), el('span', 'what', ok ? 'Allowed' : 'Denied'),
      el('span', 'at', stamp(card.answeredAt || card.createdAt)));
    return b;
  }
  const late = Date.now() - card.createdAt > WATCH_MS;
  return el('div', late ? 'answer unknown' : 'answer waiting', late ? 'No answer recorded' : 'Waiting for your answer…');
}

function where(card) {
  const box = el('div', 'where');
  box.dataset.id = card.id;
  box.append(copyRow('Folder', card.cwd), copyRow('Session', card.sessionId));
  const cmd = resumeCommand(card);
  if (cmd) box.append(copyRow('Resume', cmd));
  for (const row of box.children) row.classList.add(`is-${row.firstChild.textContent.toLowerCase()}`);
  return box;
}

function playButton(card, small) {
  const b = el('button', small ? 'play small' : 'play');
  b.type = 'button';
  b.innerHTML = PLAY_ICON + '<span class="bars"><i></i><i></i><i></i><i></i></span>';
  b.setAttribute('aria-label', 'Play this message');
  b.dataset.id = card.id;
  if (player && player.id === card.id) b.classList.add('playing');
  b.addEventListener('click', () => toggle(card, b));
  return b;
}

function setPlaying(id, on) {
  for (const b of listEl.querySelectorAll('.play')) {
    if (b.dataset.id === id) { b.classList.toggle('playing', on); b.classList.remove('busy'); }
  }
}

function stopPlayer() {
  if (!player) return;
  const { id, stop } = player;
  player = null;
  try { stop(); } catch { /* already ended */ }
  setPlaying(id, false);
}

function speakInBrowser(card) {
  const u = new SpeechSynthesisUtterance(card.line);
  u.onend = u.onerror = () => { if (player && player.id === card.id) { player = null; setPlaying(card.id, false); } };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  player = { id: card.id, stop: () => speechSynthesis.cancel() };
  setPlaying(card.id, true);
}

// Pressing play swells the card's folder and session to twice their size, once,
// so it is obvious which session the message belongs to.
function popWhere(id) {
  for (const code of listEl.querySelectorAll(`.where[data-id="${CSS.escape(id)}"] :is(.is-folder, .is-session) code`)) {
    code.classList.remove('pop');
    void code.offsetWidth;   // restart the animation on a second press
    code.classList.add('pop');
    code.addEventListener('animationend', () => code.classList.remove('pop'), { once: true });
  }
}

async function toggle(card, button) {
  const wasMine = player && player.id === card.id;
  stopPlayer();
  if (wasMine) return;
  popWhere(card.id);
  if (!card.voice) { speakInBrowser(card); return; }
  button.classList.add('busy');
  try {
    const r = await fetch('/synth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: card.line, voice: card.voice, provider: card.provider }),
    });
    const { audioUrl } = r.ok ? await r.json() : {};
    if (!audioUrl) throw new Error('no audio');
    const audio = new Audio(audioUrl);
    audio.onended = audio.onerror = () => { if (player && player.id === card.id) { player = null; setPlaying(card.id, false); } };
    player = { id: card.id, stop: () => audio.pause() };
    setPlaying(card.id, true);
    await audio.play();
  } catch {
    button.classList.remove('busy');
    speakInBrowser(card);
  }
}

function heroCard(card) {
  const box = el('section', `${card.id === freshId ? 'hero fresh' : 'hero'}${card.risk ? ` risk-${card.risk}` : ''}`);
  const eyebrow = el('div', card.answer ? 'eyebrow done' : 'eyebrow');
  eyebrow.append(el('span', 'pulse'), el('span', null, card.answer ? 'Permission answered' : 'Permission needed'), when(card));
  const row = el('div', 'row');
  row.append(el('p', 'line', card.line), playButton(card, false));
  box.append(eyebrow, row, answerBadge(card));
  if (card.summary && card.summary !== card.line) {
    const note = el('div', 'note');
    note.append(el('span', null, "Claude's note: "), document.createTextNode(card.summary));
    box.append(note);
  }
  const meta = el('div', 'meta');
  if (card.project) meta.append(el('span', 'chip', card.project));
  if (card.tool) meta.append(el('span', 'chip', card.tool));
  if (meta.childElementCount) box.append(meta);
  box.append(where(card));
  return box;
}

function olderCard(card) {
  const item = el('div', card.risk ? `item risk-${card.risk}` : 'item');
  const head = el('div', 'itemhead');
  const text = el('div');
  text.className = 'itemtext';
  text.append(el('p', null, card.line), el('small', null, [card.project, card.tool].filter(Boolean).join(' · ')));
  head.append(playButton(card, true), text, when(card));
  item.append(head, answerBadge(card), where(card));
  return item;
}

function render() {
  listEl.replaceChildren();
  if (!cards.length) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'big', '🌙'), el('p', null, 'Nothing is waiting on you.'),
      el('p', null, 'When Claude stops to ask permission, the reason shows up here.'));
    listEl.append(empty);
    return;
  }
  listEl.append(heroCard(cards[0]));
  if (cards.length > 1) {
    listEl.append(el('h2', null, 'Earlier'));
    for (const c of cards.slice(1)) listEl.append(olderCard(c));
  }
  if (total > cards.length) {
    const more = el('button', 'more', `Show older (${total - cards.length} more)`);
    more.type = 'button';
    more.addEventListener('click', () => hydrate(500));
    listEl.append(more);
  }
}

function flashTitle() {
  if (document.hasFocus() || flashTimer) return;
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? '● Claude needs you' : BASE_TITLE;
  }, 1000);
}

window.addEventListener('focus', () => {
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = BASE_TITLE;
});

function setLive(live) {
  connEl.classList.toggle('live', live);
  connEl.querySelector('span').textContent = live ? 'live' : 'reconnecting…';
}

// The server reports a version of this page's own files; when it changes, the
// window reloads so it never keeps showing an old layout.
let uiVersion = null;
let wanted = 50;

async function hydrate(limit = wanted) {
  wanted = limit;
  try {
    const r = await fetch(`/attention?limit=${limit}`);
    const { cards: list, total: n, ui, recent: past } = await r.json();
    if (Array.isArray(past)) { recent = past; renderStats(); }
    if (uiVersion && ui && ui !== uiVersion) { location.reload(); return; }
    uiVersion = ui || uiVersion;
    cards.splice(0, cards.length, ...(Array.isArray(list) ? list : []));
    total = Number(n) || cards.length;
  } catch { /* server restarting: the feed reconnects and refills */ }
  render();
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { setLive(true); hydrate(); };
  es.onerror = () => setLive(false);
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'attention' && msg.card) {
      cards.unshift(msg.card);
      total++;
      freshId = msg.card.id;
      render();
      flashTitle();
      refreshStats();
    } else if (msg.type === 'request-focus') {
      // The pre-check hook announced a prompt: show it on the New Claude Request tab, highlighted.
      showTab('requests');
      requests.focus(msg.n);
      flashTitle();
    } else if (msg.type === 'attention-answer') {
      const c = cards.find(x => x.id === msg.id);
      if (c) { c.answer = msg.answer; c.answeredAt = msg.answeredAt; if (!player) render(); }
      refreshStats();
    }
  };
}

// Keep the "x min ago" lines honest without re-animating the newest card.
setInterval(() => { freshId = null; if (player) return; hydrate(); }, 30000);

// The window looks after itself, so it never needs a manual refresh: a new
// version of this page reloads it within a few seconds (unless something is
// playing), and a server restart is picked up when it answers again.
let serverDown = false;
setInterval(async () => {
  try {
    const r = await fetch('/attention?limit=1', { cache: 'no-store' });
    const { ui, recent: past } = await r.json();
    // Also rolls the counts over at midnight and on Monday.
    if (Array.isArray(past)) { recent = past; renderStats(); }
    if (uiVersion && ui && ui !== uiVersion && !player) { location.reload(); return; }
    if (serverDown) { serverDown = false; hydrate(); }
  } catch {
    serverDown = true;
  }
}, 5000);

// --- Tabs: permission cards, or the questions you type to Claude (see requests.js) ---

const requests = initRequests({ el, copyRow, stamp, ago, root: document.getElementById('requests') });
const TABS = {
  permissions: { tab: document.getElementById('tab-permissions'), panes: [statsEl, listEl] },
  requests: { tab: document.getElementById('tab-requests'), panes: [document.getElementById('requests')] },
  setup: { tab: document.getElementById('tab-setup'), panes: [document.getElementById('setup')] },
};

// Initial Setup tab: static content, just wire up its copy buttons once.
for (const block of document.querySelectorAll('#setup .setup-prompt')) {
  const pre = block.querySelector('pre');
  const btn = block.querySelector('button.copy');
  if (!pre || !btn) continue;
  btn.addEventListener('click', async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(pre.textContent);
    } catch {
      try {
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        ok = document.execCommand('copy');
      } catch { ok = false; }
    }
    btn.textContent = ok ? 'Copied' : 'Select it and press Ctrl+C';
    btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, ok ? 1500 : 3000);
  });
}

function showTab(name) {
  if (!TABS[name]) name = 'permissions';
  for (const [key, { tab, panes }] of Object.entries(TABS)) {
    const on = key === name;
    tab.setAttribute('aria-selected', String(on));
    for (const p of panes) p.hidden = !on;
  }
  requests.setActive(name === 'requests');
  try { history.replaceState(null, '', name === 'permissions' ? location.pathname : `#${name}`); } catch { /* not worth failing */ }
}
for (const [key, { tab }] of Object.entries(TABS)) tab.addEventListener('click', () => showTab(key));
showTab(location.hash.slice(1));

// A script error would leave a blank window; start over instead.
let reloading = false;
const recover = () => {
  if (reloading) return;
  reloading = true;
  setTimeout(() => location.reload(), 5000);
};
window.addEventListener('error', recover);
window.addEventListener('unhandledrejection', recover);

render();
connect();
