// risk.mjs — how risky saying yes is: low, medium, high or critical.
//
// Two opinions, and the card shows the higher one:
//   - rules: a fixed floor from the tool and the command (deleting, force-pushing,
//     stopping services, reaching other machines, sending messages ...), so a
//     dangerous call is never shown as low because the model misjudged it;
//   - the model: Haiku rates it alongside its explanation and gives a short reason.

import { clean } from './common.mjs';

export const LEVELS = ['low', 'medium', 'high', 'critical'];
const rank = l => LEVELS.indexOf(l);

export function higher(a, b) {
  return rank(b?.level) > rank(a?.level) ? b : a;
}

// Most dangerous first; the first match wins.
const COMMAND_RULES = [
  ['critical', 'deletes from the root or home folder', /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i],
  ['critical', 'force-pushes over shared history', /\bgit\s+push\b[^|;&]*(--force\b|-f\b|--force-with-lease)/i],
  ['critical', 'wipes a disk or database', /\b(mkfs|dd\s+if=|format\s+[a-z]:|drop\s+(database|schema)|diskpart)\b/i],
  ['critical', 'runs a script straight from the internet', /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b|\biex\b.*\b(iwr|irm|downloadstring)/i],
  ['high', 'deletes files', /\b(rm\s+-[a-z]*r|rmdir\s+\/s|remove-item\b[^|;]*-recurse|del\s+\/[sq])/i],
  ['high', 'rewrites or discards git history', /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|rebase|filter-(branch|repo)|branch\s+-D|push\b)/i],
  ['high', 'changes a database', /\b(delete\s+from|truncate\s+table|drop\s+table|alter\s+table|update\s+\w+\s+set)\b/i],
  ['high', 'stops or changes running services', /\b(docker\s+(stop|rm|kill|compose\s+down|update)|systemctl\s+(stop|restart|disable)|kubectl\s+(delete|apply|scale)|stop-(process|service)|taskkill|kill\s+-9|shutdown|reboot)\b/i],
  ['high', 'works on another machine', /\b(ssh|scp|rsync)\b/i],
  ['high', 'deploys or publishes', /\b(npm\s+publish|terraform\s+(apply|destroy)|deploy|gh\s+release|vercel\s+--prod|fly\s+deploy)\b/i],
  ['high', 'runs with admin rights', /\b(sudo|runas|start-process\b[^|;]*-verb\s+runas)\b/i],
  ['high', 'changes permissions or system settings', /\b(chmod\s+-R|chown\s+-R|icacls|reg\s+(add|delete)|set-mppreference|setx)\b/i],
  ['medium', 'installs software', /\b(npm|pnpm|yarn|pip|pipx|brew|apt(-get)?|winget|choco|cargo)\s+(install|add|i)\b/i],
  ['medium', 'changes git state', /\bgit\s+(commit|merge|checkout|switch|stash|tag|cherry-pick)\b/i],
  ['medium', 'moves or overwrites files', /\b(mv|cp|move-item|copy-item|ren|rename)\b|>\s*[^&|]/i],
  ['medium', 'reaches the internet', /\b(curl|wget|invoke-webrequest|invoke-restmethod|fetch)\b/i],
];
const READ_ONLY = /^\s*(ls|dir|cat|type|head|tail|less|grep|rg|find|wc|echo|pwd|which|where|git\s+(status|log|diff|show|branch)|node\s+--version|npm\s+(ls|view|test)|get-childitem|get-content|select-string)\b/i;

const MCP_HIGH = /(send|delete|remove|trash|publish|post|deploy|transfer|purchase|pay|share|create_event|update_event|reply|forward|archive|unpublish)/i;
const MCP_LOW = /(get|list|read|search|query|view|show|find|status|fetch|describe|context)/i;

export function ruleRisk(data) {
  const tool = String(data?.tool_name || '');
  const input = data?.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(input.command || '');
    for (const [level, reason, re] of COMMAND_RULES) if (re.test(cmd)) return { level, reason };
    // Every part of a chain has to be read-only for the whole to be low.
    const parts = cmd.split(/&&|\|\||;|\|/).filter(p => p.trim());
    if (parts.length && parts.every(p => READ_ONLY.test(p))) return { level: 'low', reason: 'only reads' };
    return { level: 'medium', reason: 'runs a command' };
  }
  if (['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'NotebookRead'].includes(tool)) return { level: 'low', reason: 'only reads' };
  if (tool === 'WebFetch') return { level: 'low', reason: 'reads a web page' };
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    const file = String(input.file_path || input.notebook_path || '');
    if (/(^|[\\/])(\.env[^\\/]*|\.ssh|\.aws|\.gnupg|id_[a-z0-9]+|credentials?[^\\/]*|settings\.json)$/i.test(file)) {
      return { level: 'high', reason: 'changes a secrets or settings file' };
    }
    return { level: 'medium', reason: 'changes a file' };
  }
  if (tool.startsWith('mcp__')) {
    const action = tool.split('__').pop();
    if (MCP_HIGH.test(action)) return { level: 'high', reason: 'acts for you in another service' };
    if (MCP_LOW.test(action)) return { level: 'low', reason: 'reads from another service' };
    return { level: 'medium', reason: 'uses another service' };
  }
  return { level: 'medium', reason: '' };
}

// The model's first line: "RISK: high | takes a public site offline".
export function parseModelRisk(text) {
  const m = /^\s*RISK\s*:\s*(low|medium|high|critical)\b\s*(?:[|:-]\s*(.*))?$/im.exec(String(text || ''));
  if (!m) return { risk: null, rest: String(text || '') };
  const reason = clean(m[2] || '').replace(/[.]+$/, '').split(' ').slice(0, 10).join(' ');
  return { risk: { level: m[1].toLowerCase(), reason }, rest: String(text).replace(m[0], '') };
}
