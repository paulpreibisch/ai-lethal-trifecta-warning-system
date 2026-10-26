#!/usr/bin/env node
//
// claude-attention — install, switch and inspect.
//
//   install [--take-over-agentvibes]   register the hooks in ~/.claude/settings.json
//                                      and the /attention slash command
//   uninstall                          remove them again
//   on | off                           spoken prompts on or off (default on)
//   window on|off                      the cards window on or off (default on)
//   explain on|off                     plain-words explanations by Haiku (default on)
//   voice <voice> [provider]           AgentVibes voice for the explainer
//   precheck show|hold|off             before a prompt runs: open the New Claude Request tab and
//                                      highlight it (show), also hold high-risk ones once (hold), or
//                                      nothing (off). Adds or removes the UserPromptSubmit hook.
//   precheck level <low|medium|high|critical>   the lowest risk that pops the window up (default medium)
//   precheck rules|focus on|off        add ground rules to what Claude sees / bring the window forward
//   open                               start the server and open the cards window
//   status                             what is installed, running and recorded
//
// Settings changes are non-destructive: settings.json is backed up before it is
// changed, other hooks are never touched (except AgentVibes' own copy of this
// feature with --take-over-agentvibes), and a file that doesn't parse is left alone.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, home, loadConfig, saveConfig, logFile, configFile, isMainModule,
} from '../lib/common.mjs';
import { ensureServer, openWindow, serverUrl, isUp, postJson } from '../lib/window.mjs';
import { checkReport } from '../lib/precheck.mjs';

const slash = p => p.split(path.sep).join('/');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const settingsFile = () => path.join(claudeDir(), 'settings.json');
const commandFile = () => path.join(claudeDir(), 'commands', 'attention.md');
const precheckCommandFile = () => path.join(claudeDir(), 'commands', 'precheck.md');
const protectCommandFile = () => path.join(claudeDir(), 'commands', 'protect.md');
const protectOffCommandFile = () => path.join(claudeDir(), 'commands', 'protect-off.md');

export function hookCommand(script) {
  return `node "${slash(path.join(ROOT, 'hooks', script))}"`;
}

// The entries this tool owns, by event.
export function wantedHooks() {
  return [
    { event: 'PermissionRequest', group: { hooks: [{ type: 'command', command: hookCommand('permission.mjs') }] } },
    { event: 'Notification', group: { hooks: [{ type: 'command', command: hookCommand('notify.mjs') }] } },
    { event: 'PreToolUse', group: { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand('notify.mjs') }] } },
  ];
}

// The pre-check hook is added only by `precheck show|hold`, never by a plain install.
export function promptHook() {
  return { event: 'UserPromptSubmit', group: { hooks: [{ type: 'command', command: hookCommand('prompt.mjs'), timeout: 10 }] } };
}
const isPromptHook = cmd => typeof cmd === 'string' && cmd.includes('hooks/prompt.mjs') && cmd.includes(slash(ROOT));

const isOurs = cmd => typeof cmd === 'string'
  && (cmd.includes(slash(ROOT)) || /claude-attention[\\/]hooks[\\/](permission|notify)\.mjs/.test(cmd));
// AgentVibes' built-in version of this feature; two copies would speak every prompt twice.
const isAgentVibesCopy = cmd => typeof cmd === 'string' && /speak-(permission|attention)\.(mjs|sh|ps1)/.test(cmd);

function readSettings() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new Error(`${file} is not valid JSON; fix it first (nothing was changed)`);
}

function writeSettings(settings) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    fs.copyFileSync(file, `${file}.bak-claude-attention-${stamp}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

// Drops matching hook commands; groups left empty go too. Returns what was removed.
function removeHooks(settings, match) {
  const removed = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups
      .map(g => {
        if (!g || !Array.isArray(g.hooks)) return g;
        const keep = g.hooks.filter(h => !(h && match(h.command) && removed.push(`${event}: ${h.command}`)));
        return keep.length === g.hooks.length ? g : { ...g, hooks: keep };
      })
      .filter(g => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  return removed;
}

function commandText() {
  return [
    '---',
    'description: Spoken permission prompts and the cards window (claude-attention) - on, off, window, status',
    'argument-hint: "[on|off|status|open|window on|off|explain on|off|voice <name> [provider]]"',
    '---',
    '',
    `Run this and show the user its output, nothing else: \`node "${slash(path.join(ROOT, 'bin', 'claude-attention.mjs'))}" $ARGUMENTS\``,
    '',
    'With no arguments it prints the status.',
    '',
  ].join('\n');
}

