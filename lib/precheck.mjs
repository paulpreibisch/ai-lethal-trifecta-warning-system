// precheck.mjs — what the UserPromptSubmit hook decides about a prompt before Claude runs it.
// Pure rules (the same ones the "New Claude Request" tab uses) plus a small memory of prompts it
// has already held, so sending the same text a second time goes through.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir, ROOT, IS_WINDOWS } from './common.mjs';
import { classify, riskOf, updatedPrompt, groundRules, directions } from '../public/flow.js';

const slash = (p) => p.split(path.sep).join('/');

const ORDER = ['low', 'medium', 'high', 'critical'];
export const atLeast = (level, min) => ORDER.indexOf(level) >= ORDER.indexOf(min);

const LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical' };

// Only a person typing in an attended terminal session. Unattended runs (claude -p, the SDK, scheduled
// jobs) say so in their environment and are left alone: they would otherwise pop the window all day.
export function interactive(env = process.env) {
  return env.CLAUDE_CODE_ENTRYPOINT === 'cli' && env.CLAUDE_CODE_SESSION_ATTENDED !== '0';
}

export function assess(text, mode) {
  const f = classify(text);
  const risk = riskOf(f, mode);
  const up = updatedPrompt(text, f, mode);
  return { f, risk, label: LABEL[risk.level], where: up.where, prompt: up.prompt, changed: up.changed, rules: groundRules(text, f), steps: directions(text, f, mode).steps };
}

// A plain-text report on one request, for the /precheck slash command: risk, verdict, where to run it,
// numbered directions with full-path commands, and the rewritten prompt.
export function checkReport(text, mode = 'bypassPermissions') {
  const asked = String(text || '').trim();
  const a = assess(asked, mode);
  const unsafe = a.risk.level === 'critical' || a.risk.level === 'high';
  const snippet = asked.replace(/\s+/g, ' ');
  const lines = [
    `Pre-check of: "${snippet.length > 160 ? `${snippet.slice(0, 160)}...` : snippet}"`,
    `Risk: ${a.label.toUpperCase()} (${a.risk.reason})    Verdict today: ${unsafe ? 'NOT SAFE' : 'SAFE'}`,
    `Assuming permission prompts are ${mode === 'bypassPermissions' ? 'OFF (bypass mode), as in most of your sessions' : 'on'}.`,
    '',
    `Run it in: ${a.where}`,
  ];
  if (a.changed) {
    lines.push('', 'Do this instead:');
    a.steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.t}`);
      if (s.cmd) lines.push(`     ${s.cmd}`);
    });
    lines.push('', 'Updated prompt (copy this):', '-----', a.prompt, '-----');
  } else {
    lines.push('', 'This prompt needs no change.');
  }
  lines.push('', `Every request and its flows: node "${slash(path.join(ROOT, 'bin', 'claude-attention.mjs'))}" open`);
  return lines.join('\n');
}

// The command to start the suggested safer route, with shell guidance (Windows-only syntax, so
// only said on Windows) and a reminder that the route itself is your own setup, not part of this
// install, since a fresh clone has nothing at that path yet.
function startLine(a) {
  const first = a.steps.filter((s) => s.cmd).map((s) => s.cmd)[0];
  if (!first) return '';
  const shell = IS_WINDOWS ? ', in PowerShell (not Git Bash or zsh)' : '';
  return `Start it with${shell}: ${first}\n(If you haven't set up a sandbox box at that path yet, see the Initial Setup tab.)`;
}

// Shown to you when a prompt is held: what is wrong, what to do, and how to go ahead anyway.
export function holdMessage(a) {
  return [
    `Held before it runs: ${a.label}, ${a.risk.reason}.`,
    `Safer: ${a.where}.`,
    startLine(a),
    'The Claude Attention window is open on the New Claude Request tab with this prompt highlighted: it shows the flows, what could go wrong, and a rewritten prompt.',
    'To run it as typed anyway, send the same text again.',
  ].filter(Boolean).join('\n');
}

// True only for the one risk this pre-check engine rates critical: all three legs of the lethal
// trifecta (private data, untrusted text, the power to act) in the same session.
export const isTrifecta = (a) => a.risk.level === 'critical';

// Shown to you when /protect stops a trifecta request: what it found, the safer route, and how
// to go ahead anyway.
export function protectMessage(a) {
  return [
    `/protect stopped this before it ran: the lethal trifecta is in play (${a.risk.reason}).`,
    'Private data, text written by strangers, and the power to act are all present in this one request.',
    `Safer: ${a.where}.`,
    startLine(a),
    'The Claude Attention window is open on the New Claude Request tab with this prompt highlighted: it shows the flows, what could go wrong, and a rewritten prompt.',
    'To run it as typed anyway, send the same text again.',
  ].filter(Boolean).join('\n');
}

// Added to what Claude sees (not to the chat) for high-risk prompts.
export function rulesContext(a) {
  return [
    `A pre-check flagged this request as ${a.label} (${a.risk.reason}). While doing it, follow these ground rules:`,
    ...a.rules.map((r) => `- ${r}`),
  ].join('\n');
}

// --- Held prompts: a hash of session + text, remembered for ten minutes ---

const HELD_MS = 10 * 60 * 1000;
const heldFile = () => path.join(tmpDir(), 'held-prompts.json');

// `feature` keeps /protect and /precheck hold from sharing one held slot: without it, a hold
// recorded by one (e.g. precheck, while protect was off) would silently look "already satisfied"
// to the other the first time it actually sees the same (session, text) pair.
export function keyFor(sessionId, text, feature = 'precheck') {
  return crypto.createHash('sha256').update(`${feature}\n${sessionId}\n${text}`).digest('hex').slice(0, 32);
}

function readHeld() {
  try {
    const v = JSON.parse(fs.readFileSync(heldFile(), 'utf8'));
    const now = Date.now();
    return Object.fromEntries(Object.entries(v).filter(([, t]) => Number.isFinite(t) && now - t < HELD_MS));
  } catch { return {}; }
}

function writeHeld(map) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(heldFile(), JSON.stringify(map), { mode: 0o600 });
  } catch { /* the hold then simply does not repeat */ }
}

export const wasHeld = (key) => key in readHeld();
export function markHeld(key) { const m = readHeld(); m[key] = Date.now(); writeHeld(m); }
export function clearHeld(key) { const m = readHeld(); if (key in m) { delete m[key]; writeHeld(m); } }
