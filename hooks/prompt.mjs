#!/usr/bin/env node
//
// claude-attention — UserPromptSubmit hook (the "pre-check").
//
// The moment you press Enter on a prompt, before Claude starts on it, this works out how exposed the
// request is (private data, text from strangers, the power to act) and:
//   - opens the Claude Attention window on its New Claude Request tab, brings it forward, and highlights
//     the card for this prompt, so you can see the flows, the safer route and the rewritten prompt;
//   - in `hold` mode, holds a high-risk prompt once, with the advice, and lets it through when you send
//     the same text again;
//   - for high-risk prompts, adds the ground rules to what Claude sees (switchable).
//
// Off by default; `claude-attention precheck show|hold|off` turns it on or off (and adds or removes the
// hook). It only acts for a person typing in an attended terminal session, never for `claude -p` or
// scheduled jobs. It never fails a prompt: any error means no output and exit 0.
//
// Contract with Claude Code: JSON on stdin; stdout is empty, or one JSON object (a block decision, or
// extra context). All slow work (starting the server, opening and focusing the window) happens in a
// detached child (`--show <payload-file>`), so typing is never held up.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, loadConfig, readHookInput, isMainModule } from '../lib/common.mjs';
import {
  assess, atLeast, interactive, holdMessage, protectMessage, isTrifecta, rulesContext, keyFor, wasHeld, markHeld, clearHeld,
} from '../lib/precheck.mjs';
import { ensureServer, postJson, maybeOpenWindow, bringToFront } from '../lib/window.mjs';

// What to do about one prompt. Pure apart from the held-prompts file; returns what to print and what to show.
//
// precheck (show/hold) and protect are independent switches sharing this one hook: protect stops
// only the lethal trifecta, whatever precheck is set to (even off), and stays silent otherwise so
// it never pops the window up or announces a prompt that it did not act on.
export function decide(data, cfg, env = process.env) {
  if (!cfg.enabled) return null;
  const precheckOn = cfg.precheck !== 'off';
  const protectOn = !!cfg.protect;
  if (!precheckOn && !protectOn) return null;
  if (!interactive(env)) return null;
  const text = String(data.prompt || '').trim();
  if (!text || text.startsWith('/')) return null;          // empty, or one of Claude Code's own / commands
  const mode = String(data.permission_mode || '');
  const sessionId = String(data.session_id || '');
  const a = assess(text, mode);
  const protectKey = keyFor(sessionId, text, 'protect');
  const precheckKey = keyFor(sessionId, text, 'precheck');

  let output = null;
  let held = false;
  if (protectOn && isTrifecta(a) && !wasHeld(protectKey)) {
    markHeld(protectKey);
    markHeld(precheckKey); // protect's stop already covers precheck's weaker advisory hold
    held = true;
    output = { decision: 'block', reason: protectMessage(a) };
  } else if (precheckOn && cfg.precheck === 'hold' && atLeast(a.risk.level, 'high') && !wasHeld(precheckKey)) {
    markHeld(precheckKey);
    held = true;
    output = { decision: 'block', reason: holdMessage(a) };
  } else {
    clearHeld(protectKey);
    clearHeld(precheckKey);
    if (precheckOn && cfg.precheckRules && atLeast(a.risk.level, 'high') && a.rules.length) {
      output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: rulesContext(a) } };
    }
  }
  if (!precheckOn && !held) return null;    // protect-only, and nothing tripped it: nothing to show
  const focus = held || (precheckOn && atLeast(a.risk.level, cfg.precheckLevel));
  return { output, show: { sessionId, cwd: String(data.cwd || ''), mode, text, held, focus, level: a.risk.level } };
}

// Detached stage: make the server announce the prompt and open or raise the window.
async function showStage(file) {
  const resolved = path.resolve(String(file || ''));
  if (!resolved.startsWith(path.resolve(tmpDir()) + path.sep)) return;
  let show;
  try { show = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { return; } finally {
    try { fs.unlinkSync(resolved); } catch { /* already gone */ }
  }
  const cfg = loadConfig(show.cwd);
  if (!await ensureServer(cfg.port)) return;
  const r = await postJson(cfg.port, '/requests/preview', show);
  if (!r || !show.focus) return;
  if (cfg.window) {
    const opened = await maybeOpenWindow(cfg.port, Number.isInteger(r.viewers) ? r.viewers : null, '#requests');
    if (!opened && cfg.precheckFocus) bringToFront();
  }
}

async function hookStage() {
  const input = readHookInput();
  if (!input) return;
  const { data } = input;
  if (data.hook_event_name && data.hook_event_name !== 'UserPromptSubmit') return;
  const cwd = typeof data.cwd === 'string' ? data.cwd : '';
  const cfg = loadConfig(cwd);
  const verdict = decide(data, cfg);
  if (!verdict) return;

  if (process.env.CLAUDE_ATTENTION_DRYRUN === '1') {
    process.stdout.write(`${JSON.stringify({ output: verdict.output, show: verdict.show })}\n`);
    return;
  }

  fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir(), `prompt-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(verdict.show), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--show', file], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  if (verdict.output) process.stdout.write(JSON.stringify(verdict.output));
}

if (isMainModule(import.meta.url)) {
  const job = process.argv[2] === '--show' ? showStage(process.argv[3]) : hookStage();
  job.catch(() => { /* never fail Claude Code */ }).finally(() => { process.exitCode = 0; });
}
