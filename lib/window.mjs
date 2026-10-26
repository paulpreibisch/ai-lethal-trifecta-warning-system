// window.mjs — the hook's side of the cards server: make sure it is running,
// post cards and answers to it, and open the cards window when none is open.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WINDOWS, ROOT, dataDir, exists, readTrim } from './common.mjs';

export const serverUrl = port => `http://127.0.0.1:${port}`;

async function getJson(url, ms = 800) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function postJson(port, route, body) {
  try {
    const r = await fetch(`${serverUrl(port)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// True only when this tool's own server answers (not some other app on the port).
export async function isUp(port) {
  return (await getJson(`${serverUrl(port)}/health`))?.app === 'claude-attention';
}

// Starts the server in the background (hidden, outliving the hook) unless it is
// already up. CLAUDE_ATTENTION_NO_AUTOSTART=1 turns this off (tests).
export async function ensureServer(port) {
  if (await isUp(port)) return true;
  if (process.env.CLAUDE_ATTENTION_NO_AUTOSTART === '1') return false;
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CLAUDE_ATTENTION_PORT: String(port) },
    });
    child.unref();
  } catch { return false; }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await isUp(port)) return true;
  }
  return false;
}

function browserCandidates() {
  if (IS_WINDOWS) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ].filter(exists).map(exe => [exe, []]);
  }
  if (process.platform === 'darwin') {
    return [['open', ['-na', 'Google Chrome', '--args']], ['open', ['-na', 'Microsoft Edge', '--args']]];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(b => [b, []]);
}

// Opens the cards page in a new Chrome (or Edge) window, address bar included.
// CLAUDE_ATTENTION_BROWSER_LOG records the URL instead (tests).
export async function openWindow(url) {
  const log = process.env.CLAUDE_ATTENTION_BROWSER_LOG;
  if (log) { fs.appendFileSync(log, `${url}\n`); return true; }
  for (const [cmd, pre] of browserCandidates()) {
    const ok = await new Promise(resolve => {
      let child;
      try {
        child = spawn(cmd, [...pre, '--new-window', url], { detached: true, stdio: 'ignore', windowsHide: true });
      } catch { resolve(false); return; }
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    });
    if (ok) return true;
  }
  return false;
}

// Opens the window unless one is open, or one was opened moments ago and has not
// connected yet.
export async function maybeOpenWindow(port, viewers, hash = '') {
  if (viewers !== 0) return false;
  const stamp = path.join(dataDir(), 'window.last');
  if (Date.now() - (Number(readTrim(stamp)) || 0) < 15000) return false;
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(stamp, String(Date.now())); } catch { /* best effort */ }
  return openWindow(`${serverUrl(port)}/${hash}`);
}

// Brings an already open cards window to the front (Windows only; a best effort, since the
// system may refuse to let one window take the focus from another). CLAUDE_ATTENTION_NO_FOCUS=1
// skips it (tests).
export function bringToFront() {
  if (!IS_WINDOWS || process.env.CLAUDE_ATTENTION_NO_FOCUS === '1') return false;
  const script = "$s = New-Object -ComObject WScript.Shell; $t = 'Claude ' + [char]0xB7 + ' Attention'; if (-not $s.AppActivate($t)) { $null = $s.AppActivate('Claude needs you') }";
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
