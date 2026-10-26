// activity.mjs — what Claude actually did after a request: each tool call in the transcript,
// sorted into the same kinds of step the flows use, with a short masked line saying what it was
// and whether it reached the internet. Pure functions, no I/O, so the tests import it too.

export const MAX_ACTS = 200;       // most tool calls kept per request
export const MAX_REPLY = 4000;     // most of Claude's final reply kept per request

// MCP servers that run on this laptop and reach nothing online.
const LOCAL_MCP = /^mcp__(agentvibes|terminal-tab|ide)__/;
// Functions on an otherwise-local MCP server that reach the internet anyway (a download) and so
// must not inherit the server's "local" default.
const LOCAL_MCP_NET_FN = /^download_extra_voices$/;
// Tool calls that only shuffle Claude's own notes or ask you something: not shown as steps.
const QUIET = new Set(['TodoWrite', 'ToolSearch', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'ListAgents', 'Monitor', 'ScheduleWakeup', 'SendFeedback']);

// Shell commands that reach the internet, and the subset that changes something out there.
const NET_CMD = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|sftp|rsync|gh|npx|ftp)\b|\bgit\s+(push|pull|fetch|clone|ls-remote)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|publish|update|ci)\b|\bpip3?\s+install\b|\bdocker\s+(pull|push|login)\b|\bwrangler\b|\bvercel\b|https?:\/\//i;
const SERVER_CMD = /\b(ssh|scp|sftp|rsync)\b/i;
const SEND_CMD = /\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\bgh\s+(pr|issue|release|repo)\s+(create|merge|comment|edit|delete)\b|\bwrangler\s+(deploy|publish)\b|\bvercel\b.*--prod/i;
const INSTALL_CMD = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bnpx\b|\bdocker\s+pull\b|\bgit\s+clone\b/i;
// A name carrying one of these as its own underscore-delimited word (first, or after a
// namespace like "ads_studio_") is always a read, whatever noun follows — so "get_run" or
// "ads_studio_list_runs" (where "run(s)" is a noun, not the verb) never falls through to
// MCP_WRITE's plain substring match on "run".
const MCP_READ_PREFIX = /(?:^|_)(get|list|show|search|read|fetch|describe|find|query)_/i;
// MCP tools that change something rather than read it.
const MCP_WRITE = /(send|reply|forward|create|update|delete|trash|publish|post|upload|deploy|share|label|move|copy|rename|archive|set_|edit|merge|respond|register|confirm|generate|execute|invoke|run|connect|reconnect|cancel)/i;

const short = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const host = (u) => { try { return new URL(u).host; } catch { return short(u, 80); } };

// One tool call -> { kind, tool, what, net } or null when it is not worth a step.
// `kind` is one of the observed step kinds in flow.js (OBSERVED).
export function classifyTool(name, input = {}, mask = (s) => s) {
  const tool = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (!tool || QUIET.has(tool)) return null;
  const act = (kind, what, net = false) => ({ kind, tool, what: mask(short(what)), net });

  if (tool === 'WebSearch') return act('web', `search: ${i.query || ''}`, true);
  if (tool === 'WebFetch') return act('web', `open ${host(i.url)}${i.url ? ` (${short(i.url, 100)})` : ''}`, true);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'NotebookRead' || tool === 'LS') {
    return act('files', `${tool} ${i.file_path || i.path || i.pattern || ''}${tool === 'Grep' && i.pattern ? ` "${i.pattern}"` : ''}`);
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') return act('change', `${tool} ${i.file_path || i.notebook_path || ''}`);
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(i.command || '');
    const what = i.description ? `${i.description}: ${cmd}` : cmd;
    if (SERVER_CMD.test(cmd)) return act('server', what, true);
    if (SEND_CMD.test(cmd)) return act('send', what, true);
    if (INSTALL_CMD.test(cmd)) return act('install', what, true);
    // curl to this laptop's own servers (127.0.0.1, localhost) stays on the machine.
    const urls = cmd.match(/https?:\/\/[^\s'"]+/gi) || [];
    const localOnly = urls.length > 0 && urls.every((u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(u));
    const rest = cmd.replace(/https?:\/\/[^\s'"]+/gi, '').replace(/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/gi, '');
    if (localOnly && !NET_CMD.test(rest)) return act('run', what);
    if (NET_CMD.test(cmd)) return act('web', what, true);
    return act('run', what);
  }
  if (tool === 'Agent' || tool === 'Task') return act('agent', `${i.subagent_type ? `${i.subagent_type}: ` : ''}${i.description || i.prompt || ''}`);
  if (tool === 'Skill') return act('skill', `skill ${i.skill || ''}${i.args ? ` ${i.args}` : ''}`);
  if (tool === 'Artifact' || tool === 'ArtifactData' || tool === 'ArtifactComments') {
    const quiet = ['read', 'list', 'quickstart', 'open', 'get', 'query'].includes(String(i.action || ''));
    return act(quiet ? 'service' : 'send', `${tool} ${i.action || 'publish'} ${i.url || i.file_path || ''}`, true);
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', fn = ''] = tool.split('__');
    const arg = Object.values(i).find((v) => typeof v === 'string' && v.trim()) || '';
    const what = `${server.replace(/^claude_ai_/, '')} ${fn}${arg ? `: ${arg}` : ''}`;
    if (LOCAL_MCP.test(tool) && !LOCAL_MCP_NET_FN.test(fn)) return act('run', what);
    if (LOCAL_MCP.test(tool)) return act('service', what, true);
    if (/^mcp__claude-in-chrome__/.test(tool)) return act('web', `browser ${what}`, true);
    if (MCP_READ_PREFIX.test(fn)) return act('service', what, true);
    return act(MCP_WRITE.test(fn) ? 'send' : 'service', what, true);
  }
  return act('run', `${tool}${Object.keys(i).length ? ` ${short(JSON.stringify(i), 120)}` : ''}`);
}
