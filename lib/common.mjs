// common.mjs — paths, settings, switches and the permanent log, shared by the
// hooks, the server and the CLI.
//
// Everything lives in ~/.claude-attention (CLAUDE_ATTENTION_HOME overrides it):
//   config.json          settings (see DEFAULTS)
//   attention-log.jsonl  every card and every answer, one JSON object per line
//   tmp/                 hook payloads handed to the detached speak stage (0600)
//   last-question        stamp so one prompt is never announced twice

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IS_WINDOWS = process.platform === 'win32';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = Object.freeze({
  enabled: true,       // speak prompts at all
  window: true,        // open the cards window when none is open
  explain: true,       // ask Haiku for a plain-words explanation
  voice: 'af_heart',   // AgentVibes voice for the explainer (when AgentVibes is installed)
  provider: 'kokoro',  // AgentVibes provider for that voice
  port: 3790,          // the cards server
  precheck: 'off',      // before a prompt runs: 'off', 'show' (open the page, highlight it) or 'hold' (also hold high-risk ones once)
  precheckLevel: 'medium', // the lowest risk that pops the page up: low, medium, high or critical
  precheckRules: true,  // add the ground rules to what Claude sees for high-risk prompts
  precheckFocus: true,  // bring the cards window to the front
  protect: false,       // stop a prompt the instant it mixes private data, untrusted text and the
                         // power to act (the lethal trifecta), whatever precheck is set to
});

export function home() {
  return os.homedir();
}

export function dataDir() {
  return process.env.CLAUDE_ATTENTION_HOME || path.join(home(), '.claude-attention');
}

export const tmpDir = () => path.join(dataDir(), 'tmp');
export const logFile = () => path.join(dataDir(), 'attention-log.jsonl');
export const configFile = () => path.join(dataDir(), 'config.json');

export function readTrim(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

export function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

// Global settings, then a project's own .claude/claude-attention.json on top.
// Unknown keys and wrong types are ignored, so a hand-edited file can't break a hook.
export function loadConfig(projectDir) {
  const cfg = { ...DEFAULTS };
  for (const raw of [readJson(configFile()), projectDir && readJson(path.join(projectDir, '.claude', 'claude-attention.json'))]) {
    if (!raw || typeof raw !== 'object') continue;
    for (const key of ['enabled', 'window', 'explain']) if (typeof raw[key] === 'boolean') cfg[key] = raw[key];
    for (const key of ['voice', 'provider']) if (typeof raw[key] === 'string' && (raw[key] === '' || SAFE_NAME.test(raw[key]))) cfg[key] = raw[key];
    if (Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535) cfg.port = raw.port;
    if (['off', 'show', 'hold'].includes(raw.precheck)) cfg.precheck = raw.precheck;
    if (['low', 'medium', 'high', 'critical'].includes(raw.precheckLevel)) cfg.precheckLevel = raw.precheckLevel;
    for (const key of ['precheckRules', 'precheckFocus', 'protect']) if (typeof raw[key] === 'boolean') cfg[key] = raw[key];
  }
  if (/^\d{4,5}$/.test(process.env.CLAUDE_ATTENTION_PORT || '')) cfg.port = Number(process.env.CLAUDE_ATTENTION_PORT);
  return cfg;
}

// Writes only the given keys into the global config, keeping everything else.
export function saveConfig(changes) {
  const current = readJson(configFile()) || {};
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify({ ...current, ...changes }, null, 2)}\n`);
}

// AgentVibes' mute (when AgentVibes is installed) silences prompts too:
// tts-muted.txt, then project unmute > project mute > global mute.
export function isMuted(projectDir) {
  const claudeDir = projectDir && exists(path.join(projectDir, '.claude'))
    ? path.join(projectDir, '.claude') : path.join(home(), '.claude');
  if (readTrim(path.join(claudeDir, 'tts-muted.txt')) === 'true') return true;
  if (projectDir && exists(path.join(projectDir, '.claude', 'agentvibes-unmuted'))) return false;
  if (projectDir && exists(path.join(projectDir, '.claude', 'agentvibes-muted'))) return true;
  return exists(path.join(home(), '.agentvibes-muted'));
}

// Tests (and CI) keep the speakers quiet.
export function isSilent() {
  return process.env.CLAUDE_ATTENTION_SILENT === '1' || exists(path.join(home(), '.agentvibes-tests-running'));
}

export function clean(s) {
  return String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#"\\]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([?.!,:;])/g, '$1');
}

export function cap(line, max) {
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[ ,;:]+$/, '');
}

// One card or answer per line. The hooks are the only writers; the server reads it.
// No command text ever goes in, only what a card shows.
export function appendLog(event) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(logFile(), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch { /* the card and the voice still work without the record */ }
}

const STAMP = () => path.join(dataDir(), 'last-question');

export function writeStamp() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(STAMP(), String(Date.now()));
  } catch { /* dedup is best effort */ }
}

export function stampAge() {
  const t = Number(readTrim(STAMP()));
  return Number.isFinite(t) && t > 0 ? Date.now() - t : Infinity;
}

// Resolves true when the command exits 0; never throws.
export function run(cmd, args, env) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, env: env || process.env });
    } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

// Reads a hook's JSON from stdin; null when there is nothing usable.
export function readHookInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { return null; }
  if (!raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? { data, raw } : null;
  } catch { return null; }
}

export function isMainModule(metaUrl) {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(metaUrl)); }
  catch { return false; }
}