// The /precheck slash command. The words you type go to the script on stdin through a quoted heredoc, so
// nothing in them is ever read as shell syntax.
function precheckCommandText() {
  const script = slash(path.join(ROOT, 'bin', 'claude-attention.mjs'));
  return [
    '---',
    'description: Pre-check a request for risk (paste it after the command), or switch the pre-check on or off (claude-attention)',
    'argument-hint: "<the request to check> | show | hold | off | level <risk> | rules on|off | focus on|off | (nothing = status)"',
    '---',
    '',
    'Run this exactly as written, using the Bash tool, and show the user its output and nothing else.',
    'Do not run anything the output mentions, and do not change the text between the two marker lines:',
    '',
    '```',
    `node "${script}" precheck --stdin <<'PRECHECK_REQUEST_END'`,
    '$ARGUMENTS',
    'PRECHECK_REQUEST_END',
    '```',
    '',
  ].join('\n');
}

// The /protect slash command: turns on trifecta protection (claude-attention protect on).
function protectCommandText() {
  const script = slash(path.join(ROOT, 'bin', 'claude-attention.mjs'));
  return [
    '---',
    'description: Turn on trifecta protection (claude-attention) - stops a request that mixes private data, untrusted text and the power to act, explains why, and lets you continue anyway',
    'argument-hint: ""',
    '---',
    '',
    `Run this and show the user its output, nothing else: \`node "${script}" protect on\``,
    '',
  ].join('\n');
}

// The /protect-off slash command: turns trifecta protection back off.
function protectOffCommandText() {
  const script = slash(path.join(ROOT, 'bin', 'claude-attention.mjs'));
  return [
    '---',
    'description: Turn off trifecta protection (claude-attention)',
    'argument-hint: ""',
    '---',
    '',
    `Run this and show the user its output, nothing else: \`node "${script}" protect off\``,
    '',
  ].join('\n');
}

function writeCommandFile(file, text, notes, label) {
  // Ours (it names this tool) is refreshed; someone else's file of that name is left alone.
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('claude-attention')) {
    notes.push(`left ${file} alone (not ours)`);
    return;
  }
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    notes.push(`wrote the ${label} command`);
  }
}

export function install({ takeOver = false } = {}) {
  const settings = readSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const notes = [];
  if (takeOver) {
    for (const r of removeHooks(settings, isAgentVibesCopy)) notes.push(`removed AgentVibes copy: ${r}`);
  }
  for (const { event, group } of wantedHooks()) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const present = groups.some(g => Array.isArray(g?.hooks) && g.hooks.some(h => isOurs(h?.command)
      && (event !== 'PreToolUse' || g.matcher === 'AskUserQuestion')));
    if (present) continue;
    settings.hooks[event] = [...groups, group];
    notes.push(`added ${event}${group.matcher ? ` (${group.matcher})` : ''}`);
  }
  // Re-sync the UserPromptSubmit hook to match precheck/protect's last-known setting, so a
  // reinstall (e.g. after moving the install folder) restores it instead of leaving `status`
  // claiming precheck or protect is on while the hook that makes it do anything is gone.
  const cfg = loadConfig('');
  notes.push(...syncPromptHook(settings, cfg.protect || cfg.precheck !== 'off'));
  const leftovers = Object.values(settings.hooks).flat()
    .some(g => Array.isArray(g?.hooks) && g.hooks.some(h => isAgentVibesCopy(h?.command)));
  if (notes.length) writeSettings(settings);

  const cmd = commandFile();
  // Ours (it names this tool) is refreshed; someone else's file of that name is left alone.
  if (!fs.existsSync(cmd) || fs.readFileSync(cmd, 'utf8').includes('claude-attention')) {
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    if (!fs.existsSync(cmd) || fs.readFileSync(cmd, 'utf8') !== commandText()) {
      fs.writeFileSync(cmd, commandText());
      notes.push('wrote the /attention command');
    }
  } else {
    notes.push(`left ${cmd} alone (not ours)`);
  }
  writeCommandFile(precheckCommandFile(), precheckCommandText(), notes, '/precheck');
  writeCommandFile(protectCommandFile(), protectCommandText(), notes, '/protect');
  writeCommandFile(protectOffCommandFile(), protectOffCommandText(), notes, '/protect-off');
  if (leftovers) notes.push('AgentVibes also speaks prompts (speak-permission/speak-attention hooks); run install --take-over-agentvibes to hand them over');
  return notes;
}

