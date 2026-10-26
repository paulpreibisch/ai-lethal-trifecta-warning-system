// answers.mjs — how a permission prompt was answered.
//
// Claude Code has no hook for "the user denied this" (PermissionDenied is auto mode
// only) and PermissionRequest gets no tool_use_id. The session transcript has both
// halves: the tool_use being asked about, then its tool_result. A rejected call's
// result is an error saying the user did not want to proceed; any other result
// means it was allowed (and ran, whether or not it then failed).

import fs from 'node:fs';
import path from 'node:path';
import { home } from './common.mjs';

const WATCH_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 1000;
const TRANSCRIPT_TAIL = 4 * 1024 * 1024;
const MATCH_WINDOW_MS = 2 * 60 * 1000;
// The watcher starts a moment after the dialog appears; a very quick answer can
// land just before it.
const ANSWER_SLACK_MS = 5000;

// The transcript must be a .jsonl under Claude's projects folder.
export function transcriptPath(p) {
  if (typeof p !== 'string' || !p.endsWith('.jsonl')) return '';
  const resolved = path.resolve(p);
  const base = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), 'projects');
  return resolved.startsWith(base + path.sep) ? resolved : '';
}

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function sameCall(a, b) {
  if (stableJson(a) === stableJson(b)) return true;
  // Claude Code may add defaults to the input it hands the hook.
  for (const key of ['command', 'file_path', 'url', 'query']) {
    if (a && b && typeof a[key] === 'string' && a[key] === b[key]) return true;
  }
  return false;
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

// Feed transcript lines in order; answer() is { answer, answeredAt } from the
// first result for the asked-about call, and never changes after that. `since`
// (when the prompt was shown) keeps an identical earlier call, and its result,
// from being taken for this one; the call can be re-run straight after it is
// answered, so the first answer wins rather than the latest call.
export function createAnswerWatcher(toolName, toolInput, since = Date.now()) {
  let target = '';
  let found = null;
  function feed(raw) {
    if (found || !raw.includes('tool_')) return;
    let o;
    try { o = JSON.parse(raw); } catch { return; }
    const blocks = Array.isArray(o?.message?.content) ? o.message.content : [];
    const at = Date.parse(o.timestamp) || Date.now();
    for (const b of blocks) {
      if (o.type === 'assistant' && b?.type === 'tool_use' && b.name === toolName
          && at >= since - MATCH_WINDOW_MS && sameCall(b.input, toolInput)) {
        target = b.id;
      } else if (o.type === 'user' && b?.type === 'tool_result' && target && b.tool_use_id === target
          && at >= since - ANSWER_SLACK_MS) {
        const denied = b.is_error === true && (String(o.toolUseResult || '').startsWith('User rejected')
          || /^The user doesn.t want to/.test(resultText(b)));
        found = { answer: denied ? 'denied' : 'allowed', answeredAt: at };
        return;
      }
    }
  }
  return { feed, answer: () => found };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Follows the transcript (new bytes only) until the call is answered or the watch
// window ends; null if it never was.
export async function watchAnswer(data, since = Date.now()) {
  const file = transcriptPath(data?.transcript_path);
  if (!file || !data?.tool_name) return null;
  const watcher = createAnswerWatcher(data.tool_name, data.tool_input, since);
  const limit = Number(process.env.CLAUDE_ATTENTION_WATCH_MS) || WATCH_MS;
  const poll = Number(process.env.CLAUDE_ATTENTION_POLL_MS) || POLL_MS;
  let offset = -1;
  let rest = '';
  let partial = false;   // starting mid-file, the first piece is half a line
  const end = Date.now() + limit;
  while (Date.now() < end) {
    try {
      const size = fs.statSync(file).size;
      if (offset < 0) { offset = Math.max(0, size - TRANSCRIPT_TAIL); partial = offset > 0; }
      if (size > offset) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
        const lines = (rest + buf.toString('utf8')).split('\n');
        rest = lines.pop();
        if (partial) { lines.shift(); partial = false; }
        offset = size;
        for (const l of lines) watcher.feed(l);
        const found = watcher.answer();
        if (found) return found;
      }
    } catch { /* transcript not written yet, or rotated: keep watching */ }
    await sleep(poll);
  }
  return null;
}
