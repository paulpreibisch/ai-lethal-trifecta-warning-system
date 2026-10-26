# 🛡️ ai-lethal-trifecta-warning-system

**When Claude Code stops and waits on you, you hear it, and you see why.**

Named after Simon Willison's **"lethal trifecta"**: a request turns dangerous the moment it
mixes three things in one session — private data, untrusted text, and the power to act. This
tool spots that combination before it runs and tells you, out loud and on screen.

## ✨ What it does

- 🔊 **Permission prompts are explained out loud, in plain words.** A knock sound plays, then
  a voice says what Claude wants to do, why, and what saying yes changes
  ("Shop wants to take the bot dashboard offline on your server. Saying yes makes the
  site stop working for everyone."). Haiku writes the sentence from the tool input and
  Claude's last message; secrets are masked before anything is sent.
- 🗂️ **Each prompt becomes a card in a browser window**: the explanation, Claude's own
  one-line note, the project folder, the session ID and a ready-to-paste
  `cd "<folder>" && claude --resume <session>`, the exact date and time, and a play
  button.
- ✅❌ **Your answer is recorded on the card**: a green ✓ Allowed or red ✗ Denied with the
  time, read from the session transcript.
- 💾 **Nothing disappears**: every card and answer is kept in
  `~/.claude-attention/attention-log.jsonl`.
- 🧭 **A second tab, "New Claude Request"**: every question you type to Claude Code, newest
  first, one card each with the session ID, folder, date and time and the prompt as asked
  (copyable). Beside it are two flows: how the request runs today (with lamps for private
  data, stranger text and the power to act, and a play button that walks it through), and a
  safer route with a rewritten prompt to copy. It reads your own transcripts under
  `~/.claude/projects`, keeps nothing, and masks key-like strings. The routing comes from
  simple pattern rules on the words typed, not from a model, so treat it as a prompt to
  think, not a verdict.
  - 🔎 **Search** across every question, reply, folder and session, right in the tab.
  - 🌀 **Routine folding** — the same request run over and over by a scheduled job collapses
    into one "⟲ ROUTINE ×N" folder instead of flooding the list, with every run still a
    click away.
- ⏱️ **An optional pre-check**: `claude-attention precheck show` (or `hold`) adds a
  `UserPromptSubmit` hook. When you press Enter on a risky prompt it opens the New Claude
  Request tab, brings the window forward and highlights that prompt's card before Claude gets
  going. With `hold`, a high-risk prompt is held once with the advice and runs when you send
  the same text again. It only acts for you typing in an attended terminal session, never for
  `claude -p` or scheduled jobs. `precheck off` removes it; `precheck level|rules|focus` tune it.
- 🚫 **`protect`**: a stricter, independent switch. `claude-attention protect on` stops a
  prompt outright the instant it mixes all three legs of the lethal trifecta (private data,
  untrusted text, the power to act), explains why, and lets you send the same text again to go
  ahead anyway. Works whatever `precheck` is set to, even off, and stays silent otherwise.
  `protect off` turns it back off. (`/protect` and `/protect-off` from Claude Code.)
- ☠️ **Prompt-injection flag**: a request card whose text matches classic injection phrasing
  ("ignore previous instructions", "reveal your system prompt", etc.) gets a hazard-tape box
  showing the exact matched text, so it's obvious at a glance when something you pasted or
  fetched was trying to talk to Claude instead of to you.
- 🙋 **Questions and waiting are spoken too**: when Claude asks you a question
  (AskUserQuestion) you hear the question and its options; when it is waiting for input, you
  hear that.

## 🚀 Install

Needs Node 20+ and Claude Code.

```bash
git clone git@github.com:paulpreibisch/ai-lethal-trifecta-warning-system.git
cd ai-lethal-trifecta-warning-system
node bin/claude-attention.mjs install
```

This adds three hooks to `~/.claude/settings.json` (backed up first; other hooks are
left alone) and `/attention`, `/precheck`, `/protect` and `/protect-off` slash commands.
The hooks run from this folder, so keep it where it is.
`node bin/claude-attention.mjs uninstall` takes them out again.

The "safer route" suggestions for risky prompts (precheck's "Do this instead" and
`/protect`'s message) point at `%USERPROFILE%\lockdown\agent.cmd` and `research.cmd` —
sandboxed Docker launchers that are **not part of this repo**. They're a reference to one
way to build that sandbox (a container with no secrets, no SSH keys, no LAN route, and
internet only through an allow-listed proxy); if you don't have something like that set up,
treat those two lines as "run this in an isolated environment," not a literal command. The
**Initial Setup** tab in the browser UI walks through building one from scratch, for any OS.

If AgentVibes already speaks prompts (its `speak-permission` / `speak-attention`
hooks), install with `--take-over-agentvibes` so they aren't spoken twice.

## 🔈 Voice

With [AgentVibes](https://github.com/paulpreibisch/AgentVibes) installed, prompts are
spoken by its engine in the explainer's own voice (Kokoro `af_heart` by default; change
with `voice <name> [provider]`), and the card's play button replays in that voice
while the AgentVibes viewport is running. Without it, the computer's built-in voice is
used (Windows speech, macOS `say`, Linux `spd-say`/`espeak`), and the play button uses
the browser's voice.

## 🎛️ Switches

From Claude Code: `/attention <command>`; from a shell: `node bin/claude-attention.mjs <command>`.

| Command | |
|---|---|
| `status` | what is installed, running and recorded |
| `on` / `off` | spoken prompts (default on) |
| `window on` / `window off` | the cards window (default on) |
| `explain on` / `explain off` | Haiku explanations; off speaks a line built from the tool input |
| `voice <name> [provider]` | the AgentVibes voice for explanations |
| `open` | open the cards window now |
| `precheck show` / `hold` / `off` | pre-check a prompt before it runs (see above) |
| `protect on` / `off` | stop the lethal trifecta outright, whatever precheck is set to |

A project can opt out with `.claude/claude-attention.json` containing `{"enabled": false}`.
AgentVibes' mute silences it too.

## ⚙️ How it works

| Part | |
|---|---|
| `hooks/permission.mjs` | `PermissionRequest`: returns at once (never writes stdout, which Claude Code could read as a decision); a hidden background process explains, posts the card, speaks, then follows the transcript for your answer (up to 2 hours) |
| `hooks/notify.mjs` | `Notification` + `PreToolUse(AskUserQuestion)`: questions, idle waits, and permission prompts the explainer didn't cover |
| `server/server.mjs` | the cards server on `127.0.0.1:3790`, started by the hooks when needed; loads the log on start |
| `public/` | the cards window; reloads itself when its files change and catches up after a restart |
| `lib/prompts.mjs`, `public/flow.js`, `public/requests.js` | the New Claude Request tab: the reader of your transcripts, the routing rules, and the cards |

The transcript is only read from under `~/.claude/projects`. The command itself never
reaches a card or the log.

## 🧪 Development

```bash
npm test
```

Tests run against temp home folders, with sound and speech off and no browser launched.

## 🙏 Credits

Built by [Paul Preibisch](https://github.com/paulpreibisch). The knock sounds are from the
Rakazo mobile app, also by Paul Preibisch (Apache-2.0); see `sounds/CREDITS.txt`.
