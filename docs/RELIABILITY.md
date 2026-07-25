# Reliability

An honest accounting of what `ccb` does well, what it does poorly, and what would need to change before it should be called production-grade. No marketing claims.

## Current maturity (2026-07-23)

**Assessment: early. Usable for careful, supervised automation. Not yet production-grade.**

The robustness work in this area landed in a single development session. The core happy paths (capture, classify idle/thinking/done, send/steer to a known session, refuse unsafe approvals) are exercised both by automated tests and by live smoke against real `tmux` sessions. The riskier paths (real permission popups, crash recovery, non-Windows platforms) are covered by synthetic fixtures only.

You should treat `ccb` the way you would treat any other terminal automation tool: useful for the loops it handles, but not something to leave running unattended against a session you care about until you have personally verified your specific usage on your specific platform.

### What was verified, by whom, when

- **Automated tests**: 44 tests, all passing as of the 2026-07-23 snapshot below (Node `v22.12.0`, npm `10.9.0`, tmux `3.6a`, Windows `win32 10.0.26200`). This number is a dated snapshot, not a live guarantee — the canonical count is whatever `npm test` reports when you run it. The breakdown as of that snapshot:

  | Area                                | Tests | What they actually assert                                                                                                       |
  | ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
  | ANSI/control stripping              | 5     | CSI, OSC-BEL, OSC-ST, C0 controls, tabs/newlines preserved                                                                     |
  | Line cleaning and excerpt           | 3     | Trailing whitespace trimmed, last N non-empty lines returned, empty input stable                                                |
  | `classifyPane` states               | 10    | idle, thinking, done, stale-done-rejection, permission_prompt, needs_input, inline y/n, crashed, unknown, JSON serializable    |
  | `extractOptions`                    | 2     | Numbered menu cluster detected; idle footer does not falsely produce options                                                    |
  | `selectOption`                      | 5     | Label match for approve/deny, refusal when no semantic match, no positional fallback, deny-picks-cancel / approve-picks-continue |
  | `buildSteerPayload` (multiline)     | 4     | Interior newlines preserved, outer whitespace trimmed, empty input safe, `-dpr` flag present in bridge source                   |
  | Classifier regressions              | 9     | Hook-error idle, spinner-wins-over-hooks, generic yes/no stays `needs_input`, recency (historical spinner + fresh menu), numbered-prose-does-not-become-menu, etc. |
  | Source-inspection regressions       | 2     | Bridge source contains the steer patch and the `-dpr` paste-buffer flag                                                         |
  | Unnumbered cursor menu handling     | 3     | Cursor-on-target returns `cursor-confirm`, cursor-above-target navigates Up, no-cursor refuses                                  |
  | Numbered-menu sanity                | 1     | Numbered menu pick returns a real number, never `null`                                                                          |

  Run it yourself: `npm test`. The summary line is the canonical number.

- **Live smoke (this development session, against real `tmux` sessions on the same Windows host)**:

  | Action                                                    | Outcome                                                                                                                            |
  | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | `ccb inspect --session ccb-smoke --lines 100 --json`     | Returned `state=idle` with `evidence.footer=true`, `evidence.emptyPrompt=true`. Excerpt matched visible pane.                      |
  | `ccb inspect --session ccb-smoke-2 --lines 100 --json`   | Returned `state=idle` despite multiple `command not found` hook errors in scrollback (validates the hook-error fix on real data).  |
  | `ccb inspect --session robustness-v1 --lines 200 --json` | Returned `state=thinking` with spinner `Actualizing (1m 29s · ↓ 1.6k tokens)` — glyph-agnostic match on real CC v2.x output.       |
  | `ccb approve --session ccb-smoke --json`                 | Refused with `{"error":"no prompt","state":"idle"}` and exit code 2.                                                               |
  | `ccb watch --session ccb-smoke --interval-ms 500 --timeout-ms 1500 --json` | Emitted one `transition` event to `idle`, then a `timeout` event. Clean shutdown.                                    |
  | `ccb steer --session ccb-smoke "SMOKE-PROBE-A\nSMOKE-PROBE-B\nSMOKE-PROBE-C"` | All three lines arrived verbatim in the target pane. Confirmed via `ccmux capture` afterward.                       |
  | `ccb inspect --lines 0`                                  | Refused with `ccb: --lines must be positive integer, got: "0"` and exit code 2. Same for `--lines -5`, `--lines foo`, `--lines 1.5`. |

  These smokes ran against sessions started via ccmux's default (no `--safe-permissions`), which in the tested ccmux version launches `claude` with bypass-permissions behavior, so they never produced a real Claude Code permission popup.

### Test matrix: capability vs. evidence

