#!/usr/bin/env node
//
// claude-attention — Notification + PreToolUse(AskUserQuestion) hook.
//
// Speaks a short line, after a knock, whenever Claude Code stops and waits on you:
//   - Claude asks a question (AskUserQuestion) -> the question and its options
//   - waiting for input (idle_prompt)          -> "Claude is waiting for your input"
//   - permission prompt                        -> "Permission needed: <tool>", but only
//     when the permission hook did not already explain that prompt
//
// Contract with Claude Code: exit 0 at once and never write to stdout (PreToolUse
// stdout can be read as a permission decision). Speech runs in a detached child.
// CLAUDE_ATTENTION_DRYRUN=1 prints the line instead (tests).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, isMuted, writeStamp, stampAge, readHookInput, isMainModule, clean, cap,
} from '../lib/common.mjs';
import { askerDir } from '../lib/explain.mjs';
import { playSound, speak } from '../lib/voice.mjs';

const MAX_LEN = 200;
// A permission prompt right after the question we just spoke is the same moment.
const DEDUP_MS = 5000;
// The permission hook explains a prompt in full; its stamp says it did.
const EXPLAINED_MS = 7000;

function joinOr(labels) {
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

// { kind, line } for an event worth speaking, else null.
export function lineFor(data) {
  const event = data?.hook_event_name;
  if (event === 'Notification') {
    if (data.notification_type === 'permission_prompt') {
      // Only the tool name is spoken; anything that doesn't match exactly stays generic.
      const m = /^Claude needs your permission to use ([A-Za-z0-9_.:-]+)$/.exec(String(data.message || '').trim());
      let tool = m ? m[1] : '';
      if (tool.startsWith('mcp__')) tool = tool.split('__').pop();
      tool = tool.replace(/_/g, ' ').trim();
      return { kind: 'permission', line: tool ? `Permission needed: ${tool}` : 'Claude needs your permission' };
    }
    if (data.notification_type === 'idle_prompt') return { kind: 'idle', line: 'Claude is waiting for your input' };
    return null;
  }
  if (event === 'PreToolUse' && data.tool_name === 'AskUserQuestion') {
    const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
    const questions = (Array.isArray(input.questions) ? input.questions : []).filter(q => q && typeof q === 'object');
    if (!questions.length) return null;
    let line = clean(questions[0].question);
    const labels = (Array.isArray(questions[0].options) ? questions[0].options : [])
      .map(o => clean(o?.label)).filter(Boolean);
    if (labels.length) line = `${line} Options: ${joinOr(labels)}`.trim();
    const rest = questions.length - 1;
    if (rest > 0) line += `. And ${rest} more question${rest === 1 ? '' : 's'}`;
    return line ? { kind: 'question', line: cap(line, MAX_LEN) } : null;
  }
  return null;
}

async function speakStage(line, projectDir) {
  const cfg = loadConfig(projectDir);
  if (line.startsWith('Permission needed') || line === 'Claude needs your permission') {
    // Give the permission hook a moment to stamp, then defer to its explanation.
    await new Promise(r => setTimeout(r, 2000));
    if (stampAge() < EXPLAINED_MS) return;
  }
  await playSound();
  await speak(line, cfg, projectDir);
}

async function hookStage() {
  if (process.env.CLAUDE_ATTENTION_EXPLAINING === '1') return;
  const input = readHookInput();
  if (!input) return;
  const found = lineFor(input.data);
  if (!found) return;
  const projectDir = askerDir(input.data);
  if (!loadConfig(projectDir).enabled || isMuted(projectDir)) return;

  if (found.kind === 'question') writeStamp();
  else if (found.kind === 'permission' && stampAge() < DEDUP_MS) return;

  if (process.env.CLAUDE_ATTENTION_DRYRUN === '1') {
    process.stdout.write(`${found.line}\n`);
    return;
  }
  // The line travels as one argv element, never through a shell.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--speak', found.line, projectDir], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

if (isMainModule(import.meta.url)) {
  const job = process.argv[2] === '--speak'
    ? speakStage(String(process.argv[3] || '').slice(0, MAX_LEN), process.argv[4] || '')
    : hookStage();
  job.catch(() => { /* never fail Claude Code */ }).finally(() => { process.exitCode = 0; });
}
