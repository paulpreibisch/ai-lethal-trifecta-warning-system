// The hooks as Claude Code runs them: a child process, JSON on stdin, a temp HOME.
// Speech and sounds are off (CLAUDE_ATTENTION_SILENT), no browser is launched
// (CLAUDE_ATTENTION_BROWSER_LOG) and no real server is started (NO_AUTOSTART).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineFor } from '../hooks/notify.mjs';
import { redact, sanitizeSpoken, fallbackLine, projectName } from '../lib/explain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERMISSION = path.join(ROOT, 'hooks', 'permission.mjs');
const NOTIFY = path.join(ROOT, 'hooks', 'notify.mjs');
const SESSION = '3f2a9c1e-7b44-4c1d-9a0e-5d6f7a8b9c0d';

let home;
before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-hooks-')); });
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function baseEnv(extra = {}) {
  return {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: path.join(home, 'my-project'),
    CLAUDE_ATTENTION_SILENT: '1', CLAUDE_ATTENTION_NO_AUTOSTART: '1', CLAUDE_ATTENTION_PORT: '39882', ...extra,
  };
}

function runHook(script, payload, extra) {
  return spawnSync(process.execPath, [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true, env: baseEnv(extra),
  });
}

const bash = (description, command = 'docker stop proxy') => ({
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: SESSION, tool_input: { command, description },
});

