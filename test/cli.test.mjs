// install / uninstall / switches, against a temp HOME's ~/.claude (never the live one).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'claude-attention.mjs');
let home;

before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-')); });
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
beforeEach(() => fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }));

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CLAUDE_ATTENTION_PORT: '39884' },
});
const settingsFile = () => path.join(home, '.claude', 'settings.json');
const settings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const backups = () => fs.readdirSync(path.join(home, '.claude')).filter(f => f.startsWith('settings.json.bak-claude-attention-'));
function seed(obj) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2));
}
const commands = s => Object.values(s.hooks || {}).flat().flatMap(g => g.hooks.map(h => h.command));

test('install adds the three hooks and the slash command, and keeps everything else', () => {
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check.sh' }] };
  seed({ model: 'opus', hooks: { PreToolUse: [mine] } });
  const r = cli('install');
  assert.equal(r.status, 0, r.stderr);
  const s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.PreToolUse[0], mine);
  assert.equal(s.hooks.PreToolUse[1].matcher, 'AskUserQuestion');
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /^node ".*\/hooks\/permission\.mjs"$/);
  assert.match(s.hooks.Notification[0].hooks[0].command, /notify\.mjs"$/);
  assert.equal(backups().length, 1);
  assert.ok(fs.readFileSync(path.join(home, '.claude', 'commands', 'attention.md'), 'utf8').includes('claude-attention.mjs'));
});

test('install twice changes nothing the second time', () => {
  cli('install');
  const first = fs.readFileSync(settingsFile(), 'utf8');
  const r = cli('install');
  assert.equal(r.stdout.trim(), 'Already installed.');
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), first);
  assert.equal(backups().length, 0);   // no settings.json existed before the first install
});

test('settings that do not parse are left exactly as they are', () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(settingsFile(), '{ "hooks": oops');
  const r = cli('install');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ "hooks": oops');
});

test('someone else\u2019s /attention command is not overwritten', () => {
  fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'commands', 'attention.md'), 'my own command');
  assert.match(cli('install').stdout, /left .* alone/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'commands', 'attention.md'), 'utf8'), 'my own command');
});

test('AgentVibes\u2019 copy of the feature is reported, and only removed with --take-over-agentvibes', () => {
  const av = (cmd, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd }] });
  seed({ hooks: {
    PermissionRequest: [av('node "$HOME/.claude/hooks/speak-permission.mjs"')],
    Notification: [av('powershell -File "C:/x/.claude/hooks-windows/speak-attention.ps1"'), av('other-notifier.sh')],
  } });
  assert.match(cli('install').stdout, /--take-over-agentvibes/);
  assert.ok(commands(settings()).some(c => c.includes('speak-permission')));
  const r = cli('install', '--take-over-agentvibes');
  assert.match(r.stdout, /removed AgentVibes copy/);
  const after = commands(settings());
  assert.ok(!after.some(c => /speak-(permission|attention)/.test(c)));
  assert.ok(after.includes('other-notifier.sh'));
});

test('uninstall removes only what install added', () => {
  seed({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'other-notifier.sh' }] }] } });
  cli('install');
  const r = cli('uninstall');
  assert.match(r.stdout, /Removed/);
  assert.deepEqual(commands(settings()), ['other-notifier.sh']);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'commands', 'attention.md')), false);
  assert.equal(cli('uninstall').stdout.trim(), 'Nothing to remove.');
});

test('switches write the config; bad input is refused; status reports them', () => {
  assert.equal(cli('off').status, 0);
  assert.equal(cli('window', 'off').status, 0);
  assert.equal(cli('voice', 'bf_emma').status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude-attention', 'config.json'), 'utf8'));
  assert.deepEqual([cfg.enabled, cfg.window, cfg.voice], [false, false, 'bf_emma']);
  assert.equal(cli('window', 'maybe').status, 1);
  assert.equal(cli('voice', 'x; rm -rf').status, 1);
  const s = cli('status').stdout;
  assert.match(s, /Spoken prompts: off/);
  assert.match(s, /Cards window: {3}off/);
  cli('on');
  cli('window', 'on');
});
