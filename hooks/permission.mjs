#!/usr/bin/env node
//
// claude-attention — PermissionRequest hook.
//
// When Claude Code asks for permission, this plays a knock, explains in plain words
// what Claude wants to do and why, shows it as a card in the cards window, speaks
// it, then follows the session transcript and records on the card (and in the log)
// whether you allowed or denied it.
//
// Contract with Claude Code: exit 0 at once and never write to stdout (a
// PermissionRequest hook's stdout can be read as an allow/deny decision). All the
// work happens in a detached, hidden child (`--speak <payload-file>`), so the
// dialog is never held up.
//
// CLAUDE_ATTENTION_DRYRUN=1 prints the explanation instead (tests).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  tmpDir, loadConfig, isMuted, writeStamp, appendLog, readHookInput, isMainModule, clean,
} from '../lib/common.mjs';
import { explain, askerDir } from '../lib/explain.mjs';
import { playSound, speak, voiceEngine } from '../lib/voice.mjs';
import { watchAnswer } from '../lib/answers.mjs';
import { ensureServer, postJson, maybeOpenWindow } from '../lib/window.mjs';

function words(name) {
  return String(name).replace(/[_-]+/g, ' ').trim();
}

// What the card shows. Never the command itself: only the explanation and
// Claude's own one-line description of it.
export function buildCard(data, { line, risk }, projectDir, id, cfg) {
  const tool = String(data?.tool_name || '');
  const dir = projectDir || (typeof data?.cwd === 'string' ? data.cwd : '');
  const engine = voiceEngine(projectDir);
  return {
    id,
    line,
    summary: clean(data?.tool_input?.description),
    tool: tool.startsWith('mcp__') ? words(tool.split('__').pop()) : tool,
    project: dir ? path.basename(dir) : '',
    cwd: dir ? path.resolve(dir) : '',
    sessionId: String(data?.session_id || ''),
    risk: risk?.level || '',
    riskReason: risk?.reason || '',
    voice: engine === 'agentvibes' ? cfg.voice : '',
    provider: engine === 'agentvibes' ? cfg.provider : '',
  };
}

async function showCard(card, cfg) {
  appendLog({ type: 'card', card: { ...card, createdAt: Date.now() } });
  if (!await ensureServer(cfg.port)) return false;
  const r = await postJson(cfg.port, '/attention', card);
  if (r && cfg.window) await maybeOpenWindow(cfg.port, Number.isInteger(r.viewers) ? r.viewers : null);
  return Boolean(r);
}

async function recordAnswer(id, result, cfg) {
  appendLog({ type: 'answer', id, answer: result.answer, answeredAt: result.answeredAt });
  if (await ensureServer(cfg.port)) await postJson(cfg.port, '/attention/answer', { id, ...result });
}

// Detached stage: sound and explanation in parallel, then the card, then speech.
// The transcript is watched from the start (the answer can come before the card
// is up); the answer is recorded once the card exists.
async function speakStage(file) {
  const resolved = path.resolve(String(file || ''));
  if (!resolved.startsWith(path.resolve(tmpDir()) + path.sep)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { return; } finally {
    try { fs.unlinkSync(resolved); } catch { /* already gone */ }
  }
  const projectDir = askerDir(data);
  const cfg = loadConfig(projectDir);
  const id = crypto.randomBytes(6).toString('hex');
  const answered = watchAnswer(data);
  const [said] = await Promise.all([explain(data, { useModel: cfg.explain }), playSound()]);
  if (!said?.line) return;
  await showCard(buildCard(data, said, projectDir, id, cfg), cfg);
  await speak(said.line, cfg, projectDir);
  const result = await answered;
  if (result) await recordAnswer(id, result, cfg);
}

async function hookStage() {
  if (process.env.CLAUDE_ATTENTION_EXPLAINING === '1') return;
  const input = readHookInput();
  if (!input) return;
  const { data, raw } = input;
  if (data.hook_event_name && data.hook_event_name !== 'PermissionRequest') return;
  // The question itself is spoken by the notify hook.
  if (data.tool_name === 'AskUserQuestion') return;

  const projectDir = askerDir(data);
  const cfg = loadConfig(projectDir);
  if (!cfg.enabled || isMuted(projectDir)) return;
  writeStamp();

  if (['1', 'risk'].includes(process.env.CLAUDE_ATTENTION_DRYRUN)) {
    const said = await explain(data, { useModel: cfg.explain });
    // DRYRUN=risk shows the rating too.
    process.stdout.write(process.env.CLAUDE_ATTENTION_DRYRUN === 'risk'
      ? `${said.risk.level} | ${said.risk.reason} | ${said.line}\n` : `${said.line}\n`);
    return;
  }

  // The payload goes to a private file, not argv: it holds the full command.
  fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir(), `permission-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, raw, { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--speak', file], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

if (isMainModule(import.meta.url)) {
  const job = process.argv[2] === '--speak' ? speakStage(process.argv[3]) : hookStage();
  job.catch(() => { /* never fail Claude Code */ }).finally(() => { process.exitCode = 0; });
}
