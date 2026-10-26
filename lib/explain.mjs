// explain.mjs — turns a permission request into one or two plain spoken sentences:
// what Claude wants to do, why, and what saying yes changes.
//
// Haiku writes it (through the local `claude` CLI, prompt on stdin, --safe-mode so no
// hooks run inside it) from the tool input and Claude's last message. Secrets are
// masked before anything leaves the machine, and whatever comes back is scrubbed of
// paths, URLs and long tokens before it is spoken. If the model is off or fails, a
// line built from the tool input alone is used.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WINDOWS, home, exists, readTrim, clean, cap } from './common.mjs';
import { ruleRisk, parseModelRisk, higher } from './risk.mjs';

const MAX_LEN = 300;
const MODEL_TIMEOUT_MS = 25000;
const INPUT_LIMIT = 2500;
const CONTEXT_LIMIT = 1500;

// Whatever the model says, nothing that looks like a URL, path or credential is spoken.
export function sanitizeSpoken(s) {
  // Windows paths go before clean(), which would turn their backslashes into spaces.
  const noPaths = String(s ?? '').replace(/(?:\b[A-Za-z]:)?\\\S*/g, ' ');
  const words = clean(noPaths)
    .replace(/https?:\/\/\S+/gi, 'a web address')
    .split(' ')
    .filter(w => w.length < 30 && !/[\\/].*[\\/]/.test(w));
  return cap(words.join(' ').trim(), MAX_LEN);
}