| Capability                                     | Automated fixture | Live test this session | Remaining risk                                                                                                       | Confidence |
| ---------------------------------------------- | ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------- |
| Capture pane and clean ANSI                    | Yes               | Yes                    | Very large panes may exceed `ccmux capture --lines` budget; very new CSI variants could slip past `stripAnsi`.       | High       |
| Classify `idle`                                | Yes               | Yes (2 sessions)       | Footer string changes in a future CC version would silently degrade this.                                           | High       |
| Classify `thinking` (spinner)                  | Yes               | Yes (1 session)        | Spinner glyph set rotates; classifier is glyph-agnostic but still depends on the `… (… tokens)` signature.           | Medium     |
| Classify `done`                                | Yes               | Indirectly             | Depends on `ccmux` continuing to emit `CCMUX_DONE:<uuid>` as the completion marker; live evidence is completion-protocol smoke only. | Medium     |
| Classify `permission_prompt` (numbered menu)   | Yes (synthetic)   | **No**                 | Real CC popups were never captured. Fixture is based on documented wording; real-wording drift will cause `unknown`. | Low        |
| Classify `needs_input` (generic menu)          | Yes (synthetic)   | **No**                 | Same as above.                                                                                                       | Low        |
| Inline `y/n` prompt                            | Yes (synthetic)   | **No**                 | Pattern based on observed older CC behavior; current CC may not emit this shape.                                    | Low        |
| `approve` / `deny` on numbered menu            | Yes (synthetic)   | **No**                 | Keyword matching could miss unfamiliar wording; refusal is safe but may be noisy.                                   | Low        |
| `approve` / `deny` on unnumbered cursor menu   | Yes (synthetic)   | **No**                 | Navigation math is tested, but real cursor renderings and option labels were not exercised end-to-end.              | Low        |
| `approve` / `deny` refusal on non-prompt states| Yes               | Yes (idle)             | Behavior on `unknown` is to refuse, which is safe.                                                                   | High       |
| Numbered prose does not falsely produce a menu| Yes (synthetic)   | Discovered live (dogfood) | Numbered steering items 11–13 were misextracted as a menu before the cursor-required rule. Now gated on a `❯`/`›`/`»` cursor. | High       |
| `steer` multiline end-to-end                   | Yes (payload)     | Yes (3 lines)          | Multiline was tested with a short ASCII payload. Very long or Unicode-heavy payloads were not exercised.            | Medium     |
| `watch` transitions                            | No (live smoke)   | Yes (idle session)     | Automated suite has no watch-loop test; Ctrl+C cleanup was tested only via the OS killing the process; graceful `SIGTERM` was not exercised. | Medium     |
| Numeric flag validation                        | No (manual smoke) | Yes (4 bad values)     | Automated suite has no `parsePositiveInt` test; behavior verified by manual CLI smoke only.                          | High       |
| Windows patch application and idempotency      | Yes (source)      | Yes (applied twice)    | Patches are tied to current `ccmux` source layout; an `ccmux` upgrade can silently revert.                          | Medium     |
| Non-Windows platforms                          | **No**            | **No**                 | Code keys Windows behavior off `process.platform === "win32"`; POSIX path is exercised only via tests of pure helpers. | Low        |

## Known limitations

These are not theoretical. Each one corresponds to a code path that exists today and could surprise you.

1. **Heuristic parser, brittle to TUI changes.** The classifier matches against Claude Code v2.x TUI output captured on 2026-07-23. Spinner signature, footer strings, option layout, and `CCMUX_DONE:` marker format can all change between CC releases. When that happens, the classifier will return `unknown` for affected states. This is the conservative failure mode and is safe, but it means automation silently stops working.
2. **No live test of real permission popups.** Every smoke session in this development window ran under ccmux's default (no `--safe-permissions`), which in the tested ccmux version launches `claude` with bypass-permissions behavior. The `permission_prompt`/`needs_input` states and `approve`/`deny` flows are covered by synthetic fixtures only. The first time you encounter a real permission prompt in production, treat the result as unverified.
3. **Tmux dependency is hard.** If the `tmux` server dies, every session dies with it. `ccb` cannot resurrect the prior conversation; `claude --resume` is outside the bridge's scope and the ccmux state file does not record enough to reattach to a Claude resume.
4. **Process survival boundaries.** `claude` crashing inside a live `tmux` window leaves the shell prompt visible. The classifier calls this `crashed` only when a positive crash signal is present **and** no live UI supersedes; a `claude` process that exits cleanly without a panic message will classify as `unknown` (and may leak a leftover `tmux` window — see [OPERATIONS.md](./OPERATIONS.md)).
5. **Package upgrades overwrite the ccmux patch.** Every reinstall or upgrade of `claude-code-tmux` replaces the patched `core.mjs`. You must re-run `ccb patch-ccmux-windows` afterwards. `doctor` does not currently warn when the patch is missing.
6. **Auth, model, and policy remain Claude-owned.** `ccb` never speaks to the Anthropic API and never modifies Claude Code's authentication, subscription billing, model selection, or policy decisions. If your Anthropic account hits a spending cap, or Claude Code refuses a request for safety reasons, the bridge has no way to override it and no way to surface the underlying error except by classifying the resulting pane state.
7. **Single-shell invocations.** Each `ccb` call spawns one Node process plus at least one `ccmux` or `tmux` subprocess. There is no long-lived daemon and no streaming output. High-frequency `watch` polling has to budget for that overhead.
8. **Windows shell quoting.** On Windows, the bridge invokes subprocesses with `shell: true` so that `ccmux` and `tmux` resolve through PowerShell. This is necessary for MSYS2 path translation but means user-supplied strings are passed through one extra layer of shell interpretation. The multiline `steer` path avoids this by writing to a file; `type`, `slash`, and `send` still pass text directly through the shell.
9. **Readiness barrier is per-command, not a lock.** `ccb slash` now waits for the pane to re-render into a fresh idle state before returning (see _Readiness barrier after slash commands_ below), which closes the deterministic lost-prompt-after-slash gap when callers wait for `slash` to return before issuing `send`. It is not a cross-process session lock: a prompt sent by a concurrent process in the window between `slash` returning and the next `send` injecting can still race. Per-session serialization of `send`/`slash`/`steer` is deferred to a later P1 slice.

