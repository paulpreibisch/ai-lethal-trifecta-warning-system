// voice.mjs — the knock sound and the spoken line.
//
// Speech goes through AgentVibes when it is installed (its play-tts, with this
// tool's own explainer voice so it never sounds like a project's character), and
// through the computer's built-in voice otherwise: Windows System.Speech, macOS
// `say`, Linux spd-say or espeak. The text is always one argv element or an
// environment variable, never part of a command string.

import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, ROOT, home, dataDir, exists, isSilent, run } from './common.mjs';

function wavs(dir) {
  try { return fs.readdirSync(dir).filter(f => /\.wav$/i.test(f)).map(f => path.join(dir, f)); } catch { return []; }
}

// A random sound: the user's own (~/.claude-attention/sounds) first, else the
// bundled Rakazo knocks.
export function pickSound() {
  for (const dir of [path.join(dataDir(), 'sounds'), path.join(ROOT, 'sounds')]) {
    const list = wavs(dir);
    if (list.length) return list[Math.floor(Math.random() * list.length)];
  }
  return null;
}

export async function playSound() {
  const file = pickSound();
  if (!file || isSilent()) return;
  const players = IS_WINDOWS
    ? [['ffplay', ['-autoexit', '-nodisp', '-loglevel', 'quiet', file]],
       ['powershell', ['-NoProfile', '-Command', '(New-Object Media.SoundPlayer $env:CA_SOUND).PlaySync()']]]
    : [['afplay', [file]], ['paplay', [file]], ['aplay', ['-q', file]],
       ['ffplay', ['-autoexit', '-nodisp', '-loglevel', 'quiet', file]]];
  for (const [cmd, args] of players) {
    if (await run(cmd, args, { ...process.env, CA_SOUND: file })) return;
  }
}

// AgentVibes' player, project copy first, then the global one.
export function agentVibesPlayer(projectDir) {
  const rel = IS_WINDOWS ? ['hooks-windows', 'play-tts.ps1'] : ['hooks', 'play-tts.sh'];
  return [projectDir && path.join(projectDir, '.claude', ...rel), path.join(home(), '.claude', ...rel)]
    .find(p => p && exists(p)) || null;
}

async function speakAgentVibes(player, line, { voice, provider }, projectDir) {
  if (IS_WINDOWS) {
    // No -llm: the claude-code row would put the project's Claude voice back.
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', player, line];
    if (voice) args.push('-VoiceOverride', voice);
    if (provider) args.push('-ProviderOverride', provider);
    if (projectDir) args.push('-ProjectDir', projectDir);
    return run('powershell', args);
  }
  const args = [player, line];
  if (voice) args.push(voice);
  if (projectDir) args.push('--project-dir', projectDir);
  return run('bash', args);
}

async function speakSystem(line) {
  if (IS_WINDOWS) {
    const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
      + "try { $s.SelectVoiceByHints('Female') } catch {}; $s.Speak($env:CA_TEXT)";
    return run('powershell', ['-NoProfile', '-Command', script], { ...process.env, CA_TEXT: line });
  }
  if (process.platform === 'darwin') return run('say', ['--', line]);
  return (await run('spd-say', ['-w', '--', line])) || run('espeak', ['--', line]);
}

// Which voice speaks: 'agentvibes' or 'system' (the card shows it).
export function voiceEngine(projectDir) {
  return agentVibesPlayer(projectDir) ? 'agentvibes' : 'system';
}

export async function speak(line, cfg, projectDir) {
  if (!line || isSilent()) return;
  const player = agentVibesPlayer(projectDir);
  if (player && await speakAgentVibes(player, line, cfg, projectDir)) return;
  await speakSystem(line);
}