function writeConfig(cfg) {
  fs.mkdirSync(path.join(home, '.claude-attention'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-attention', 'config.json'), JSON.stringify(cfg));
}
const clearConfig = () => fs.rmSync(path.join(home, '.claude-attention', 'config.json'), { force: true });

describe('permission hook: the spoken explanation', () => {
  let fake, log;
  before(() => {
    fake = path.join(home, 'fake-claude.mjs');
    log = path.join(home, 'fake-claude.log');
    fs.writeFileSync(fake, [
      "import fs from 'node:fs';",
      "const input = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input }));",
      "if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));",
      "process.stdout.write(process.env.FAKE_OUT || '');",
    ].join('\n'));
  });
  const dry = (payload, extra = {}) => runHook(PERMISSION, payload, {
    CLAUDE_ATTENTION_DRYRUN: '1', CLAUDE_ATTENTION_CLAUDE_BIN: fake, FAKE_LOG: log, CLAUDE_ATTENTION_EXPLAIN_TIMEOUT_MS: '5000', ...extra,
  });

  test("speaks the model's explanation, with the prompt on stdin and safe-mode Haiku", () => {
    const r = dry(bash('Stop the proxy'), { FAKE_OUT: 'My project wants to stop a helper service. Saying yes stops it.' });
    assert.equal(r.stdout.trim(), 'My project wants to stop a helper service. Saying yes stops it.');
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepEqual(seen.argv, ['-p', '--safe-mode', '--model', 'haiku', '--no-session-persistence', '--tools', '']);
    assert.ok(seen.input.includes('docker stop proxy'));
    assert.ok(seen.input.includes('Call Claude "My project"'));
  });

  test("the model's risk is shown, but never below the rules' floor", () => {
    const r = dry(bash('Stop the proxy'), { CLAUDE_ATTENTION_DRYRUN: 'risk', FAKE_OUT: 'RISK: critical | takes the site down\nMy project wants to stop the site.' });
    assert.equal(r.stdout.trim(), 'critical | takes the site down | My project wants to stop the site.');
    const low = dry(bash('Stop the proxy'), { CLAUDE_ATTENTION_DRYRUN: 'risk', FAKE_OUT: 'RISK: low | harmless\nMy project wants to stop the site.' });
    assert.match(low.stdout, /^high \| stops or changes running services \|/);
    const ai = dry(bash('List files', 'ls'), { CLAUDE_ATTENTION_DRYRUN: 'risk', CLAUDE_ATTENTION_AI: '0' });
    assert.equal(ai.stdout.trim(), 'low | only reads | My project wants to run a command: List files');
  });

  test('secrets are masked before they reach the model', () => {
    dry(bash('Call the API', 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x?api_key=SECRETVALUE123'), { FAKE_OUT: 'My project wants to call a service.' });
    const { input } = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(!input.includes('abcdefghijklmnop'));
    assert.ok(!input.includes('SECRETVALUE123'));
  });

  test('model failure, empty output or AI off falls back to the description', () => {
    assert.equal(dry(bash('Stop the proxy'), { FAKE_EXIT: '1' }).stdout.trim(), 'My project wants to run a command: Stop the proxy');
    assert.equal(dry(bash('Stop the proxy'), { FAKE_OUT: '' }).stdout.trim(), 'My project wants to run a command: Stop the proxy');
    assert.equal(dry(bash('Stop the proxy'), { CLAUDE_ATTENTION_AI: '0', FAKE_OUT: 'should not be used here' }).stdout.trim(),
      'My project wants to run a command: Stop the proxy');
  });

  test('switched off globally, per project, or muted: silent', () => {
    try {
      writeConfig({ enabled: false });
      assert.equal(dry(bash('x'), { FAKE_OUT: 'My project wants to do x.' }).stdout, '');
      clearConfig();
      const proj = path.join(home, 'my-project', '.claude');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'claude-attention.json'), '{"enabled":false}');
      assert.equal(dry(bash('x'), { FAKE_OUT: 'My project wants to do x.' }).stdout, '');
      fs.rmSync(path.join(proj, 'claude-attention.json'));
      fs.writeFileSync(path.join(home, '.agentvibes-muted'), '');
      assert.equal(dry(bash('x'), { FAKE_OUT: 'My project wants to do x.' }).stdout, '');
    } finally {
      clearConfig();
      fs.rmSync(path.join(home, '.agentvibes-muted'), { force: true });
    }
  });

  test('other events, AskUserQuestion, bad input and its own model run are ignored', () => {
    for (const p of [{ hook_event_name: 'Stop' }, { ...bash('x'), tool_name: 'AskUserQuestion' }, 'not json', '[]', '']) {
      const r = dry(p, { FAKE_OUT: 'My project wants to do x.' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
    assert.equal(dry(bash('x'), { CLAUDE_ATTENTION_EXPLAINING: '1', FAKE_OUT: 'nope' }).stdout, '');
  });

  test('without dry-run nothing is written to stdout (it could be read as a decision)', () => {
    // Its detached speak stage outlives this test: give it a folder of its own.
    const r = runHook(PERMISSION, bash('x'), { CLAUDE_ATTENTION_AI: '0', CLAUDE_ATTENTION_HOME: path.join(home, 'detached') });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('explain helpers', () => {
  test('nothing path-, URL- or token-like is spoken', () => {
    assert.equal(sanitizeSpoken('Claude wants to open https://x.y/z and edit C:\\a\\b\\c.txt now'), 'Claude wants to open a web address and edit now');
    assert.ok(!redact('password=hunter2 token: abc').includes('hunter2'));
  });

  test('fallback lines name the tool, never the command', () => {
    assert.equal(fallbackLine({ tool_name: 'Edit', tool_input: { file_path: '/a/b/app.js' } }, 'Shop'), 'Shop wants to edit app.js');
    assert.equal(fallbackLine({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x' } }), 'Claude wants to open a web page on example.com');
    assert.equal(fallbackLine({ tool_name: 'mcp__claude_ai_Gmail__send_message' }), 'Claude wants to use send message from Gmail');
    assert.equal(fallbackLine({}), 'Claude needs your permission');
  });

  test('project name: AgentVibes pretext, else the folder', () => {
    const dir = path.join(home, 'shop_front');
    assert.equal(projectName(dir), 'Shop front');
    fs.mkdirSync(path.join(dir, '.claude', 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'config', 'tts-pretext.txt'), 'Efblockmexico here');
    assert.equal(projectName(dir), 'Efblockmexico');
    assert.equal(projectName(''), 'Claude');
  });
});

describe('permission hook: card, window and answer', () => {
  let server, port, received, answers, viewers;
  before(async () => {
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        const json = (s, body) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/health') return json(200, { app: 'claude-attention' });
        if (req.url === '/attention' && req.method === 'POST') { received.push(JSON.parse(b)); return json(200, { id: 'x', viewers }); }
        if (req.url === '/attention/answer' && req.method === 'POST') { answers.push(JSON.parse(b)); return json(200, { ok: true }); }
        return json(404, {});
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise(r => server.close(r)));

  const logPath = () => path.join(home, '.claude-attention', 'attention-log.jsonl');
  const browserLog = () => path.join(home, 'browser.log');

  async function speakStage({ extra = {}, env = {}, withServer = true } = {}) {
    received = []; answers = [];
    fs.rmSync(path.join(home, '.claude-attention', 'window.last'), { force: true });
    fs.rmSync(browserLog(), { force: true });
    fs.rmSync(logPath(), { force: true });
    const tmp = path.join(home, '.claude-attention', 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const payload = path.join(tmp, `permission-test${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(payload, JSON.stringify({ ...bash('Stop the docker proxy'), ...extra }));
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [PERMISSION, '--speak', payload], {
        windowsHide: true, stdio: 'ignore',
        env: baseEnv({
          CLAUDE_ATTENTION_AI: '0', CLAUDE_ATTENTION_PORT: String(withServer ? port : 39883),
          CLAUDE_ATTENTION_BROWSER_LOG: browserLog(), ...env,
        }),
      }).on('close', resolve);
    });
    const log = fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    return { code, payload, log, opened: fs.existsSync(browserLog()) ? fs.readFileSync(browserLog(), 'utf8').trim() : '' };
  }

  test('posts the card, logs it, and opens the window when none is open', async () => {
    viewers = 0;
    const r = await speakStage();
    assert.equal(r.code, 0);
    const { id, ...card } = received[0];
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.deepEqual(card, {
      line: 'My project wants to run a command: Stop the docker proxy', summary: 'Stop the docker proxy', tool: 'Bash',
      project: 'my-project', cwd: path.resolve(home, 'my-project'), sessionId: SESSION,
      risk: 'high', riskReason: 'stops or changes running services', voice: '', provider: '',
    });
    assert.equal(r.log[0].type, 'card');
    assert.equal(r.log[0].card.id, id);
    assert.equal(r.opened, `http://127.0.0.1:${port}/`);
    assert.equal(fs.existsSync(r.payload), false);
  });

  test('an open window is reused; window off opens none', async () => {
    viewers = 1;
    assert.equal((await speakStage()).opened, '');
    viewers = 0;
    try {
      writeConfig({ window: false });
      const r = await speakStage();
      assert.equal(received.length, 1);
      assert.equal(r.opened, '');
    } finally { clearConfig(); }
  });

  test('server down: the card is still in the log, no window, exit 0', async () => {
    const r = await speakStage({ withServer: false });
    assert.equal(r.code, 0);
    assert.equal(r.opened, '');
    assert.equal(r.log.length, 1);
  });

  test('the command never reaches the card or the log', async () => {
    viewers = 1;
    await speakStage();
    assert.ok(!JSON.stringify(received[0]).includes('docker stop proxy'));
    assert.ok(!fs.readFileSync(logPath(), 'utf8').includes('docker stop proxy'));
  });

  function transcript(name) {
    const file = path.join(home, '.claude', 'projects', 'demo', `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [
      { type: 'tool_use', id: 'toolu_target', name: 'Bash', input: { command: 'docker stop proxy', description: 'Stop the docker proxy' } }] } })}\n`);
    return file;
  }
  let answeredAt;
  const result = denied => `${JSON.stringify({
    type: 'user', timestamp: new Date(answeredAt = Date.now()).toISOString(),
    toolUseResult: denied ? 'User rejected tool use' : { stdout: 'proxy' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_target', is_error: denied,
      content: denied ? "The user doesn't want to proceed with this tool use." : 'proxy' }] },
  })}\n`;
  const WATCH = { CLAUDE_ATTENTION_WATCH_MS: '8000', CLAUDE_ATTENTION_POLL_MS: '50' };

  for (const denied of [false, true]) {
    test(`records a ${denied ? 'denied' : 'allowed'} answer on the card and in the log`, async () => {
      viewers = 1;
      const file = transcript(`answer-${denied}`);
      // Answered while the hook is running: the result lands after it starts watching.
      const timer = setTimeout(() => fs.appendFileSync(file, result(denied)), 400);
      let r;
      try { r = await speakStage({ extra: { transcript_path: file }, env: WATCH }); } finally { clearTimeout(timer); }
      const want = { id: received[0].id, answer: denied ? 'denied' : 'allowed', answeredAt };
      assert.deepEqual(answers, [want]);
      assert.deepEqual(r.log[1], { type: 'answer', ...want });
    });
  }

  test('no answer in the watch window, or a transcript outside the projects folder: no answer', async () => {
    viewers = 1;
    await speakStage({ extra: { transcript_path: transcript('unanswered') }, env: { ...WATCH, CLAUDE_ATTENTION_WATCH_MS: '300' } });
    assert.equal(answers.length, 0);
    const outside = path.join(home, 'elsewhere.jsonl');
    fs.writeFileSync(outside, result(false));
    await speakStage({ extra: { transcript_path: outside }, env: WATCH });
    assert.equal(answers.length, 0);
  });
});

describe('notify hook', () => {
  test('lines: question with options, idle, permission tool name only', () => {
    assert.deepEqual(lineFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [
      { question: 'Which **database**?', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }] }, { question: 'More?' }] } }),
    { kind: 'question', line: 'Which database? Options: Postgres, SQLite, or MySQL. And 1 more question' });
    assert.deepEqual(lineFor({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
      { kind: 'idle', line: 'Claude is waiting for your input' });
    assert.equal(lineFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use mcp__srv__send_mail' }).line, 'Permission needed: send mail');
    assert.equal(lineFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash; rm -rf /' }).line, 'Claude needs your permission');
    assert.equal(lineFor({ hook_event_name: 'Stop' }), null);
  });

  test('a question is spoken; a permission prompt right after it is not', () => {
    const q = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship it?' }] } };
    const p = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' };
    assert.equal(runHook(NOTIFY, q, { CLAUDE_ATTENTION_DRYRUN: '1' }).stdout.trim(), 'Ship it?');
    assert.equal(runHook(NOTIFY, p, { CLAUDE_ATTENTION_DRYRUN: '1' }).stdout, '');
  });

  test('switched off: silent; never writes stdout without dry-run', () => {
    const idle = { hook_event_name: 'Notification', notification_type: 'idle_prompt' };
    try {
      writeConfig({ enabled: false });
      assert.equal(runHook(NOTIFY, idle, { CLAUDE_ATTENTION_DRYRUN: '1' }).stdout, '');
    } finally { clearConfig(); }
    const r = runHook(NOTIFY, idle);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