## Failure modes and conservative behaviors

The bridge prefers to refuse over guessing. Concrete failure modes:

| Scenario                                                                | What `ccb` does                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect` cannot find any classifier signal                             | Returns `state: "unknown"` with `evidence` showing what was checked. Caller decides next action.                                                                                                              |
| `approve` / `deny` called on a non-prompt state                         | Refuses with exit code 2 and `{"error":"no prompt", "state": ...}`.                                                                                                                                            |
| `approve` / `deny` cannot match any option label                        | Refuses with exit code 3 and `{"error":"no matching option", ...}`. Suggests `ccb choose N`.                                                                                                                  |
| Unnumbered menu has no cursor or an ambiguous cursor                    | Refuses with exit code 3 (`"no selection cursor"` or `"ambiguous selection"`).                                                                                                                                |
| `watch` capture throws                                                  | Emits an `error` event with the underlying message and exits 4.                                                                                                                                                |
| `watch` reaches `--timeout-ms`                                          | Emits a `timeout` event and exits 5.                                                                                                                                                                          |
| `watch` receives Ctrl+C / SIGTERM                                       | Emits a `stopped` event and exits 0.                                                                                                                                                                          |
| Numeric flag is zero, negative, non-integer, or NaN                     | Prints `ccb: --<name> must be a positive integer, got: ...` to stderr and exits 2.                                                                                                                            |
| `ccmux` or `tmux` returns nonzero                                       | The bridge throws with the subprocess's stderr; `main` catches and exits 1.                                                                                                                                   |
| `ccb patch-ccmux-windows` cannot find the global `core.mjs`             | Throws with a hint to run `pi install npm:claude-code-tmux`.                                                                                                                                                  |

### Readiness barrier after slash commands

A slash command is a mode-changing input. Historically `ccb slash` returned as soon as the text was pasted, so a `ccb send` issued immediately afterward could be lost while the pane was still mid-transition — and the idle `>` marker lingers in scrollback, so even a readiness check could be fooled by stale output. `ccb slash` now applies a readiness barrier:

- Before delivery it captures a baseline fingerprint of the pane tail.
- After delivery it polls the pane (via `ccmux capture`) until the tail **changes** from the baseline **and** classifies as `idle`, then returns. Requiring a change is what defeats the stale-`>` false-positive.
- The observed state is reported honestly in the JSON output (`readiness.state`, `readiness.reason`), never inferred as success. A slash that opens a menu surfaces `state: "needs_input"` with `reason: "timeout-not-ready"` rather than claiming ready.

Guarantees and controls:

- **Default timeout:** 30000 ms (`DEFAULT_MODE_READY_TIMEOUT_MS`), polled every 1000 ms. Override with `--ready-timeout-ms <ms>` (positive integer; misuse exits 2).
- **Escape hatch:** `--no-wait` restores fire-and-forget; the output then carries `readiness: { waited: false, ready: null, reason: "skipped" }`.
- **Timeout outcomes:** `reason: "timeout-stale"` means the tail never changed (stale output or a frozen pane); `reason: "timeout-not-ready"` means it changed but never settled to idle (e.g. a slash-opened menu); `reason: "capture-error"` means `ccmux capture` failed mid-poll. In every non-ready case delivery still occurred (exit 0) — callers should branch on `readiness.ready`, not on the exit code.
- **Telemetry:** every `ccb slash` result carries `commandId`, `injectedAt`, and (when waited) `readiness.readyAt`, `waitedMs`, `attempts`, `reason`, and `evidence` for audit.

Scope: `send` and `steer` are unchanged in this slice; the barrier lives on `slash` because that is where the mode-changing gap was reproduced.

### Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | Success, including graceful `watch` termination on `done`/`crashed`/Ctrl+C.                     |
| 1    | Uncaught error (typically a failing `ccmux` or `tmux` subprocess).                              |
| 2    | Usage error: bad flag, missing required argument, or `approve`/`deny` refused (no prompt).      |
| 3    | `approve`/`deny` saw a prompt but could not safely pick an option.                              |
| 4    | `watch` capture threw an error.                                                                 |
| 5    | `watch` reached `--timeout-ms`.                                                                 |

### What Codex should do on `unknown` or refusal

- **On `state: "unknown"`**: do not send keystrokes. Either wait and re-`inspect`, or `capture --lines 200` and read the pane yourself.
- **On exit code 2 from `approve`/`deny`**: the state was not a prompt. Read `inspect` to see what state the session is actually in and adjust your orchestration.
- **On exit code 3 from `approve`/`deny`**: a prompt is visible but the bridge could not match an option label. Either inspect the option list and call `ccb choose N` with the known number, or fall back to `ccb type` / `ccb key` with raw keystrokes.
- **On `watch` exit code 4**: the session or `ccmux` is unhealthy. Run `ccb doctor`, then `ccb status`.
- **On `watch` exit code 5**: the session did not reach `done`/`crashed` within `--timeout-ms`. Decide whether to extend the timeout, intervene manually, or give up.

## Confidence labels

These labels summarize the test matrix above in one line per capability. They are backed only by the evidence cited; they are not guarantees.

- **High confidence**: ANSI stripping, `idle` classification, `approve`/`deny` refusal on non-prompts, numeric flag validation.
- **Medium confidence**: `done` classification (live evidence is indirect/completion-protocol smoke), `thinking` classification (glyph-agnostic but signature-dependent), `watch` transitions and Ctrl+C handling (live smoke only, no automated watch-loop test), Windows patch idempotency, multiline steer for short ASCII payloads, longer steer payloads.
- **Low confidence**: `permission_prompt` and `needs_input` classification against real CC popups, `approve`/`deny` against real numbered or cursor menus, inline `y/n` against real CC prompts, all behavior on macOS and Linux, behavior after a Claude Code TUI version bump.

## Suggested next tests before calling it production-grade

In rough priority order. Each item is a concrete gap, not a wishlist.

1. **Real permission popups, all three platforms.** Start a session with `ccb start --safe-permissions` (which in the tested ccmux version suppresses bypass-permissions behavior and surfaces real prompts), trigger a real Bash or Edit tool permission prompt, capture the actual pane bytes, and add them as a fixture. Repeat on Windows, Linux, and macOS. Until this exists, `permission_prompt` classification is unverified outside synthetic fixtures.
2. **Crash / recovery tests.** Kill the `claude` process inside a live `tmux` session and verify the classifier produces `crashed` (or a documented `unknown` with the right `evidence`). Kill the `tmux` server and verify the recovery runbook in [OPERATIONS.md](./OPERATIONS.md) actually works.
3. **Unnumbered cursor menu, end-to-end.** Synthesize a real CC TUI session that produces an unnumbered arrow-key menu and verify that `approve`/`deny` navigation reaches the correct option. Currently this is only tested at the unit level with synthetic labels.
4. **Cross-platform smoke.** Run the full `inspect` / `watch` / `steer` smoke suite on Linux and macOS. Several code paths key off `process.platform === "win32"` and have only been exercised on Windows.
5. **Large-payload steer.** Verify a 10 KB+ multiline payload still arrives intact end-to-end. The temp-file + `paste-buffer -dpr` path should handle it but has not been measured.
6. **Unicode / emoji payload.** Same as above with non-ASCII content (CJK, emoji, combining marks).
7. **Watch SIGTERM handling.** Verify that orchestration tools that send SIGTERM (rather than SIGINT) trigger the `stopped` event cleanly.
8. **`doctor` patch-state check.** Add a `doctor` warning when `ccmux` is installed but the Windows patch is missing, so upgrades cannot silently regress.
9. **`claude` CLI version drift.** A test that runs `claude --version` and warns when the version is outside the range the classifier was built against (currently v2.1.150).
10. **Property-style fuzz tests for the classifier.** Generate random panes with shuffled footer / spinner / option combinations and assert that classification never crashes and never returns a non-`unknown` state without supporting `evidence`.

Until at least items 1–3 are done, treat the bridge as a useful supervised tool, not as an unattended production component.
