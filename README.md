# codex-claude-bridge

Tiny CLI bridge for Codex to control persistent Claude Code sessions without using the Claude Agent SDK.

It wraps [`claude-code-tmux`](https://www.npmjs.com/package/claude-code-tmux), which drives the real interactive `claude` CLI inside `tmux`. Sessions persist, Codex can send follow-up prompts, and work can continue without losing Claude Code context.

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

## Notes

This is terminal automation, not an official Claude API. It depends on `ccmux`, `tmux`, and the interactive Claude Code CLI's behavior.

State classification favors explicit evidence and conservative `unknown` over risky false positives. Spinner detection is glyph-agnostic (CC rotates through `*`, `✻`, `✶`, `✢`, etc.). Hook errors in scrollback do not flip a healthy live UI to `crashed`. Permission classification keys off the question text; generic yes/no menus stay `needs_input`.

On Windows, `patch-ccmux-windows` rewrites MSYS2/PowerShell path-quoting issues in `claude-code-tmux`:

- `pipe-pane` log path quoting
- `send-job` `load-buffer` path quoting
- `steer` `load-buffer` path quoting (added 2026-07-23)

`ccb steer` writes the message to a temp file, loads it into a tmux buffer, and pastes with `-dpr` (delete + bracket paste + preserve newlines) so multiline messages survive end-to-end.
