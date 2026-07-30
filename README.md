# codex-claude-bridge

Tiny CLI bridge for Codex to control persistent Claude Code sessions without using the Claude Agent SDK.

It wraps [`claude-code-tmux`](https://www.npmjs.com/package/claude-code-tmux), which drives the real interactive `claude` CLI inside `tmux`. Sessions persist, Codex can send follow-up prompts, and work can continue without losing Claude Code context.

## How it works

`ccb` is a short-lived Node CLI. Its interactive transport starts `ccmux` or `tmux` with an explicit argv vector and `shell: false`; prompt text never becomes shell syntax. A local command journal preserves injection state across invocations without storing prompt text. `ccb` never speaks to the Anthropic API. Authentication, billing, model selection, and policy remain controlled by Claude Code and your Anthropic account.

The classifier reads `ccmux capture` output, strips ANSI, and matches conservative signals for `idle`, `thinking`, `needs_input`, `permission_prompt`, `done`, `crashed`, or `unknown`. When evidence is weak, it returns `unknown` rather than guessing.

## Documentation

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — end-to-end mechanism, command taxonomy, classifier precedence, multiline steer implementation, Windows patch.
- [RELIABILITY.md](./docs/RELIABILITY.md) — honest maturity assessment, what is and is not tested, known limitations, failure modes, suggested next tests.
- [OPERATIONS.md](./docs/OPERATIONS.md) — install/upgrade, multi-chat sessions, orchestration loop, recovery runbook, troubleshooting, cleanup.

## Maturity

**Early. Usable for careful, supervised automation. Not yet production-grade.**

The core read paths (capture, classify `idle`/`thinking`/`done`, multiline `steer`, refusal on non-prompt states) are covered by automated tests and by live smoke against real `tmux` sessions on Windows. The riskier paths — real Claude Code permission popups, crash recovery, and non-Windows platforms — are covered by synthetic fixtures only and have never been exercised end-to-end with this bridge. Treat it the way you would treat any terminal automation tool: useful for the loops it handles, but not something to leave running unattended against a session you care about until you have verified your specific usage on your platform. See [RELIABILITY.md](./docs/RELIABILITY.md) for the full test matrix and confidence labels.

## Install

```bash
npm install -g github:kyooosukedn/codex-claude-bridge
pi install npm:claude-code-tmux
```

Requirements:

- `claude` CLI installed and logged in
- `ccmux` from `claude-code-tmux`
- `tmux`
- Windows: MSYS2 tmux at `C:\msys64\usr\bin\tmux.exe` works

## Quick Start

```bash
ccb doctor
ccb patch-ccmux-windows
ccb send "Inspect this repo and summarize it."
```

Use named persistent sessions:

```bash
ccb send --session auth-fix --cwd C:\repo\app "Fix auth tests. Keep scope small."
ccb send --session auth-fix "Continue. Now run the focused tests."
ccb capture --session auth-fix
```

## Inspecting and Acting on the Pane

`ccb inspect` captures the pane, strips ANSI noise, and classifies Claude Code's current state. It only reads.

```bash
ccb inspect --session auth-fix
ccb inspect --session auth-fix --json
```

States: `idle`, `thinking`, `needs_input`, `permission_prompt`, `done`, `crashed`, `unknown`.

`ccb approve` and `ccb deny` inspect first, refuse with a nonzero exit when there is no prompt, and pick the semantically correct option by label. They never blindly assume positions. For unnumbered cursor menus they navigate with Up/Down from the current selection. When the cursor or target is ambiguous they refuse; fall back to `ccb choose N`.

```bash
ccb approve --session auth-fix
ccb deny   --session auth-fix
ccb choose --session auth-fix 2     # raw escape hatch
```

`ccb watch` polls the pane and emits only state transitions. With `--json` it emits JSON Lines.

```bash
ccb watch --session auth-fix --json --timeout-ms 600000
```

## Commands

```text
ccb doctor [--json]
ccb patch-ccmux-windows
ccb start [--session NAME] [--cwd DIR] [--model MODEL] [--effort LEVEL] [--safe-permissions]
ccb send [--session NAME] [--cwd DIR] [--timeout-ms MS] [--startup-wait-ms MS] "prompt"
ccb type [--session NAME] [--enter] "raw message"
ccb slash [--session NAME] "command"
ccb steer [--session NAME] "message"
ccb commands [--session NAME] [--json]
ccb command-status ID [--json]
ccb inspect [--session NAME] [--lines N] [--json]
ccb approve [--session NAME] [--lines N] [--json]
ccb deny   [--session NAME] [--lines N] [--json]
ccb watch [--session NAME] [--interval-ms MS] [--lines N] [--json] [--timeout-ms MS]
ccb key [--session NAME] KEY [KEY...]
ccb choose [--session NAME] NUMBER
ccb enter [--session NAME]
ccb escape [--session NAME]
ccb interrupt [--session NAME]
ccb capture [--session NAME] [--lines N]
ccb wait-ready [--session NAME] [--timeout-ms MS]
ccb status
ccb sessions
ccb jobs
ccb attach [--session NAME]
ccb kill [--session NAME]
```

## Codex Usage

```powershell
ccb send --session repo-task --cwd C:\path\to\repo --timeout-ms 180000 "Do the task. When done, summarize files changed and tests run."
ccb watch --session repo-task --json --timeout-ms 600000
```

The same `--session` keeps talking to the same Claude Code tmux session.

## Development

```bash
npm test         # parsing and classification tests
npm run check    # tests + --help + doctor smoke
```

Pure parsing and classification logic lives in `lib/pane.mjs`. Multiline steer helpers live in `lib/steer.mjs`. Tests use canned pane fixtures in `test/`.

Transport resolution lives in `lib/transport.mjs`. Durable command records live under `~/.codex-claude-bridge/journal` by default; set `CCB_HOME` to move bridge state.

## Notes

This is terminal automation, not an official Claude API. It depends on `ccmux`, `tmux`, and the interactive Claude Code CLI's behavior.

State classification favors explicit evidence and conservative `unknown` over risky false positives. Spinner detection is glyph-agnostic (CC rotates through `*`, `✻`, `✶`, `✢`, etc.). Hook errors in scrollback do not flip a healthy live UI to `crashed`. Permission classification keys off the question text; generic yes/no menus stay `needs_input`.

On Windows, `patch-ccmux-windows` rewrites MSYS2/PowerShell path-quoting issues in `claude-code-tmux`:

- `pipe-pane` log path quoting
- `send-job` `load-buffer` path quoting
- `steer` `load-buffer` path quoting (added 2026-07-23)

`ccb steer` streams the message to `tmux load-buffer` over stdin, then pastes with `-dpr` (delete + bracket paste + preserve newlines) so multiline messages survive end-to-end.