// Masks secret-looking values before the tool input leaves this machine for the model.
export function redact(text) {
  return String(text ?? '')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1****$2')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ****')
    .replace(/((?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|auth|credential|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;"']+)/gi, '$1****')
    .replace(/(-H\s*["']?(?:authorization|x-api-key|api-key|cookie)\s*:\s*)[^"'\n]+/gi, '$1****')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '****');
}

function words(name) {
  return String(name).replace(/[_-]+/g, ' ').trim();
}

// Who is asking: the project's AgentVibes pretext when it has one ("Efblockmexico
// here" -> "Efblockmexico"), else the folder name, else "Claude".
export function projectName(projectDir) {
  let name = '';
  if (projectDir) {
    const cfgDir = path.join(projectDir, '.claude', 'config');
    name = readTrim(path.join(cfgDir, 'tts-pretext.txt')) || '';
    if (!name) {
      const row = (readTrim(path.join(cfgDir, 'audio-effects.cfg')) || '')
        .split(/\r?\n/).find(l => l.startsWith('llm:claude-code|'));
      name = row ? (row.split('|')[5] || '') : '';
    }
    name = clean(name).replace(/[\s,:-]*\b(is\s+)?here\b[\s.!]*$/i, '').trim();
    if (!name) name = path.basename(projectDir).replace(/[-_]+/g, ' ');
  }
  name = clean(name).slice(0, 40).trim();
  return name ? name[0].toUpperCase() + name.slice(1) : 'Claude';
}

export function askerDir(data) {
  return process.env.CLAUDE_PROJECT_DIR || (typeof data?.cwd === 'string' ? data.cwd : '');
}

// Spoken when the model is off or fails: built only from what the tool input says.
export function fallbackLine(data, who = 'Claude') {
  const tool = String(data?.tool_name || '');
  const input = data?.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const desc = clean(input.description);
  let line;
  if (tool === 'Bash' || tool === 'PowerShell') {
    line = desc ? `${who} wants to run a command: ${desc}` : `${who} wants to run a command`;
  } else if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const f = path.basename(String(input.file_path || input.notebook_path || ''));
    line = f ? `${who} wants to edit ${clean(f)}` : `${who} wants to edit a file`;
  } else if (tool === 'Write') {
    const f = path.basename(String(input.file_path || ''));
    line = f ? `${who} wants to write the file ${clean(f)}` : `${who} wants to write a file`;
  } else if (tool === 'WebFetch') {
    let host = '';
    try { host = new URL(String(input.url)).hostname; } catch { /* not a URL */ }
    line = host ? `${who} wants to open a web page on ${host}` : `${who} wants to open a web page`;
  } else if (tool === 'WebSearch') {
    line = `${who} wants to search the web`;
  } else if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    const server = words(parts[1] || '').replace(/^claude ai /i, '');
    line = `${who} wants to use ${words(parts[parts.length - 1])}${server ? ` from ${server}` : ''}`;
  } else if (tool) {
    line = `${who} wants to use ${words(tool)}`;
  } else {
    line = `${who} needs your permission`;
  }
  return cap(clean(line), MAX_LEN);
}

// The "why": the text of Claude's last assistant message, read from the transcript tail.
export function lastAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  let fd;
  try {
    const size = fs.statSync(transcriptPath).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    for (const l of buf.toString('utf8').split('\n').reverse()) {
      let entry;
      try { entry = JSON.parse(l); } catch { continue; }
      if (entry?.type !== 'assistant') continue;
      const content = entry.message?.content;
      const texts = Array.isArray(content)
        ? content.filter(c => c?.type === 'text' && c.text).map(c => c.text)
        : (typeof content === 'string' ? [content] : []);
      if (texts.length) return texts.join('\n').slice(-CONTEXT_LIMIT);
    }
  } catch { /* unreadable transcript: no context */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return '';
}

export function buildPrompt(data, who = 'Claude', context = lastAssistantText(data?.transcript_path)) {
  const input = JSON.stringify(data?.tool_input ?? {}, null, 1);
  return [
    'Claude Code (an AI coding assistant) has paused and is asking its user for permission to run a tool.',
    `Explain to the user, out loud, in plain everyday language, what Claude wants to do and why, and what saying yes would change. Call Claude "${who}".`,
    `Rules: one or two short sentences, at most 40 words. Start with "${who} wants to". No jargon, no code, no commands, no file paths,`,
    'no URLs, no IP addresses. Never say any password, key, token or secret.',
    'First line: "RISK: <low|medium|high|critical> | <why, at most 8 words>" for how risky saying yes is',
    '(low = only reads; medium = changes local files or installs; high = deletes, deploys, touches other machines,',
    'services or accounts, or is hard to undo; critical = could destroy data or affect many people). Then the sentences.',
    '',
    `Tool: ${data?.tool_name || 'unknown'}`,
    'Tool input (secrets masked):',
    redact(input).slice(0, INPUT_LIMIT),
    '',
    'What Claude said just before asking (for the why):',
    redact(context) || '(nothing)',
  ].join('\n');
}

// On Windows `claude` on PATH is usually an npm .cmd shim, which spawn() cannot run
// without a shell, so look for the real claude.exe behind it.
function findClaudeExe() {
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(d, 'claude.exe');
    if (exists(exe)) return exe;
    if (exists(path.join(d, 'claude.cmd'))) {
      const npmExe = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(npmExe)) return npmExe;
    }
  }
  const native = path.join(home(), '.local', 'bin', 'claude.exe');
  return exists(native) ? native : null;
}

function claudeCommand() {
  const bin = process.env.CLAUDE_ATTENTION_CLAUDE_BIN;
  if (bin && /\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, [bin]];
  if (bin) return [bin, []];
  return [IS_WINDOWS ? findClaudeExe() : 'claude', []];
}

// Resolves to the model's spoken line, or '' on any failure.
export function askModel(prompt, timeoutMs = Number(process.env.CLAUDE_ATTENTION_EXPLAIN_TIMEOUT_MS) || MODEL_TIMEOUT_MS) {
  return new Promise(resolve => {
    const [cmd, pre] = claudeCommand();
    if (!cmd) { resolve(''); return; }
    // Prompt on stdin, never argv: process auditing records command lines.
    const args = [...pre, '-p', '--safe-mode', '--model', 'haiku', '--no-session-persistence', '--tools', ''];
    let out = '';
    let done = false;
    let timer;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        cwd: os.tmpdir(),
        env: { ...process.env, CLAUDE_ATTENTION_EXPLAINING: '1' },
      });
    } catch { finish(''); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.on('error', () => finish(''));
    child.stdout.on('data', d => { out += d; if (out.length > 8000) { try { child.kill(); } catch { /* gone */ } } });
    child.on('close', code => finish(code === 0 ? out : ''));
    child.stdin.on('error', () => { /* child exited early */ });
    child.stdin.end(prompt);
  });
}

// { line, risk: { level, reason } }. The rules set a floor under the model's risk.
export async function explain(data, { useModel = true } = {}) {
  const who = projectName(askerDir(data));
  const fallback = fallbackLine(data, who);
  const rules = ruleRisk(data);
  if (!useModel || process.env.CLAUDE_ATTENTION_AI === '0') return { line: fallback, risk: rules };
  const { risk, rest } = parseModelRisk(await askModel(buildPrompt(data, who)));
  const said = sanitizeSpoken(rest);
  return {
    line: said.split(' ').length >= 3 ? said : fallback,
    risk: risk ? higher(risk, rules) : rules,
  };
}