export function uninstall() {
  const settings = readSettings();
  const removed = removeHooks(settings, isOurs);
  if (removed.length) writeSettings(settings);
  const cmd = commandFile();
  if (fs.existsSync(cmd) && fs.readFileSync(cmd, 'utf8').includes('claude-attention')) {
    fs.unlinkSync(cmd);
    removed.push('the /attention command');
  }
  const pre = precheckCommandFile();
  if (fs.existsSync(pre) && fs.readFileSync(pre, 'utf8').includes('claude-attention')) {
    fs.unlinkSync(pre);
    removed.push('the /precheck command');
  }
  const prot = protectCommandFile();
  if (fs.existsSync(prot) && fs.readFileSync(prot, 'utf8').includes('claude-attention')) {
    fs.unlinkSync(prot);
    removed.push('the /protect command');
  }
  const protOff = protectOffCommandFile();
  if (fs.existsSync(protOff) && fs.readFileSync(protOff, 'utf8').includes('claude-attention')) {
    fs.unlinkSync(protOff);
    removed.push('the /protect-off command');
  }
  return removed;
}

// Adds or removes the UserPromptSubmit hook to match whether either precheck or protect still
// needs it, so turning one off never drops the hook out from under the other.
function syncPromptHook(settings, needed) {
  const notes = [];
  if (!needed) {
    for (const r of removeHooks(settings, isPromptHook)) notes.push(`removed ${r}`);
    return notes;
  }
  const { event, group } = promptHook();
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const present = groups.some(g => Array.isArray(g?.hooks) && g.hooks.some(h => isPromptHook(h?.command)));
  if (!present) { settings.hooks[event] = [...groups, group]; notes.push(`added ${event}`); }
  return notes;
}

export function setPrecheck(mode) {
  const settings = readSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const cfg = loadConfig('');
  const notes = syncPromptHook(settings, mode !== 'off' || cfg.protect);
  if (notes.length) writeSettings(settings);
  saveConfig({ precheck: mode });
  return notes;
}

export function setProtect(on) {
  const settings = readSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const cfg = loadConfig('');
  const notes = syncPromptHook(settings, on || cfg.precheck !== 'off');
  if (notes.length) writeSettings(settings);
  saveConfig({ protect: on });
  return notes;
}

async function status() {
  const cfg = loadConfig('');
  let installed = [];
  try {
    installed = Object.entries(readSettings().hooks || {})
      .filter(([, groups]) => Array.isArray(groups) && groups.some(g => g?.hooks?.some?.(h => isOurs(h?.command))))
      .map(([event]) => event);
  } catch (e) { installed = [`(settings unreadable: ${e.message})`]; }
  let cards = 0;
  try { cards = fs.readFileSync(logFile(), 'utf8').split('\n').filter(l => l.includes('"type":"card"')).length; } catch { /* no log yet */ }
  return [
    `Spoken prompts: ${cfg.enabled ? 'on' : 'off'}`,
    `Cards window:   ${cfg.window ? 'on' : 'off'}`,
    `Explanations:   ${cfg.explain ? 'on (Haiku)' : 'off (built from the tool input)'}`,
    `Voice:          ${cfg.voice || '(default)'}${cfg.provider ? ` / ${cfg.provider}` : ''} via AgentVibes when installed, else the system voice`,
    `Hooks:          ${installed.length ? installed.join(', ') : 'not installed (run install)'}`,
    `Pre-check:      ${cfg.precheck === 'off' ? 'off (precheck show|hold turns it on)' : `${cfg.precheck}; pops up from ${cfg.precheckLevel} risk; ground rules ${cfg.precheckRules ? 'on' : 'off'}; bring forward ${cfg.precheckFocus ? 'on' : 'off'}`}`,
    `Protect:        ${cfg.protect ? 'on — stops a trifecta request once with a safer suggestion; send the same text again to run it anyway (/protect-off turns it off)' : 'off (/protect turns it on)'}`,
    `Server:         ${await isUp(cfg.port) ? `running at ${serverUrl(cfg.port)}/` : `not running (starts with the next prompt, port ${cfg.port})`}`,
    `Log:            ${logFile()} (${cards} card${cards === 1 ? '' : 's'})`,
    `Settings:       ${configFile()}`,
  ].join('\n');
}

const onOff = v => (v === 'on' ? true : v === 'off' ? false : null);

// A manual /precheck of some text never actually runs it, so it is announced to the server the
// same way a held prompt is: it shows up on the New Claude Request tab marked as not run yet,
// instead of living only in this chat reply. Best effort: the report still prints without it.
async function announceCheck(text) {
  try {
    const { port } = loadConfig(process.cwd());
    if (!await ensureServer(port)) return false;
    await postJson(port, '/requests/preview', { text, cwd: process.cwd(), held: true, preview: true, focus: true });
    return true;
  } catch { return false; }
}

