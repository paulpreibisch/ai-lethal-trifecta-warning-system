// requests.js — the "New Claude Request" tab: every question you type to Claude Code, newest
// first, one card each. A card starts collapsed and still shows the session, folder, risk,
// date and time, and the prompt as asked (with a copy button). Opening it shows how the request
// flows today, a safer flow, and a rewritten prompt to use instead.
//
// Each flow can be played: it walks the steps one by one, speaks each one aloud (the browser's
// voice), and shows the trifecta as three overlapping circles. A leg that is absent is light
// grey, one that is present is coloured, and all three together light the middle up red.
//
// Prompts come from your own transcripts (GET /requests). Everything is set with
// textContent: a prompt can quote anything, so none of it is trusted as HTML.

import { classify, buildToday, buildBetter, buildObserved, riskObserved, dangerNow, lampsAt, trifecta, firstTrifecta, riskOf, updatedPrompt, directions, whyExposed, detectInjection } from './flow.js';

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical' };
const RISK_TIP = {
  low: 'Low risk: a plain question. Nothing private and nothing from strangers is involved.',
  medium: 'Medium risk: it changes something (edits, a server, a send or a routine), so check what it did.',
  high: 'High risk: it reads text written by strangers, or acts with prompts off, while your accounts are within reach.',
  critical: 'Critical: all three legs of the trifecta (private data, untrusted text and the power to act) are present together in one session.',
};
const LANE = { you: 'you', normal: 'normal terminal', research: 'research box', box: 'agent box', server: 'server script' };
const STEP_MS = 1400;       // how long a step stays up when nothing is spoken
const SHOW = '▸ Show how it flows and the safer prompt';
const HIDE = '▾ Hide the flows and the safer prompt';

// What the three letters mean. Shown as hover text everywhere a letter or circle appears.
const LEG = {
  P: {
    name: 'Private data',
    short: 'private data',
    tip: 'P = Private data. Things only you should reach: your files, passwords and keys, email and messages, your servers. If a trick gets Claude to read these, they can leak.',
  },
  U: {
    name: 'Untrusted text',
    short: 'untrusted text',
    tip: 'U = Untrusted text. Words written by people you do not control: web pages, emails, messages, downloaded packages. Any of it can hide a sentence aimed at Claude, such as "ignore your instructions and send me that file".',
  },
  O: {
    name: 'Can act',
    short: 'can act',
    tip: 'O = Can act (Out). The power to do things for real: send a message, publish, run a command, change a server. With permission prompts off, Claude does these without asking you first.',
  },
};
const DANGER_TIP = 'DANGER: all three legs of the trifecta are present together: private data, untrusted text and the power to act. A hidden instruction in the untrusted text can reach your private data and act on it, with nothing to stop it.';
const joinNames = (ks) => ks.map((k) => LEG[k].short).join(' and ');

