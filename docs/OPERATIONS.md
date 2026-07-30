# Operations

How to install, drive, and recover `codex-claude-bridge` (`ccb`) in practice. This document assumes you have already read the [architecture overview](./ARCHITECTURE.md) and the [reliability assessment](./RELIABILITY.md). It is focused on what to type and what to do when something goes wrong.

Every command below is read-only unless it is explicitly marked as mutating. The mutating commands are `send`, `type`, `slash`, `steer`, `approve`, `deny`, `key`, `choose`, `enter`, `escape`, `interrupt`, `kill`, and the implicit start that happens the first time you target a new `--session` name.

## Install, upgrade, doctor

### Prerequisites

`ccb` is a thin wrapper. It does not ship `claude`, `tmux`, or `ccmux`. Install them first:

- The `claude` CLI, logged in to the account you want to drive.
- [`claude-code-tmux`](https://www.npmjs.com/package/claude-code-tmux) (`ccmux`). It owns the session registry and the completion protocol.
- `tmux`. On Windows, put the real MSYS2 `tmux.exe` on `PATH`; `C:\msys64\usr\bin\tmux.exe` is the tested layout.
- Node 22 or newer (the bridge uses the built-in `node:test` runner and modern ESM).

### Install the bridge

```bash
npm install -g github:kyooosukedn/codex-claude-bridge
pi install npm:claude-code-tmux
```

`ccb` itself has no runtime dependencies; the global install only adds the `ccb` shim and the `bin/codex-claude-bridge.mjs` script.

### First-run health check

```bash
ccb doctor
ccb doctor --json
```

`doctor` verifies that every external command can be resolved without a shell. It checks `node`, `npm`, `pi`, `claude`, `ccmux`, `tmux`, and the current platform. The `--json` form emits the same checks as one object.

`doctor` does **not** verify that the Windows `ccmux` patch is present (see [known limitations](./RELIABILITY.md#known-limitations)). After installing or upgrading `ccmux`, always run `ccb patch-ccmux-windows` next.

### Windows post-install patch

```bash
ccb patch-ccmux-windows
```

This rewrites the installed `claude-code-tmux/src/core.mjs` in place. The changes span six areas: a Windows-aware `shellQuote` and `msysPathForShell` helper, `pipe-pane` log path quoting, `send-job` load-buffer path quoting, the legacy upstream `steerSession` load-buffer path quoting (marked `// ccb-patched`), a Windows paste-visibility retry break, and a PowerShell Claude-launch prelude that honors `--cwd` and strips conflicting `ANTHROPIC_*` env vars. The patcher is idempotent; reruns report `changed: false` when no work is needed. See [architecture – Windows patch mechanism](./ARCHITECTURE.md#windows--msys2-patch-mechanism) for the full list.

On non-Windows platforms this command is a no-op; you do not need to run it.

### Upgrade flow

```bash
pi install npm:claude-code-tmux      # or npm install -g claude-code-tmux
ccb patch-ccmux-windows              # re-apply, required after every ccmux upgrade
npm install -g github:kyooosukedn/codex-claude-bridge
ccb doctor
```

Every reinstall or upgrade of `claude-code-tmux` overwrites the patched `core.mjs`. If you forget to re-run `patch-ccmux-windows`, the symptoms on Windows are typically that `ccb send` fails with a path-resolution error from `tmux load-buffer` (the `send-job` prompt file path reverts to a raw Windows path), or that `ccmux` cannot write its `pipe-pane` log. The bridge's own `ccb steer` is unaffected because it talks to `tmux` directly and does not use ccmux's `steerSession` path. The recovery is the one-line patch command above.

## Sessions across multiple Codex chats

A `--session NAME` is the only live-session handle you need. Two invocations with the same name talk to the same `tmux` session. They also share local lock and journal state, so separate Codex chats cannot inject into that session at the same time.

### Naming

`safeName(NAME)` preserves letters (case is kept), digits, underscore, dot, and dash; any other run of characters collapses to a single `-`; leading and trailing dashes are stripped; the result is truncated to 60 characters. The result is passed to `ccmux` as the session name and reused, with a `ccmux-` prefix, as the `tmux` session name. Pick names that are unique per logical job (`auth-fix`, `refactor-router`, `investigate-bug-42`) rather than per chat.

### First send auto-starts

`ccb send --session NAME "prompt"` checks whether the session is alive; if not, it calls `ccb start` for you with the same `--cwd` and `--safe-permissions` flags, then waits `--startup-wait-ms` (default `12000` ms) before sending the prompt. This is the common path.

If you need different start flags (a specific `--model` or `--effort`), call `ccb start` explicitly the first time:

```bash
ccb start --session auth-fix --cwd /repo/app --model opus --effort high --safe-permissions
ccb send   --session auth-fix "Inspect the auth flow and propose a fix."
ccb watch  --session auth-fix --json --timeout-ms 600000
```

### Reuse from another chat

In a second Codex chat, or the next day, just target the same name:

```bash
ccb status                                  # is the session still alive?
ccb inspect --session auth-fix              # what state is it in?
ccb send    --session auth-fix "Continue from where we left off."
```

If the `tmux` server is still running, this reattaches through `ccmux` and the in-context Claude conversation continues. If the server has died (reboot, manual `tmux kill-server`, crash), see [recovery runbook](#recovery-runbook).

### What does NOT survive

- The `ccb` process owns no long-running memory. Killing it does not kill Claude, but the journal preserves whether delivery was definitely absent, observed, or uncertain.
- The `tmux` server dying kills every session inside it. `ccb` cannot resurrect the prior Claude conversation; `claude --resume` is outside the bridge's scope and `ccmux` does not record enough to reattach.
- `claude` crashing inside a live `tmux` window leaves the shell prompt visible. The window itself stays open until you `ccb kill` it or reissue a start.

## Recommended orchestration loop

The loop below is what `ccb` is shaped for. It is a request/response cycle with a follow-up watch and an intervention branch.

```text
1. ccb send    --session NAME [--cwd DIR] [--safe-permissions] "prompt"
2. ccb watch   --session NAME --json --timeout-ms MS         # blocks until done/crashed/timeout
3. branch on the final transition:
     state=done        → ccb capture --session NAME --lines 200, read the result
     state=crashed     → see recovery runbook
     state=unknown     → DO NOT send keystrokes; capture and decide manually
     timeout           → inspect, then either extend or intervene
4. if state=permission_prompt or needs_input appeared mid-watch:
     ccb approve --session NAME       # or ccb deny, or ccb choose N
     resume from step 2
5. mid-turn steering, if needed:
     ccb steer  --session NAME "new information for the live turn"
     resume from step 2
```

`ccb watch --json` emits JSON Lines, one record per state transition, plus a final `stopped`, `timeout`, or `error` event. Stream the lines, act on the last `state` value, and let the exit code tell you why the watch ended (see [exit codes](#exit-codes)).

### Picking values for `--timeout-ms` and `--interval-ms`

- `watch` defaults: `--interval-ms 1500`, `--timeout-ms 600000` (10 minutes).
- `send` defaults: `--timeout-ms 180000` (3 minutes for the ccmux job to complete), `--startup-wait-ms 12000`.
- Each `watch` poll launches one Node process plus a `ccmux capture` subprocess. Lower `--interval-ms` values increase subprocess overhead; prefer wider intervals for long-running turns.
- For long Claude turns (multi-minute tool chains), raise `--timeout-ms` rather than lowering `--interval-ms`.

### When to use each command

| Goal                                                           | Use                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Send a prompt and block until the turn completes               | `ccb send`                                                                         |
| Send a prompt and continue immediately                         | `ccb type` (single-line) or `ccb steer` (multiline)                                |
| Send a slash command (`/cost`, `/release-notes`)               | `ccb slash`                                                                        |
| Inject a long or multiline steering message mid-turn           | `ccb steer` (the only path that preserves embedded newlines)                       |
| Find out what state the pane is in                             | `ccb inspect`                                                                      |
| Block until the state changes or a budget expires              | `ccb watch`                                                                        |
| Answer a permission or input prompt safely                     | `ccb approve` / `ccb deny` (label-matched, refuses when uncertain)                 |
| Answer a prompt by raw position                                | `ccb choose N` (escape hatch, no classification)                                   |
| Send a raw keystroke not covered above                         | `ccb key Up`, `ccb key C-c`, etc.                                                  |
| Read the raw pane including ANSI                               | `ccb capture`                                                                      |
| List durable command outcomes                                  | `ccb commands --session NAME --json`                                               |
| Inspect one command by ID                                      | `ccb command-status ID --json`                                                     |

### Inspecting interrupted commands

```bash
ccb commands --session auth-fix --json
ccb command-status COMMAND_ID --json
```

Reconciliation runs before prompt-bearing commands and these read commands. A dead owner in `queued` or `pre-write` becomes `not-injected`. A dead owner in `injecting` becomes `uncertain`; inspect the Claude pane before deciding whether to send anything again. Never treat `safeToRetry: false` as permission to resend.

### Migration notes for Transport V2

`ccb type` now uses the same lock, baseline capture, journal, and acknowledgement envelope as `send`, `slash`, and `steer`. Scripts that expected the old direct `{session, tmuxSession, entered, bytes}` response must read those fields from `payload` and use top-level `ack` as the delivery result. A failed baseline capture now stops `type` before terminal input and exits 7.

Windows command resolution no longer falls through `.cmd` shims or `shell: true`. Keep the npm global bin directory and the real MSYS2 `tmux.exe` directory on `PATH`. A nonstandard install that cannot be resolved fails closed.

## Recovery runbook

Every entry below lists a symptom, a diagnosis command, and a recovery action. Recovery actions that mutate the session are marked.

### Dead `tmux` server

**Symptom.** `ccb inspect`, `ccb status`, and `ccb watch` all fail with a `tmux` error such as `no server running on /tmp/tmux-*/default`, `error connecting to /tmp/tmux-1000/default (No such file or directory)`, or `server exited unexpectedly`.

**Diagnose.**

```bash
ccb status                  # ccmux's view of registered sessions
ccb sessions                # JSON list of sessions ccmux still remembers
tmux ls 2>/dev/null         # POSIX shell, or MSYS2 shell on Windows
```

If `tmux ls` errors with "no server running", the server is gone. Every Claude session that lived inside it is gone too.

**Recover.**

```bash
ccb kill --session NAME     # mutating: clears ccmux's stale registry entry
ccb start --session NAME --cwd /repo --safe-permissions
ccb wait-ready --session NAME --timeout-ms 45000
```

The prior in-context conversation is lost. Start a new prompt that re-establishes context (paste the relevant summary, file list, or task description). `claude --resume` is not wired through this bridge.

### Dead `claude` inside a live `tmux` window

**Symptom.** `ccb inspect` returns `state: "crashed"` (panic, fatal error, assertion failed, stack trace, or `claude: command not found` visible), or returns `state: "unknown"` with a shell prompt visible in the excerpt and no Claude footer.

**Diagnose.**

```bash
ccb inspect --session NAME --lines 200 --json
ccb capture --session NAME --lines 200      # read the actual tail yourself
```

**Recover.**

```bash
ccb kill --session NAME                     # mutating: tears down the tmux window
ccb start --session NAME --cwd /repo --safe-permissions
ccb wait-ready --session NAME
```

Do not try to "revive" the existing window by typing into a shell prompt. Start clean.

A note on the classifier: a `claude` process that exits cleanly without a panic message may classify as `unknown` rather than `crashed`. That is the conservative failure mode. If you see `unknown` after a long turn, capture the pane and look.

### Broken or missing Windows patch

**Symptom (Windows).** `ccb send` fails with a `tmux load-buffer` error referencing a `C:\...` path. Or `ccmux` reports it cannot write its `pipe-pane` log. Or `ccb start` succeeds but `claude` is launched from the wrong working directory despite `--cwd`.

**Diagnose.**

```bash
ccb patch-ccmux-windows                    # safe to run; reports changed: true|false
```

If the global `claude-code-tmux/src/core.mjs` does not contain the `// ccb-patched` marker, the patcher will rewrite it and report `changed: true`. If the file is missing entirely, the patcher will throw with a hint to reinstall `ccmux`.

**Recover.**

```bash
pi install npm:claude-code-tmux            # ensure a clean upstream file is present
ccb patch-ccmux-windows                    # apply the patch
ccb doctor                                 # confirm everything still resolves
```

This typically happens right after `pi install npm:claude-code-tmux` or `npm install -g claude-code-tmux`, because both overwrite the patched file.

### `unknown` state mid-loop

**Symptom.** `ccb inspect` or a `watch` transition reports `state: "unknown"`.

**What it means.** The classifier saw no positive signal for any known state. This is the conservative failure mode — the bridge prefers `unknown` over guessing. See [classifier precedence](./ARCHITECTURE.md#classifier-precedence-and-evidence-model).

**Do not** send keystrokes. Instead:

```bash
ccb capture --session NAME --lines 200     # read the actual pane
```

Common causes:

- A CC TUI version bump changed the spinner signature, footer wording, or menu layout. The classifier is glyph-agnostic for spinners but depends on the `… (… tokens)` signature and the `bypass permissions on (shift+tab to cycle)` footer.
- A real permission popup whose wording does not match [`PERMISSION_PROMPT_WORDS`](../lib/pane.mjs). `approve`/`deny` will refuse with exit code 3.
- A pane that is mid-redraw with the prompt line scrolled out of the captured window. Try `--lines 200` and re-inspect.

If the unknown is transient, just re-inspect after a second. If it persists, capture and act manually via `ccb key` or `ccb choose`.

### Stuck in `thinking` longer than expected

**Symptom.** `watch` reports continuous `thinking` transitions and never reaches `done`, or `send` returns a ccmux job that never completes.

**Diagnose.**

```bash
ccb inspect --session NAME --lines 200 --json
ccb capture --session NAME --lines 200
ccb jobs                                    # are there queued ccmux jobs?
```

Look at the spinner detail (`↓ N tokens`) and the tool callouts in the excerpt. If Claude is genuinely still working, extend the timeout and keep waiting.

**Intervene (mutating).**

```bash
ccb interrupt --session NAME               # sends C-c
ccb inspect --session NAME                 # did it return to idle?
```

If `interrupt` does not recover the prompt within a few seconds, fall back to the dead-`claude` runbook.

### Auth conflict on startup

**Symptom.** `ccb start` succeeds but the pane immediately shows a Claude Code auth error, a "log in to continue" banner, or an `ANTHROPIC_API_KEY` conflict. Or `ccb send` never reaches `done` and `inspect` shows an `unknown` state with auth-related text in the excerpt.

**Background.** The bridge never speaks to the Anthropic API. Authentication, subscription or usage billing, model selection, and safety policy remain entirely controlled by Claude Code and your Anthropic account configuration. If your account hits a spending cap, or Claude refuses for policy reasons, the bridge has no way to override it.

**Recover.**

```bash
# 1. Fix auth in a real terminal — this is out of scope for ccb.
ccb attach --session NAME                   # opens the live tmux session in this terminal
# (Inside the attached session: run `claude` login steps, /login, etc., then detach with Ctrl+b d.)

# 2. Once auth is healthy in the attached session, detach and resume orchestration.
ccb inspect --session NAME
```

On Windows, the `ccb patch-ccmux-windows` PowerShell prelude strips conflicting `ANTHROPIC_*` environment variables from the spawn environment before invoking `claude`. That only covers process-env conflicts; auth state stored in Claude Code's own configuration (for example saved API keys or login tokens) is not affected by the patch. If you still see auth errors after confirming the patch is applied, inspect Claude Code's own auth configuration directly.

## Safe vs bypass permission guidance

`ccb start` (and the auto-start inside `ccb send`) accept `--safe-permissions`. The flag is forwarded to `ccmux` verbatim. When the flag is **not** set, `ccmux` applies its own default permission behavior for the `claude` invocation. The smoke sessions used to validate this bridge all ran under ccmux's default, which is why real Claude Code permission popups were never observed live (see [reliability – known limitations](./RELIABILITY.md#known-limitations)).

Practical implications:

- **If you start sessions without `--safe-permissions` and your workflow triggers real permission prompts**, the `approve` / `deny` flows are only verified against synthetic fixtures. The first time you hit a real popup, treat the result as unverified and capture the pane bytes.
- **If you want prompts to actually appear** (so Codex can practice `approve`/`deny` end-to-end), start the session with `--safe-permissions` and accept that you will need to drive every permission ask through the bridge.
- **If you want unattended operation**, accept that the only permission mode that was actually smoke-tested with this bridge is ccmux's default bypass mode, and that real-permission flows remain a low-confidence capability.

## Troubleshooting

Quick diagnostic ladder when something is off:

```bash
ccb doctor                                  # 1. Are the tools on PATH?
ccb patch-ccmux-windows                     # 2. Is the Windows patch present? (no-op off-Windows)
ccb status                                  # 3. What does ccmux think exists?
ccb sessions                                # 4. Same, as JSON
ccb inspect --session NAME --lines 200 --json   # 5. What state is the target in?
ccb capture --session NAME --lines 200           # 6. What does the pane actually say?
ccb jobs                                         # 7. Are there stuck ccmux jobs?
```

### Common error shapes

| Symptom                                                                     | Likely cause                                                                                          | Fix                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tmux: command not found` from `doctor`                                     | `tmux` not on `PATH`; on Windows, MSYS2 not installed or not on `PATH`                                | Install MSYS2 and ensure `C:\msys64\usr\bin` is on `PATH` (the bridge assumes this layout on Windows).         |
| `ccmux: command not found`                                                  | `claude-code-tmux` not installed                                                                      | `pi install npm:claude-code-tmux`                                                                              |
| `ccb doctor` reports `bad claude`                                           | `claude` CLI not installed or not logged in                                                           | Install and log in to the `claude` CLI.                                                                        |
| `send` fails with `tmux load-buffer` path error                             | Windows patch missing; `load-buffer` received a `C:\...` path                                         | `ccb patch-ccmux-windows`                                                                                      |
| `ccb start` launches `claude` from the wrong cwd                            | Windows patch missing; PowerShell prelude that honors `--cwd` reverted                                | `ccb patch-ccmux-windows`                                                                                      |
| `approve` exits with code 2 and `error: "no prompt"`                        | The session is not in `permission_prompt` or `needs_input`                                            | `ccb inspect` to see the actual state; adjust your orchestration.                                              |
| `approve` exits with code 3 and `error: "no matching option"`               | A prompt is visible but no option label matched the YES/NO keyword sets                               | `ccb inspect`, read the option labels, then `ccb choose N` with the correct number.                            |
| `approve` exits with code 3 with `"no selection cursor"` or `"ambiguous"`   | Unnumbered cursor menu, but there is no single selected option to navigate from                       | `ccb inspect`, then `ccb key Down`/`ccb key Up` to establish a cursor, or fall back to `ccb choose`.           |
| `watch` emits `error` and exits 4                                           | `ccmux capture` threw                                                                                 | `ccb doctor`, `ccb status`; see [dead tmux](#dead-tmux-server) and [dead claude](#dead-claude-inside-a-live-tmux-window). |
| `watch` emits `timeout` and exits 5                                         | The turn did not finish within `--timeout-ms`                                                         | Re-`inspect`; either extend the timeout or intervene (see [stuck thinking](#stuck-in-thinking-longer-than-expected)). |
| `inspect` reports `state: "unknown"` on a visibly healthy session           | TUI signature drift (CC version bump) or captured window does not include the footer                  | `ccb capture --lines 200`; if the footer is genuinely gone, the classifier needs updating.                     |
| `inspect` reports `state: "crashed"` on a session with hook errors          | Unlikely after the hook-error fix; if it happens, the live UI signal is not visible in the tail      | `ccb capture --lines 200`; confirm the footer and empty `>` prompt are missing before treating as a real crash. |

## Exit codes

Same table as in [RELIABILITY.md](./RELIABILITY.md#exit-codes), repeated here for operational convenience.

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | Success, including graceful `watch` termination on `done`/`crashed`/Ctrl+C.                  |
| 1    | Uncaught error (typically a failing `ccmux` or `tmux` subprocess).                           |
| 2    | Usage error: bad flag, missing required argument, or `approve`/`deny` refused (no prompt).   |
| 3    | `approve`/`deny` saw a prompt but could not safely pick an option.                           |
| 4    | `watch` capture threw an error.                                                              |
| 5    | `watch` reached `--timeout-ms`.                                                              |

## Cleanup

### Tear down one session (mutating)

```bash
ccb kill --session NAME
```

`kill` calls `ccmux kill --session NAME`, which tears down the underlying `tmux` window. The `ccmux` registry entry is cleared. The conversation history is gone.

### List everything ccmux knows about

```bash
ccb sessions        # JSON: the session registry
ccb jobs            # ccmux's job log
ccb status          # ccmux's full status output
```

### Wipe the whole tmux server (mutating, last resort)

```bash
# POSIX / macOS / Linux
tmux kill-server

# Windows (MSYS2 tmux)
tmux.exe kill-server
```

This kills every session in the server, not just the ones `ccb` started. Use it only when the server is in a state that per-session `kill` cannot recover. After `kill-server`, `ccb status` will show an empty (or erroring) registry; clean up stale entries with `ccb kill --session NAME` per name, or by editing `~/.pi/ccmux/state.json` (or `$CCMUX_HOME/state.json`) directly if you know the layout.

### Cleaning up orphaned tmux windows

If `claude` exited cleanly inside a live `tmux` session and `ccb kill` reports the session as already gone while the window lingers, target the tmux session directly:

```bash
tmux kill-session -t ccmux-NAME        # the ccmux- prefix is documented in ARCHITECTURE.md
```

## PowerShell vs POSIX examples

The bridge accepts the same argv on every platform. The differences that matter are shell quoting and the path you pass to `--cwd`. When an example below differs between PowerShell and a POSIX shell, both forms are shown.

### Start a session

```bash
# POSIX
ccb start --session auth-fix --cwd /home/me/repo --safe-permissions
```

```powershell
# PowerShell
ccb start --session auth-fix --cwd C:\repo\app --safe-permissions
```

### Send a prompt with a quoted body

```bash
# POSIX — single quotes preserve everything verbatim, including $
ccb send --session auth-fix --cwd /home/me/repo 'Fix the failing auth tests. Do not refactor unrelated code.'
```

```powershell
# PowerShell — use double quotes, and escape embedded $ as `$
ccb send --session auth-fix --cwd C:\repo\app "Fix the failing auth tests. Do not refactor unrelated code."
```

### Steer with a multiline message

On every platform, `ccb steer` streams the message to a tmux buffer over stdin and pastes it via `tmux paste-buffer -dpr`, so embedded newlines survive. You still need shell-level quoting to get the newlines into `ccb`.

```bash
# POSIX — real newlines inside single quotes
ccb steer --session auth-fix 'Update: the test fixture moved to tests/fixtures/auth.
Rerun only the auth tests, not the whole suite.'
```

```powershell
# PowerShell — here-string produces a real multiline string
ccb steer --session auth-fix @"
Update: the test fixture moved to tests/fixtures/auth.
Rerun only the auth tests, not the whole suite.
"@
```

Do not pass multiline payloads through `ccb type`. `type` is single-line only and submits on Enter.

### Watch and act

```bash
# Same on every platform
ccb watch --session auth-fix --json --timeout-ms 600000
ccb approve --session auth-fix
ccb deny   --session auth-fix
ccb choose --session auth-fix 2
```

### Interrupt a stuck turn

```bash
ccb interrupt --session auth-fix
```

### Attach for manual interaction

```bash
ccb attach --session auth-fix
# Inside tmux: Ctrl+b d detaches and leaves the session running.
```

### Kill and restart clean

```bash
ccb kill  --session auth-fix
ccb start --session auth-fix --cwd /home/me/repo --safe-permissions
ccb wait-ready --session auth-fix --timeout-ms 45000
```
