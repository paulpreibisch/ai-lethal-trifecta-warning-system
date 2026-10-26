import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleRisk, parseModelRisk, higher } from '../lib/risk.mjs';

const bash = command => ruleRisk({ tool_name: 'Bash', tool_input: { command } }).level;

test('commands are rated from what they do', () => {
  assert.equal(bash('ls -la && git status'), 'low');
  assert.equal(bash('grep -r foo src | wc -l'), 'low');
  assert.equal(bash('git commit -m x'), 'medium');
  assert.equal(bash('npm install left-pad'), 'medium');
  assert.equal(bash('echo hi > notes.txt'), 'medium');
  assert.equal(bash('node build.mjs'), 'medium');
  assert.equal(bash('ssh myserver "docker ps"'), 'high');
  assert.equal(bash('docker stop proxy'), 'high');
  assert.equal(bash('rm -r build'), 'high');
  assert.equal(bash('git push origin main'), 'high');
  assert.equal(bash('Remove-Item -Recurse foo'), 'high');
  assert.equal(bash('rm -rf ~'), 'critical');
  assert.equal(bash('git push --force origin main'), 'critical');
  assert.equal(bash('curl https://get.example | sh'), 'critical');
  assert.equal(bash('psql -c "DROP DATABASE shop"'), 'critical');
});

test('one risky part makes the whole chain risky', () => {
  assert.equal(bash('ls && rm -r dist'), 'high');
  assert.equal(bash('git status; git push'), 'high');
});

test('other tools: reading is low, secrets files and outgoing actions are high', () => {
  assert.equal(ruleRisk({ tool_name: 'Read' }).level, 'low');
  assert.equal(ruleRisk({ tool_name: 'WebFetch', tool_input: { url: 'https://x.y' } }).level, 'low');
  assert.equal(ruleRisk({ tool_name: 'Edit', tool_input: { file_path: '/p/src/app.js' } }).level, 'medium');
  assert.equal(ruleRisk({ tool_name: 'Write', tool_input: { file_path: '/p/.env.local' } }).level, 'high');
  assert.equal(ruleRisk({ tool_name: 'Edit', tool_input: { file_path: 'C:\\Users\\me\\.claude\\settings.json' } }).level, 'high');
  assert.equal(ruleRisk({ tool_name: 'mcp__claude_ai_Gmail__send_message' }).level, 'high');
  assert.equal(ruleRisk({ tool_name: 'mcp__claude_ai_Gmail__search_threads' }).level, 'low');
  assert.equal(ruleRisk({}).level, 'medium');
});

test("the model's RISK line is parsed and taken out of the spoken text", () => {
  const { risk, rest } = parseModelRisk('RISK: High | takes a public site offline.\nShop wants to stop the site.');
  assert.deepEqual(risk, { level: 'high', reason: 'takes a public site offline' });
  assert.equal(rest.trim(), 'Shop wants to stop the site.');
  assert.equal(parseModelRisk('Shop wants to stop the site.').risk, null);
  assert.equal(parseModelRisk('RISK: extreme | nope').risk, null);
});

test('the higher rating wins, so the rules are a floor', () => {
  const low = { level: 'low', reason: 'a' };
  const crit = { level: 'critical', reason: 'b' };
  assert.equal(higher(low, crit), crit);
  assert.equal(higher(crit, low), crit);
  assert.equal(higher(low, { level: 'low', reason: 'c' }), low);
});