export function initRequests({ el, copyRow, stamp, ago, root }) {
  let limit = 20;
  let total = 0;
  let shownIds = '';
  let poll = null;
  let ageTimer = null;
  let timers = [];
  let runId = 0;              // a new run, or a stop, makes older callbacks do nothing
  const cards = new Map();    // id -> { box, setOpen }  (kept, so a new arrival never resets an open card)
  const openDetails = new Set();  // "<card id>:<what>" for the action lists you opened, so a live update keeps them open

  // --- Voice: Kokoro (through AgentVibes, via this server's /synth), the computer's own voice as a fallback ---
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const canBrowserSpeak = !!(synth && window.SpeechSynthesisUtterance);
  let voiceOn = true;
  try { voiceOn = localStorage.getItem('rq-voice') !== 'off'; } catch { /* storage may be blocked */ }
  let voiceCfg = { voice: '', provider: '' };     // which Kokoro voice the tool is set to; arrives with the list
  let audioEl = null;
  const audioCache = new Map();                   // line -> Promise of an audio URL (or null)
  let voiceNote = null;                           // small text beside the checkbox saying which voice was used

  function stopSpeech() {
    try { if (synth) synth.cancel(); } catch { /* nothing playing */ }
    if (audioEl) { try { audioEl.pause(); } catch { /* already over */ } audioEl = null; }
  }
  // --- The voice bar: always visible at the bottom of this tab ---
  let playing = false;        // a flow is being played
  let paused = false;
  let resumeHook = null;      // what to do on Resume when playback was between two steps
  let lastStart = null;       // starts the flow that was played last, for the Start button
  let dockStatus = '';

  const dock = el('div', 'rq-dock');
  dock.hidden = true;
  dock.setAttribute('role', 'region');
  dock.setAttribute('aria-label', 'Voice controls');
  const dockMain = el('button', 'rq-dockbtn go', '▶ Start');
  const dockStop = el('button', 'rq-dockbtn stop', '■ Stop');
  dockMain.type = dockStop.type = 'button';
  const dockText = el('span', 'rq-docktext', 'Voice is idle. Press play on a flow.');
  dock.append(dockMain, dockStop, dockText);
  document.body.append(dock);

  function updateDock() {
    if (playing) {
      dockMain.textContent = paused ? '▶ Resume' : '⏸ Pause';
      dockMain.disabled = false;
      dockStop.disabled = false;
      dock.classList.toggle('on', !paused);
      dockText.textContent = `${paused ? 'Paused. ' : 'Playing. '}${dockStatus}`;
    } else {
      dockMain.textContent = '▶ Start';
      dockMain.disabled = !lastStart;
      dockStop.disabled = true;
      dock.classList.remove('on');
      dockText.textContent = lastStart ? 'Idle. Start plays the last flow again.' : 'Voice is idle. Press play on a flow.';
    }
  }
  function pauseNow() {
    paused = true;
    if (audioEl) { try { audioEl.pause(); } catch { /* over */ } }
    try { if (synth) synth.pause(); } catch { /* nothing speaking */ }
    updateDock();
  }
  function resumeNow() {
    paused = false;
    const hook = resumeHook;
    resumeHook = null;
    if (hook) hook();
    else {
      if (audioEl) { audioEl.play().catch(() => {}); }
      try { if (synth) synth.resume(); } catch { /* nothing paused */ }
    }
    updateDock();
  }
  dockMain.addEventListener('click', () => {
    if (playing) { if (paused) resumeNow(); else pauseNow(); } else if (lastStart) lastStart();
  });
  dockStop.addEventListener('click', () => stopAnim());

  function stopAnim() {
    runId++; timers.forEach(clearTimeout); timers = []; stopSpeech();
    playing = false; paused = false; resumeHook = null; dockStatus = '';
    updateDock();
  }
  function noteVoice(text) { if (voiceNote) voiceNote.textContent = text; }

  // Asks the server to have Kokoro speak a line; resolves to an audio URL, or null when it can't.
  function synthUrl(text) {
    if (!voiceCfg.voice) return Promise.resolve(null);
    if (!audioCache.has(text)) {
      audioCache.set(text, fetch('/synth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceCfg.voice, provider: voiceCfg.provider }),
      }).then((r) => (r.ok ? r.json() : null)).then((j) => (j && typeof j.audioUrl === 'string' ? j.audioUrl : null)).catch(() => null));
    }
    return audioCache.get(text);
  }

  function browserSpeak(text, fin) {
    if (!canBrowserSpeak) { timers.push(setTimeout(fin, STEP_MS)); return; }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.03;
      u.onend = fin;
      u.onerror = fin;
      synth.speak(u);
      noteVoice('(computer voice: Kokoro is not running)');
    } catch { timers.push(setTimeout(fin, STEP_MS)); }
  }

  // Speaks one line, then calls done once (when it ends, fails, or a safety timer runs out). While it
  // plays, the next line's audio is fetched, so there is no wait between steps.
  function speak(text, done, nextText) {
    const me = runId;
    let finished = false;
    const fin = () => { if (!finished) { finished = true; done(); } };
    if (!voiceOn) { timers.push(setTimeout(fin, STEP_MS)); return; }
    if (nextText) synthUrl(nextText);
    synthUrl(text).then((url) => {
      if (me !== runId || finished) return;
      if (!url) { browserSpeak(text, fin); return; }
      try {
        const a = new Audio(url);
        audioEl = a;
        a.onended = fin;
        a.onerror = () => { if (audioEl === a) audioEl = null; if (me === runId && !finished) browserSpeak(text, fin); };
        a.play().then(() => noteVoice(`(Kokoro voice: ${voiceCfg.voice})`)).catch(() => { if (me === runId && !finished) browserSpeak(text, fin); });
      } catch { browserSpeak(text, fin); }
    });
    // Never hang on a silent voice, but never skip ahead while paused either.
    const guard = () => { if (paused) timers.push(setTimeout(guard, 2000)); else fin(); };
    timers.push(setTimeout(guard, Math.max(20000, text.split(/\s+/).length * 900)));
  }

  const intro = el('p', 'rq-intro',
    'Each question you type to Claude on this laptop appears here, collapsed. Open one to see how it would run today, a safer route, and a rewritten prompt you can copy. P, U and O are the three things that make a hidden instruction dangerous: hover over them to see what they mean.');
  const bar = el('div', 'rq-bar');
  const openAll = el('button', 'more', 'Open all');
  const closeAll = el('button', 'more', 'Collapse all');
  openAll.type = closeAll.type = 'button';
  openAll.addEventListener('click', () => cards.forEach((c) => c.setOpen(true)));
  closeAll.addEventListener('click', () => { stopAnim(); cards.forEach((c) => c.setOpen(false)); });
  const voiceLabel = el('label', 'rq-voice');
  const voiceBox = document.createElement('input');
  voiceBox.type = 'checkbox';
  voiceBox.checked = voiceOn;
  voiceBox.addEventListener('change', () => {
    voiceOn = voiceBox.checked;
    try { localStorage.setItem('rq-voice', voiceOn ? 'on' : 'off'); } catch { /* fine */ }
    if (!voiceOn) stopSpeech();
  });
  voiceNote = el('span', 'rq-voicenote', '');
  voiceLabel.append(voiceBox, document.createTextNode(' Speak each step when I press play '), voiceNote);
  bar.append(openAll, closeAll, voiceLabel);

  // Filter by risk level: any mix of the four, all shown to begin with, remembered between visits.
  const LEVELS = ['low', 'medium', 'high', 'critical'];
  let active = new Set(LEVELS);
  try {
    const saved = JSON.parse(localStorage.getItem('rq-levels') || 'null');
    if (Array.isArray(saved)) active = new Set(saved.filter((x) => LEVELS.includes(x)));
  } catch { /* default to all */ }
  const filters = el('div', 'rq-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter by risk level');
  filters.append(el('span', 'rq-filterlabel', 'Show:'));
  const chipBtns = {};
  const saveLevels = () => { try { localStorage.setItem('rq-levels', JSON.stringify([...active])); } catch { /* fine */ } };
  const allChip = el('button', 'rq-fchip all', 'All');
  allChip.type = 'button';
  allChip.addEventListener('click', () => { active = new Set(LEVELS); saveLevels(); applyFilter(); });
  filters.append(allChip);
  for (const lv of LEVELS) {
    const b = el('button', `rq-fchip risk-${lv}`, RISK_LABEL[lv]);
    b.type = 'button';
    b.title = RISK_TIP[lv];
    b.addEventListener('click', () => {
      if (active.has(lv)) active.delete(lv); else active.add(lv);
      saveLevels();
      applyFilter();
    });
    chipBtns[lv] = b;
    filters.append(b);
  }
  const noMatch = el('p', 'rq-nomatch', 'No requests match the risk levels you picked. Press All to see everything.');
  noMatch.hidden = true;

  function applyFilter() {
    const counts = { low: 0, medium: 0, high: 0, critical: 0 };
    let shown = 0;
    let total = 0;
    for (const c of cards.values()) {
      if (!list.contains(c.box)) continue;
      total++;
      counts[c.level]++;
      const on = active.has(c.level);
      c.box.hidden = !on;
      if (on) shown++;
    }
    for (const lv of LEVELS) {
      chipBtns[lv].textContent = `${RISK_LABEL[lv]} (${counts[lv]})`;
      chipBtns[lv].setAttribute('aria-pressed', String(active.has(lv)));
    }
    allChip.setAttribute('aria-pressed', String(active.size === LEVELS.length));
    noMatch.hidden = shown > 0 || total === 0;
  }
  const list = el('div', 'rq-list');
  const more = el('button', 'more', 'Show older');
  more.type = 'button';
  more.hidden = true;
  more.addEventListener('click', () => { limit += 20; load(); });
  root.append(intro, filters, bar, noMatch, list, more);

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500);
  }

  // A hazard-tape box for a detected prompt-injection attempt: jagged yellow-and-black edges,
  // a skull and crossbones, and the exact text that tripped it.
  function hazardBox(inj) {
    const frame = el('div', 'rq-hazard');
    const inner = el('div', 'rq-hazard-body');
    const head = el('div', 'rq-hazard-head');
    head.append(el('span', 'rq-hazard-skull', '☠'), document.createTextNode(' PROMPT INJECTION DETECTED '), el('span', 'rq-hazard-skull', '☠'));
    inner.append(head,
      el('p', 'rq-hazard-note', 'Text aimed at Claude, not at you, was found trying to steer it away from this request:'),
      el('pre', 'rq-hazard-text', inj.snippet));
    frame.append(inner);
    return frame;
  }

  // A labelled block of text that keeps its line breaks, with a copy button.
  function textBox(label, text, cls = '') {
    const box = el('div', `rq-box ${cls}`.trim());
    const head = el('div', 'rq-boxhead');
    const btn = el('button', 'copy', 'Copy');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
    btn.addEventListener('click', () => copyText(text, btn));
    head.append(el('span', 'label', label), btn);
    box.append(head, el('pre', 'rq-text', text));
    return box;
  }

  // --- The trifecta: three overlapping circles ---
  let vennId = 0;
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function tip(node, text) { node.append(svg('title', {}, text)); return node; }

  function trifectaGraphic() {
    const id = `rqv${++vennId}`;
    const box = el('div', 'rq-tri');
    const root = svg('svg', { viewBox: '0 0 220 172', class: 'rq-venn', role: 'img', 'aria-label': 'Private data, untrusted text and the power to act: which of the three legs are present' });
    const R = 50;
    const C = { P: [78, 66], U: [142, 66], O: [110, 120] };
    const defs = svg('defs');
    for (const [name, k] of [['p', 'P'], ['u', 'U']]) {
      const cp = svg('clipPath', { id: `${id}${name}` });
      cp.append(svg('circle', { cx: C[k][0], cy: C[k][1], r: R }));
      defs.append(cp);
    }
    root.append(defs);
    const circles = {};
    for (const k of ['P', 'U', 'O']) {
      circles[k] = tip(svg('circle', { cx: C[k][0], cy: C[k][1], r: R, class: `c ${k} off` }), LEG[k].tip);
      root.append(circles[k]);
    }
    // The middle, where all three overlap: only visible when all three are present.
    const outer = svg('g', { 'clip-path': `url(#${id}p)` });
    const inner = svg('g', { 'clip-path': `url(#${id}u)` });
    inner.append(tip(svg('circle', { cx: C.O[0], cy: C.O[1], r: R, class: 'core' }), DANGER_TIP));
    outer.append(inner);
    root.append(outer, svg('text', { x: 110, y: 94, 'text-anchor': 'middle', class: 'bang' }, '!'));
    // Just the letters inside the circles; the key beside them gives the names.
    const spots = { P: [54, 62], U: [166, 62], O: [110, 148] };
    const marks = [];
    for (const k of ['P', 'U', 'O']) {
      const [x, y] = spots[k];
      const letter = tip(svg('text', { x, y, 'text-anchor': 'middle', class: `ltr ${k} off` }, k), LEG[k].tip);
      marks.push([k, letter]);
      root.append(letter);
    }
    const side = el('div', 'rq-triside');
    const banner = el('div', 'rq-banner');
    // A key under the circles, so the letters never need guessing.
    const key = el('div', 'rq-key');
    for (const k of ['P', 'U', 'O']) {
      const item = el('span', 'rq-keyitem');
      item.title = LEG[k].tip;
      item.append(el('b', `rq-leg ${k}`, k), document.createTextNode(` ${LEG[k].name}`));
      key.append(item);
    }
    side.append(banner, key);
    // A face centred above the circles: happy while at least one leg is missing, angry when all three meet.
    const face = el('div', 'rq-face happy', '😊');
    face.title = 'At least one of the three is missing, so a hidden instruction cannot do harm here.';
    const pic = el('div', 'rq-trivis');
    pic.append(face, root);
    box.append(pic, side);
    return {
      box,
      banner,
      paint(state) {
        for (const k of ['P', 'U', 'O']) circles[k].setAttribute('class', `c ${k} ${state[k]}`);
        for (const [k, letter] of marks) letter.setAttribute('class', `ltr ${k} ${state[k]}`);
        const all = ['P', 'U', 'O'].every((k) => state[k] === 'on');
        root.classList.toggle('danger', all);
        face.textContent = all ? '😠' : '😊';
        face.className = `rq-face ${all ? 'angry' : 'happy'}`;
        face.title = all ? DANGER_TIP : 'At least one of the three is missing, so a hidden instruction cannot do harm here.';
      },
    };
  }

  // One plain sentence for what the circles show at this step.
  function describe(state) {
    const on = ['P', 'U', 'O'].filter((k) => state[k] === 'on');
    const rest = ['P', 'U', 'O'].filter((k) => state[k] !== 'on');
    if (on.length === 3) return 'DANGER: all three legs of the trifecta are present together: private data, untrusted text and the power to act. A hidden instruction in the untrusted text could use your private data and act on it.';
    if (!on.length) return 'None of the three is present here.';
    const have = joinNames(on);
    const miss = joinNames(rest);
    return `${have.charAt(0).toUpperCase()}${have.slice(1)} ${on.length > 1 ? 'are' : 'is'} present. ${miss.charAt(0).toUpperCase()}${miss.slice(1)} ${rest.length > 1 ? 'are' : 'is'} missing or held back, so there is no danger here.`;
  }

  function nodeTone(nodes, i, mode, better) {
    if (nodes[i].lane === 'you') return 'you';
    const l = lampsAt(nodes, i, mode, better);
    if (trifecta(l)) return 'danger';
    if (l.P === 'on' && (l.U === 'on' || l.O === 'on')) return 'watch';
    return 'ok';
  }

  // One flow as a column: the circles, a plain sentence, the steps, a caption and a play button.
  // Right beside the column title: a plain yes or no on whether this way of running it is safe.
  function verdictFor(risk, better) {
    if (better) return { safe: true, label: 'SAFE', tip: 'Safe: in this flow no room ever has private data, untrusted text and the power to act together.' };
    if (risk.level === 'critical' || risk.level === 'high') return { safe: false, label: 'NOT SAFE', tip: `Not safe: ${RISK_TIP[risk.level]}` };
    if (risk.level === 'medium') return { safe: true, label: 'SAFE', note: 'check what it changes', tip: `Safe, as long as you check what it does. ${RISK_TIP.medium}` };
    return { safe: true, label: 'SAFE', tip: RISK_TIP.low };
  }

  // A <details> that stays open across live updates of its card.
  function keptDetails(key, cls, summary) {
    const d = el('details', cls);
    d.open = openDetails.has(key);
    d.addEventListener('toggle', () => { if (d.open) openDetails.add(key); else openDetails.delete(key); });
    const s = el('summary');
    if (typeof summary === 'string') s.textContent = summary; else s.append(...summary);
    d.append(s);
    return d;
  }

  // One recorded action: its time, a globe when it went online, and what it was.
  function actLine(a) {
    const li = el('li', a.net ? 'rq-act net' : 'rq-act');
    li.title = a.net ? `${a.tool}: reached the internet` : a.tool;
    li.append(el('span', 'rq-acttime', new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })));
    if (a.net) li.append(el('span', 'rq-actnet', '🌐'));
    li.append(el('span', 'rq-acttool', a.tool), el('span', 'rq-actwhat', a.what));
    return li;
  }

  // Inside "You read the result": a folded record of every action, in order, and Claude's last reply.
  function resultPanel(live) {
    const acts = live.acts || [];
    const online = acts.filter((a) => a.net).length;
    const label = live.status === 'running' ? 'What it has done so far' : 'What was done, and the result';
    const sum = [el('span', 'rq-resicon', '📋'), document.createTextNode(` ${label} `),
      el('small', null, `${acts.length} action${acts.length === 1 ? '' : 's'}${online ? `, ${online} online` : ', none online'}`)];
    const d = keptDetails(`${live.id}:result`, 'rq-result', sum);
    if (acts.length) {
      const ol = el('ol', 'rq-actlist');
      for (const a of acts) ol.append(actLine(a));
      d.append(el('div', 'rq-reshead', 'Every action, in order'), ol);
    } else {
      d.append(el('p', 'rq-resnone', live.status === 'running' ? 'No actions yet.' : 'It used no tools.'));
    }
    if (live.reply) {
      d.append(el('div', 'rq-reshead', live.status === 'running' ? 'What Claude last said' : 'What Claude said at the end'), textBox('Reply', live.reply, 'reply'));
    }
    return d;
  }

  function flowColumn(title, nodes, mode, better, verdict, live = null) {
    const col = el('section', `rq-col ${better ? 'better' : 'today'}`);
    const head = el('div', 'rq-colhead');
    const play = el('button', 'rq-play', better ? '▶ Play the safer flow' : (live ? '▶ Replay what it did' : '▶ Animate this request'));
    play.type = 'button';
    const v = el('div', `rq-verdict ${verdict.safe ? 'safe' : 'unsafe'}`);
    v.title = verdict.tip;
    v.append(el('span', 'vmark', verdict.safe ? '✔' : '✖'), el('b', null, verdict.label));
    if (verdict.note) v.append(el('small', null, verdict.note));
    const h3 = el('h3', null, title);
    if (live && live.status === 'running') h3.append(el('span', 'rq-livechip', '● LIVE'));
    if (live && live.status === 'stopped') h3.append(el('span', 'rq-stopchip', 'STOPPED'));
    head.append(h3, v, play);
    const tri = trifectaGraphic();
    const banner = tri.banner;
    const flow = el('ol', 'rq-flow');
    const caption = el('div', 'rq-caption');
    col.append(head, tri.box, flow, caption);

    // While it runs, the step that is happening now is the one holding the latest action.
    let nowAt = -1;
    if (live && live.status === 'running') {
      let latest = -1;
      nodes.forEach((n, i) => { const t = n.acts && n.acts.length ? n.acts[n.acts.length - 1].at : -1; if (t >= latest && t >= 0) { latest = t; nowAt = i; } });
      if (nowAt < 0) nowAt = 1;    // nothing done yet: Claude is still reading the request
    }

    const items = nodes.map((n, i) => {
      const li = el('li', `rq-node ${nodeTone(nodes, i, mode, better)}`);
      if (i === nowAt) li.classList.add('live');
      if (n.pending) li.classList.add('pending');
      if (live && !n.pending && live.status !== 'running') li.classList.add('ran');
      const t = el('div', 'rq-title');
      t.append(el('span', 'rq-num', String(i + 1)), document.createTextNode(n.title));
      if (n.net) {
        const skull = el('span', 'rq-skull', '☠');
        skull.title = 'This step reached the internet. What came back was written by strangers and can carry hidden instructions.';
        t.append(skull);
      }
      for (const leg of n.legs) {
        const chip = el('span', `rq-leg ${leg}`, leg);
        chip.title = LEG[leg].tip;
        t.append(chip);
      }
      li.append(t);
      if (n.sub) li.append(el('div', 'rq-sub', n.sub));
      li.append(el('div', 'rq-lane', `where: ${LANE[n.lane] || n.lane}`));
      // In the step running now: the action itself, and why it is dangerous.
      if (i === nowAt) {
        const d = dangerNow(nodes, i, mode);
        const box = el('div', `rq-livewhy${d.danger ? ' bad' : ''}`);
        if (d.now) box.append(el('div', 'rq-livenow', `Running now: ${d.now}`));
        box.append(el('div', 'rq-livewhytext', `⚠ ${d.why}`));
        li.append(box);
      }
      // The actions behind a recorded step, folded away.
      if (live && n.acts && n.acts.length > 1) {
        const d = keptDetails(`${live.id}:${n.kind}`, 'rq-acts', `Show the ${n.acts.length} actions`);
        const ul = el('ul', 'rq-actlist');
        for (const a of n.acts) ul.append(actLine(a));
        d.append(ul);
        li.append(d);
      }
      // The last step: everything that was done, and what Claude said at the end.
      if (live && n.kind === 'read') li.append(resultPanel(live));
      flow.append(li);
      return li;
    });

    const hit = firstTrifecta(nodes, mode, better);

    // The worst moment of the flow: the first step with all three, or else the step with the most
    // legs present. The circles show it before and after playing, so a "not safe" card is never grey.
    function peak() {
      let best = { P: 'off', U: 'off', O: 'off' };
      let bestScore = -1;
      nodes.forEach((n, i) => {
        if (n.lane === 'you') return;
        const l = lampsAt(nodes, i, mode, better);
        const score = ['P', 'U', 'O'].filter((k) => l[k] === 'on').length * 2 + ['P', 'U', 'O'].filter((k) => l[k] === 'soft').length;
        if (trifecta(l) && bestScore < 100) { best = l; bestScore = 100; }
        else if (score > bestScore) { best = l; bestScore = score; }
      });
      return best;
    }
    const worst = peak();

    function rest() {
      items.forEach((li) => li.classList.remove('active', 'done'));
      tri.paint(worst);
      if (better) { banner.className = 'rq-banner good'; banner.textContent = `${describe(worst)} Press play to walk through it.`; }
      else if (hit >= 0) { banner.className = 'rq-banner bad'; banner.textContent = `DANGER at step ${hit + 1} (${nodes[hit].title}): all three legs of the trifecta are present together: private data, untrusted text and the power to act. Press play to watch it build up.`; }
      else { banner.className = 'rq-banner mid'; banner.textContent = `${describe(worst)} Press play to see it step by step.`; }
      caption.textContent = 'Press play to walk the request through the steps.';
    }
    rest();

    // What is said and shown for a step: pure, so the next one can be fetched while this one plays.
    function lineAt(i) {
      const n = nodes[i];
      const l = lampsAt(nodes, i, mode, better);
      const sentence = n.lane === 'you' ? 'You are the one acting here, outside the sealed rooms and the terminal.' : describe(l);
      return { l, sentence, spoken: `Step ${i + 1}. ${n.cap} ${n.lane === 'you' ? '' : sentence}`.trim() };
    }

    function showStep(i) {
      const n = nodes[i];
      const { l, sentence, spoken } = lineAt(i);
      items.forEach((li, j) => { li.classList.toggle('active', j === i); li.classList.toggle('done', j < i); });
      tri.paint(l);
      caption.textContent = `${i + 1}. ${n.cap}`;
      banner.textContent = sentence;
      banner.className = `rq-banner ${trifecta(l) ? 'bad' : (better ? 'good' : 'mid')}`;
      items[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return spoken;
    }

    function finish(mine) {
      items.forEach((li) => { li.classList.remove('active'); li.classList.add('done'); });
      tri.paint(worst);
      let line;
      if (better) { banner.className = 'rq-banner good'; line = 'Finished. In no room were all three legs of the trifecta present together.'; }
      else if (hit >= 0) { banner.className = 'rq-banner bad'; line = `Finished. DANGER: all three legs of the trifecta (private data, untrusted text and the power to act) were present together at step ${hit + 1}.`; }
      else { banner.className = 'rq-banner mid'; line = 'Finished. At no step were all three legs present together.'; }
      banner.textContent = line;
      dockStatus = 'Finished.';
      updateDock();
      speak(line, () => { if (mine === runId) { playing = false; paused = false; updateDock(); } });
    }

    // Plays this flow from its first step. The voice bar's Start button calls it again for the last one played.
    function startPlay() {
      stopAnim();
      rest();
      const mine = runId;                 // stopAnim() just moved it on; this run owns the new value
      playing = true; paused = false; lastStart = startPlay;
      dockStatus = title;
      updateDock();
      const at = (i) => {
        if (mine !== runId) return;
        if (paused) { resumeHook = () => at(i); return; }    // held between two steps: Resume carries on from here
        if (i >= nodes.length) { finish(mine); return; }
        dockStatus = `${title}, step ${i + 1} of ${nodes.length}`;
        updateDock();
        const line = showStep(i);
        speak(line, () => { if (mine === runId) timers.push(setTimeout(() => at(i + 1), 350)); }, i + 1 < nodes.length ? lineAt(i + 1).spoken : '');
      };
      timers.push(setTimeout(() => at(0), 150));
    }
    play.addEventListener('click', startPlay);
    return col;
  }

  // "Do this instead": numbered directions, each command with its own copy button.
  function directionsBox(dir, promptText, changed) {
    const box = el('div', 'rq-do');
    const head = el('div', 'rq-dohead');
    head.append(el('span', null, dir.title));
    // When the prompt needs no change, the step says so instead of promising an updated one.
    const stepText = (s) => (s.prompt && !changed ? 'Paste your prompt as it is (it needs no change) and let it run:' : s.t);
    // Copy every step at once, prompt included, for pasting into a note.
    const all = el('button', 'copy', 'Copy all steps');
    all.type = 'button';
    const indent = (t) => t.split('\n').map((x) => `   ${x}`).join('\n');
    all.addEventListener('click', () => copyText(dir.steps.map((s, i) => `${i + 1}. ${stepText(s)}${s.cmd ? `\n   ${s.cmd}` : ''}${s.prompt ? `\n\n${indent(promptText)}\n` : ''}`).join('\n'), all));
    head.append(all);
    box.append(head);
    const ol = el('ol', 'rq-dosteps');
    let n = 0;
    for (const s of dir.steps) {
      const li = el('li');
      li.append(el('span', 'rq-num do', String(++n)), el('span', 'rq-dotext', stepText(s)));
      if (s.prompt) {
        // The prompt itself, shown right at the step that needs it, with its copy button.
        const btn = el('button', 'copy big', changed ? 'Copy the updated prompt' : 'Copy the prompt');
        btn.type = 'button';
        btn.addEventListener('click', () => copyText(promptText, btn));
        const row = el('div', 'rq-cmd rq-promptcopy');
        row.append(btn);
        li.append(el('pre', 'rq-text rq-doprompt', promptText), row);
      }
      if (s.cmd) {
        const row = el('div', 'rq-cmd');
        const btn = el('button', 'copy', 'Copy');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copy this command');
        btn.addEventListener('click', () => copyText(s.cmd, btn));
        row.append(el('code', null, s.cmd), btn);
        li.append(row);
      }
      ol.append(li);
    }
    box.append(ol);
    return box;
  }

  // A small label-and-value chip for the card's header row; clicking Copy copies the full value.
  function refChip(label, shown, full, extra) {
    const chip = el('span', 'rq-ref');
    chip.title = full ? `${label}: ${full}` : `${label} not recorded`;
    chip.append(el('b', null, label), el('code', null, shown));
    if (full) {
      const btn = el('button', 'copy', 'Copy');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
      btn.addEventListener('click', () => copyText(full, btn));
      chip.append(btn);
      if (extra) chip.append(copyButton(extra.label, extra.value, extra.tip));
    }
    return chip;
  }

  // A small button that copies `value`; it says "Copied" for a moment, then goes back to its label.
  function copyButton(label, value, tip) {
    const btn = el('button', 'copy', label);
    btn.type = 'button';
    if (tip) btn.title = tip;
    btn.addEventListener('click', async () => {
      await copyText(value, btn);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
    return btn;
  }

  // The command that reopens a session in its own folder.
  const resumeCommand = (p) => (p.sessionId ? (p.cwd ? `cd "${p.cwd}" && claude --resume ${p.sessionId}` : `claude --resume ${p.sessionId}`) : '');

  // The part of a card that only shows when it is open: built the first time it opens.
  function buildBody(body, p, f, mode, observed) {
    // The full folder and session, for reading and copying (the header shows short forms).
    const where = el('div', 'where rq-pair');
    where.append(copyRow('Folder', p.cwd), copyRow('Session', p.sessionId));
    for (const row of where.children) row.classList.add(`is-${row.firstChild.textContent.toLowerCase()}`);
    // The resume command lives on the session's own row now, not on a row of its own.
    if (p.sessionId) where.children[1].append(copyButton('Copy resume command', resumeCommand(p), 'Copies a command that reopens this session in its own folder'));
    body.append(where);
    const tags = el('div', 'meta');
    tags.append(el('span', mode === 'bypassPermissions' ? 'chip bypass' : 'chip', mode === 'bypassPermissions' ? 'bypass permissions ON' : (mode ? `mode: ${mode}` : 'permission mode not recorded')));
    for (const k of Object.keys(f)) tags.append(el('span', 'chip', `detected: ${k}`));
    body.append(tags);

    // Two columns: today, and the safer flow with the rewritten prompt under it.
    const cols = el('div', 'rq-cols');
    const risk = riskOf(f, mode);
    if (observed) {
      // What really happened, live while it runs. The guess from the words stays as a note.
      const title = p.status === 'running' ? 'What it is doing now' : 'What it actually did';
      cols.append(flowColumn(title, observed.nodes, mode, false, verdictFor(observed.risk, false), p));
    } else {
      cols.append(flowColumn('How it flows today', buildToday(f, mode), mode, false, verdictFor(risk, false)));
    }
    const better = flowColumn('A safer flow', buildBetter(f, mode), mode, true, verdictFor(risk, true));
    const up = updatedPrompt(p.text, f, mode);
    better.querySelector('.rq-colhead').after(directionsBox(directions(p.text, f, mode), up.prompt, up.changed));
    better.append(el('div', 'rq-where', `Run it in: ${up.where}`));
    better.append(up.changed
      ? textBox('Updated prompt to use instead', up.prompt, 'updated')
      : el('div', 'rq-nochange', 'This prompt needs no change.'));
    cols.append(better);
    body.append(cols);

    const why = el('details', 'rq-why');
    why.append(el('summary', null, 'Why this exposes you'));
    const ul = el('ul');
    for (const line of whyExposed(f, mode)) ul.append(el('li', null, line));
    why.append(ul, el('p', 'rq-note', observed
      ? `The left column is read from the session's own record of every tool Claude called. From the words alone it would have been rated ${RISK_LABEL[risk.level].toLowerCase()}. The safer flow is still worked out from the words by simple rules.`
      : 'The flows are worked out from the words of the request by simple rules, not by a model, so they can miss things or over-warn. What Claude actually does can differ.'));
    body.append(why);
  }

  // A card is ONE ROW when closed: its number, risk, the start of the question, folder, session and time.
  // Clicking the row opens it to show everything: the full header, the question, both flows and the
  // rewritten prompt. What is inside is built the first time it opens.
  const SHORT_RISK = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' };
  // A card is rebuilt when this changes: its number, held or not, and (while it runs) each new action or reply.
  const cardKey = (p) => `${p.n}:${p.held ? 1 : 0}:${p.status || ''}:${(p.acts || []).length}:${(p.reply || '').length}`;

  function requestCard(p) {
    const f = classify(p.text);
    const mode = p.mode || '';
    // Once the session has recorded what Claude did, that sets the risk instead of the guess from the words.
    let observed = null;
    if (p.status && Array.isArray(p.acts)) {
      const nodes = buildObserved(p.acts, mode, p.status);
      observed = { nodes, risk: riskObserved(nodes, mode) };
    }
    const risk = observed ? observed.risk : riskOf(f, mode);
    const online = observed ? p.acts.filter((a) => a.net).length : 0;
    const actInj = Array.isArray(p.acts) ? p.acts.find((a) => a.inj) : null;
    const inj = detectInjection(p.text) || (p.reply ? detectInjection(p.reply) : null) || (actInj ? actInj.inj : null);
    const box = el('article', `rq risk-${risk.level}${p.held ? ' held' : ''}${p.status === 'running' ? ' running' : ''}`);
    const panel = el('div', 'rq-panel');
    panel.hidden = true;
    panel.id = `rq-panel-${String(p.id).replace(/[^A-Za-z0-9]/g, '')}`;

    // --- the one row ---
    const row = el('button', 'rq-row');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-controls', panel.id);
    const folderName = String(p.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'no folder';
    const snippet = String(p.text).replace(/\s+/g, ' ').trim();
    const idBadge = el('span', 'rq-id', `#${p.n || '?'}`);
    idBadge.title = `Card ${p.n || '?'}. Say "card ${p.n || '?'}" to refer to this request.`;
    const miniFlag = el('span', 'rq-miniflag');
    miniFlag.title = RISK_TIP[risk.level];
    miniFlag.append(el('span', 'flagmark', '⚑'), document.createTextNode(` ${SHORT_RISK[risk.level]}`));
    const snip = el('span', 'rq-snip', snippet);
    snip.title = snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet;
    const miniFolder = el('span', 'rq-mini rq-minifolder', folderName);
    miniFolder.title = p.cwd || 'folder not recorded';
    const miniSession = el('span', 'rq-mini rq-minisession', String(p.sessionId || '').slice(0, 8) || 'no session');
    miniSession.title = p.sessionId || 'session not recorded';
    const miniTime = el('span', 'rq-mini rq-minitime', new Date(p.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    miniTime.title = stamp(p.createdAt);
    row.append(idBadge, miniFlag);
    if (inj) {
      const ic = el('span', 'rq-injchip', '☠ INJECTION');
      ic.title = 'Text aimed at Claude was found trying to steer it away from this request. Open the card to see it.';
      row.append(ic);
    }
    if (p.held) row.append(el('span', 'rq-heldchip', p.preview ? 'PREVIEW' : 'HELD'));
    if (p.status === 'running') {
      const lc = el('span', 'rq-livechip', '● LIVE');
      lc.title = `Claude is working on this now: ${p.acts.length} action${p.acts.length === 1 ? '' : 's'} so far`;
      row.append(lc);
    }
    if (online) {
      const sk = el('span', 'rq-skull', '☠');
      sk.title = `Reached the internet ${online} time${online === 1 ? '' : 's'}`;
      row.append(sk);
    }
    row.append(snip, miniFolder, miniSession, miniTime, el('span', 'rq-chev', '▸'));

    // --- everything else, built when first opened ---
    let built = false;
    function fill() {
      if (p.held) {
        panel.append(el('div', 'rq-heldbanner', p.preview
          ? 'PREVIEW: this was a manual /precheck, never actually submitted or blocked. Nothing ran.'
          : 'HELD: this prompt has not run. Send the same text again in Claude to run it as typed, or use the safer route below.'));
      }
      const head = el('div', 'rq-head');
      const left = el('div', 'rq-headleft');
      const flag = el('div', 'rq-flag');
      flag.title = RISK_TIP[risk.level];
      flag.append(el('span', 'flagmark', '⚑'), el('b', null, RISK_LABEL[risk.level]));
      const flagRow = el('div', 'rq-flagrow');
      const reason = el('span', 'rq-reason', risk.reason);
      reason.title = RISK_TIP[risk.level];
      flagRow.append(flag, reason);
      left.append(flagRow,
        refChip('Folder', folderName, p.cwd),
        refChip('Session', String(p.sessionId || '').slice(0, 8) || 'not recorded', p.sessionId,
          { label: 'Copy resume command', value: resumeCommand(p), tip: 'Copies a command that reopens this session in its own folder' }));
      // Date, time and age on one line; the full stamp (with seconds and zone) is the hover text.
      const right = el('div', 'rq-when');
      const when = el('span', 'rq-stamp', new Date(p.createdAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
      when.title = stamp(p.createdAt);
      const age = el('span', 'age', ago(p.createdAt));
      age.dataset.ts = String(p.createdAt);
      right.append(when, document.createTextNode(' · '), age);
      head.append(left, right);
      panel.append(head);
      if (inj) panel.append(hazardBox(inj));
      panel.append(textBox('You asked', p.text + (p.cut ? '\n… (shortened)' : ''), 'asked'));
      const body = el('div', 'rq-body');
      buildBody(body, p, f, mode, observed);
      panel.append(body);
    }

    function setOpen(on) {
      if (on && !built) { fill(); built = true; }
      if (!on && !panel.hidden) stopAnim();
      panel.hidden = !on;
      box.classList.toggle('open', on);
      row.setAttribute('aria-expanded', String(on));
    }
    row.addEventListener('click', () => setOpen(panel.hidden));

    box.append(row, panel);
    cards.set(p.id, { box, setOpen, level: risk.level, n: p.n, key: cardKey(p), isOpen: () => !panel.hidden });
    return box;
  }

  // The card the pre-check hook just announced: open it, mark it, bring it into view.
  let wantFocus = null;      // { n, until }
  let currentN = null;       // the card number that is marked as "this one"
  let currentTimer = null;
  function markCurrent(n) {
    currentN = n;
    clearTimeout(currentTimer);
    currentTimer = setTimeout(() => { currentN = null; list.querySelectorAll('.rq-current').forEach((b) => b.classList.remove('rq-current')); }, 60000);
  }
  function tryFocus() {
    if (!wantFocus) return;
    if (Date.now() > wantFocus.until) { wantFocus = null; return; }
    const hit = [...cards.values()].find((c) => c.n === wantFocus.n && list.contains(c.box));
    if (!hit) return;
    if (!active.has(hit.level)) { active.add(hit.level); saveLevels(); applyFilter(); }
    hit.setOpen(true);
    markCurrent(wantFocus.n);
    list.querySelectorAll('.rq-current').forEach((b) => b.classList.remove('rq-current'));
    hit.box.classList.add('rq-current');
    hit.box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    wantFocus = null;
  }

  async function load() {
    let data;
    try { data = await (await fetch(`/requests?limit=${limit}`, { cache: 'no-store' })).json(); } catch { return; }
    const rows = Array.isArray(data.requests) ? data.requests : [];
    total = Number(data.total) || rows.length;
    if (typeof data.voice === 'string') voiceCfg = { voice: data.voice, provider: typeof data.provider === 'string' ? data.provider : '' };
    const ids = rows.map((r) => `${r.id}:${cardKey(r)}`).join(',');
    more.hidden = total <= rows.length;
    if (ids === shownIds) { tryFocus(); return; }
    shownIds = ids;
    if (!rows.length) {
      const empty = el('div', 'empty');
      empty.append(el('div', 'big', '✨'), el('p', null, 'No questions in the last few days.'), el('p', null, 'Type one to Claude and it will show up here.'));
      list.replaceChildren(empty);
      return;
    }
    // Cards already built are reused as they are, so a new question never closes or resets one you opened.
    // A card that changed (it got its number, or a held prompt ran) is rebuilt, still open if it was.
    const byN = new Map([...cards.values()].map((c) => [c.n, c]));
    const els = rows.map((r) => {
      const key = cardKey(r);
      const known = cards.get(r.id);
      if (known && known.key === key) return known.box;
      const prior = known || byN.get(r.n);
      const wasOpen = prior ? prior.isOpen() : false;
      const box = requestCard(r);
      if (wasOpen) cards.get(r.id).setOpen(true);
      if (currentN !== null && currentN === r.n) box.classList.add('rq-current');
      return box;
    });
    // Only cards that changed are touched. Putting every card back each time would drop a click
    // that lands mid-swap, and while a request is live this runs every few seconds.
    els.forEach((e, i) => { const at = list.children[i]; if (at !== e) list.insertBefore(e, at || null); });
    while (list.children.length > els.length) list.lastElementChild.remove();
    applyFilter();
    tryFocus();
  }

  function refreshAges() {
    for (const a of list.querySelectorAll('.age[data-ts]')) a.textContent = ago(Number(a.dataset.ts));
  }

  return {
    setActive(on) {
      clearInterval(poll); clearInterval(ageTimer);
      poll = ageTimer = null;
      dock.hidden = !on;
      if (!on) { stopAnim(); return; }
      load();
      poll = setInterval(load, 3000);
      ageTimer = setInterval(refreshAges, 15000);
    },
    // Called when the pre-check hook announces a prompt: find its card as soon as it exists.
    focus(n) {
      wantFocus = { n, until: Date.now() + 20000 };
      load();
      setTimeout(load, 900);
      setTimeout(load, 2200);
    },
  };
}
