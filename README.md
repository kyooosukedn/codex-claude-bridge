# codex-claude-bridge

Tiny CLI bridge for Codex to control persistent Claude Code sessions without using the Claude Agent SDK.

It wraps [`claude-code-tmux`](https://www.npmjs.com/package/claude-code-tmux), which drives the real interactive `claude` CLI inside `tmux`. That means sessions persist, Codex can send follow-up prompts, and work can continue without losing Claude Code context.

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

## Commands

```text
ccb doctor [--json]
ccb patch-ccmux-windows
ccb start [--session NAME] [--cwd DIR]
ccb send [--session NAME] [--cwd DIR] [--timeout-ms MS] "prompt"
ccb steer [--session NAME] "message"
ccb capture [--session NAME] [--lines N]
ccb status
ccb kill [--session NAME]
```

## Codex Usage

From Codex, use:

```powershell
ccb send --session repo-task --cwd C:\path\to\repo --timeout-ms 180000 "Do the task. When done, summarize files changed and tests run."
```

The same `--session` keeps talking to the same Claude Code tmux session.

## Notes

This is terminal automation, not an official Claude API. It is practical and durable, but depends on `ccmux`, `tmux`, and the interactive Claude Code CLI behavior.

On Windows, `patch-ccmux-windows` fixes current MSYS2/PowerShell path and quoting issues in `claude-code-tmux`.