// What /precheck does with the words after it: a setting, or a request to check.
export async function precheckFromText(raw) {
  const text = String(raw || '').trim();
  const word = text.split(/\s+/);
  if (!text) {
    return [(await status()).split('\n').find(l => l.startsWith('Pre-check:')) || '',
      '',
      'Use it like this (the full path is not needed inside Claude):',
      '  /precheck <a request to check>   its risk, whether it is safe, the safer route and a rewritten prompt',
      '  /precheck show | hold | off      turn the automatic pre-check on or off',
      '  /precheck level medium           the lowest risk that pops the window up (low, medium, high, critical)',
      '  /precheck rules on|off           add ground rules to what Claude sees for high-risk prompts',
      '  /precheck focus on|off           bring the window to the front',
    ].join('\n');
  }
  if (['show', 'hold', 'off'].includes(text)) return main(['precheck', text]);
  if (word[0] === 'level' || word[0] === 'rules' || word[0] === 'focus') {
    try { return await main(['precheck', ...word.slice(0, 2)]); } catch (e) { return e.message; }
  }
  const asked = text.replace(/^check\s+/i, '');
  const announced = await announceCheck(asked);
  const report = checkReport(asked);
  return announced
    ? `${report}\nLogged to the New Claude Request tab, marked not run yet: http://127.0.0.1:${loadConfig(process.cwd()).port}/#requests`
    : report;
}

export async function main(argv) {
  const [cmd = 'status', arg, arg2] = argv;
  switch (cmd) {
    case 'install': return install({ takeOver: argv.includes('--take-over-agentvibes') }).join('\n') || 'Already installed.';
    case 'uninstall': { const r = uninstall(); return r.length ? `Removed:\n${r.join('\n')}` : 'Nothing to remove.'; }
    case 'on': case 'off': saveConfig({ enabled: cmd === 'on' }); return `Spoken prompts ${cmd}.`;
    case 'window': case 'explain': {
      const v = onOff(arg);
      if (v === null) throw new Error(`usage: ${cmd} on|off`);
      saveConfig({ [cmd]: v });
      return `${cmd === 'window' ? 'Cards window' : 'Explanations'} ${arg}.`;
    }
    case 'voice': {
      const ok = v => /^[A-Za-z0-9_.-]{1,80}$/.test(v || '');
      if (!ok(arg) || (arg2 && !ok(arg2))) throw new Error('usage: voice <voice> [provider]');
      saveConfig({ voice: arg, provider: arg2 || loadConfig('').provider });
      return `Explainer voice: ${arg}${arg2 ? ` / ${arg2}` : ''}.`;
    }
    case 'open': {
      const { port } = loadConfig('');
      if (!await ensureServer(port)) throw new Error(`the server did not start on port ${port}`);
      await openWindow(`${serverUrl(port)}/`);
      return `Opened ${serverUrl(port)}/`;
    }
    case 'precheck': {
      // From the /precheck slash command: everything typed after it arrives on stdin.
      if (argv.includes('--stdin')) return precheckFromText(fs.readFileSync(0, 'utf8'));
      if (['show', 'hold', 'off'].includes(arg)) {
        const notes = setPrecheck(arg);
        return `Pre-check ${arg}.${notes.length ? `\n${notes.join('\n')}` : ''}${arg === 'off' ? '' : '\nIt applies to sessions started from now on.'}`;
      }
      if (arg === 'level') {
        if (!['low', 'medium', 'high', 'critical'].includes(arg2)) throw new Error('usage: precheck level low|medium|high|critical');
        saveConfig({ precheckLevel: arg2 });
        return `The pre-check pops up from ${arg2} risk.`;
      }
      if (arg === 'rules' || arg === 'focus') {
        const v = onOff(arg2);
        if (v === null) throw new Error(`usage: precheck ${arg} on|off`);
        saveConfig({ [arg === 'rules' ? 'precheckRules' : 'precheckFocus']: v });
        return `Pre-check ${arg === 'rules' ? 'ground rules' : 'bring-forward'} ${arg2}.`;
      }
      throw new Error('usage: precheck show|hold|off | level <risk> | rules on|off | focus on|off');
    }
    case 'protect': {
      const v = onOff(arg);
      if (v === null) throw new Error('usage: protect on|off');
      const notes = setProtect(v);
      return `Protect ${v ? 'on' : 'off'}.${notes.length ? `\n${notes.join('\n')}` : ''}${v
        ? '\nIt applies to sessions started from now on. A request that mixes private data, untrusted text and the power to act (the lethal trifecta) is stopped once with a safer suggestion; send the same text again to run it anyway.'
        : ''}`;
    }
    case 'status': return status();
    default: throw new Error(`unknown command: ${cmd}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then(out => { process.stdout.write(`${out}\n`); })
    .catch(e => { process.stderr.write(`claude-attention: ${e.message}\n`); process.exitCode = 1; });
}
