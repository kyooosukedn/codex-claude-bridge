# Reliability

An honest accounting of what `ccb` does well, what it does poorly, and what would need to change before it should be called production-grade. No marketing claims.

## Current maturity (2026-07-30)

**Assessment: early. Usable for careful, supervised automation. Not yet production-grade.**

The robustness work in this area landed in a single development session. The core happy paths (capture, classify idle/thinking/done, send/steer to a known session, refuse unsafe approvals) are exercised both by automated tests and by live smoke against real `tmux` sessions. Bridge-process crash recovery is covered by deterministic real-child tests at the queued/pre-write, injecting, and acknowledged/released (running) boundaries; real permission popups, a live `claude`/`tmux` kill-and-restart, and non-Windows platforms are still covered by synthetic fixtures or runbook only.

You should treat `ccb` the way you would treat any other terminal automation tool: useful for the loops it handles, but not something to leave running unattended against a session you care about until you have personally verified your specific usage on your specific platform.

### What was verified, by whom, when

- **Automated tests**: 258 main tests passed on Windows on 2026-07-30 (including the P1 stress/fault harness: streaming token observation, delivery-aware verdict, single-token prompt, bounded readiness, child-process fault recovery, 3-session isolation, the slash autocomplete confirmation, the pre-injection idle baseline gate, and the post-injection idle→active observer fix). The native-channel suite is a separate 40-test gate; on 2026-07-30 `npm run check` ran both (258 main + 40 native) with `git diff --check` clean. This is a dated snapshot; `npm run check` is canonical.

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
  | Fresh tmux server + `ccb start --session p1-live-integration` | Windows launch succeeded through explicit PowerShell `-EncodedCommand`; Claude reached ready state. |
  | Long `ccb send`, then same-session `ccb steer` before terminal wait completed | Send injection lock released at `17:25:46`; steer acquired and injected at `17:26:50`; original send remained blocked until timeout. Claude later explicitly acknowledged `STEER_PROBE_20260725`. |
  | `ccb inspect --lines 0`                                  | Refused with `ccb: --lines must be positive integer, got: "0"` and exit code 2. Same for `--lines -5`, `--lines foo`, `--lines 1.5`. |

  These smokes ran against sessions started via ccmux's default (no `--safe-permissions`), which in the tested ccmux version launches `claude` with bypass-permissions behavior, so they never produced a real Claude Code permission popup.

  The P1 **100-trial live gate** has also passed once (2026-07-30, prefix `CCB100J30D`: final release-candidate code, 100/100, no lost/duplicate/extra/reorder/undelivered, zero capture errors), plus a separate clean 3-session isolation run (3×3 live, no leakage). Both are single-host passes on Windows, not continuous integration. See [STRESS.md](./STRESS.md) for artifacts and limits.

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
8. **Windows command resolution is installation-layout dependent.** Transport V2 uses `shell: false`. It resolves `tmux.exe` from `PATH` and npm tools from `<npm-bin>/node_modules/<package>/package.json`. Nonstandard installations must expose those directories on `PATH`; the bridge fails closed when it cannot resolve a real executable.
9. **Serialization is local-host only and not FIFO.** `send`, `slash`, and `steer` share one crash-safe lock per session on this machine. Separate hosts that can reach the same tmux session are outside the protocol. Contenders race for the next fresh `O_EXCL` acquisition; arrival order is not guaranteed.
10. **A live stuck owner fails closed.** Locks are never stolen by age. If the recorded PID is alive but wedged, new injections return busy until the process exits or an operator verifies the state and repairs the lock manually. PID reuse also fails closed: a reused live PID can delay recovery, but cannot cause an automatic unsafe steal.

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
| Session injection lock has a live, unknown, or dead `injecting` owner  | Refuses injection with `ack: "busy"` and exits 8. A dead bridge can leave a child transport alive, so `injecting` is never auto-reclaimed.                                                                     |
| Baseline or phase setup fails before transport                         | Returns `ack: "not-injected"` and exits 7. Nothing was delivered, so retry is safe after fixing the cause.                                                                                                    |
| Transport may have started but acknowledgment is missing or malformed  | Returns `ack: "uncertain"` and exits 9. Never retries automatically. Inspect the pane before deciding whether to resend.                                                                                      |
| `ccmux wait` fails or returns invalid JSON after an accepted `send`     | Keeps the successful coordinator acknowledgment, reports terminal `status: "unknown"`, and exits 9. The injection is not retried.                                                                            |
| `ccb patch-ccmux-windows` cannot find the global `core.mjs`             | Throws with a hint to run `pi install npm:claude-code-tmux`.                                                                                                                                                  |

### Readiness barrier after slash commands

A slash command is a mode-changing input. Historically `ccb slash` returned as soon as the text was pasted, so a `ccb send` issued immediately afterward could be lost while the pane was still mid-transition — and the idle `>` marker lingers in scrollback, so even a readiness check could be fooled by stale output. `ccb slash` now applies a readiness barrier:

- In waited mode it captures a **baseline** fingerprint of the pane tail **before** delivery, and that capture is **fail-closed**: if `ccmux capture` fails, the command aborts with exit code 7 and **does not deliver** (no `injectedAt`), rather than inject into a pane it cannot reason about.
- After delivery it polls the pane (via `ccmux capture`) until the tail **changes** from the baseline **and** classifies as `idle`, then returns. Requiring a change is what defeats the stale-`>` false-positive.
- The observed state is reported honestly in the JSON output (`readiness.state`, `readiness.reason`), never inferred as success. A slash that opens a menu surfaces `state: "needs_input"` with `reason: "timeout-not-ready"` rather than claiming ready.
- `injectedAt` is recorded **only after** the paste succeeds, so the timestamp means "injection completed", not "we started". It is absent when nothing was injected (baseline failure).

Guarantees and controls:

- **Default timeout:** 30000 ms (`DEFAULT_MODE_READY_TIMEOUT_MS`), polled every 1000 ms. Override with `--ready-timeout-ms <ms>` (positive integer; validated **before** any side effect, so misuse exits 2 without delivering).
- **Exit codes:** only a confirmed-ready result or `--no-wait` exits 0. A waited barrier that does **not** confirm ready exits 6 (delivery happened; telemetry is still emitted). A baseline-capture failure exits 7 (no delivery). This stops a sequential caller from proceeding into a known non-ready pane and recreating the lost-delivery failure mode.
- **Escape hatch:** `--no-wait` restores fire-and-forget — it skips baseline capture and the barrier entirely and exits 0; the output carries `readiness: { waited: false, ready: null, reason: "skipped" }`.
- **Outcomes:** `reason: "timeout-stale"` means the tail never changed (stale output or a frozen pane); `reason: "timeout-not-ready"` means it changed but never settled to idle (e.g. a slash-opened menu); `reason: "capture-error"` means `ccmux capture` failed mid-poll; `reason: "baseline-capture-failed"` means the pre-delivery baseline could not be acquired.
- **Telemetry:** every `ccb slash` result carries `commandId`, `injectedAt` (on successful delivery), and (when waited) `readiness.readyAt`, `waitedMs`, `attempts`, `reason`, and `evidence` for audit.
- **Autocomplete confirmation (Claude Code v2.1.218):** the first `Enter` after pasting a slash command only *accepts the autocomplete suggestion*; the command stays staged in the active input (`> /model default`) and is not submitted. In waited mode `ccb slash` now performs a **bounded, guarded confirmation** between delivery and the readiness barrier: it settles, captures the pane, and sends **one** additional `Enter` **only** when the bottom active input still contains *exactly* the submitted command (ANSI / NBSP / whitespace normalized). It does **not** send a second Enter when the command already executed (idle empty prompt), when the pane is thinking/busy (no input prompt), or when the active input differs (a menu or other staged text). At most one confirmation Enter is ever sent. The outcome is reported as `readiness.confirmation` (`confirmSent`, `reason` of `autocomplete-staged` / `executed` / `thinking` / `different` / `sendEnter-unavailable`, `attempts`). `--no-wait` skips this confirmation conservatively (`reason: "no-wait"`) — it never sends an unobserved Enter.

### Pre-injection idle baseline

A slash command is **mode-changing**. A second live finding (3-session isolation, session C, trial 3) showed that injecting a slash while the pane was still *thinking* — Claude was running stop hooks after the previous `send` had already reached ccmux's terminal `done` — mutated the session *after* the caller had received a failure (the post-injection barrier timed out at `state=thinking`, exit 6, but the queued `/model default` later executed when the pane went idle).

`ccb slash` (waited mode) now gates injection on a **confirmed injectable baseline**, acquired *under the same per-session lock* and *before any transport write*:

1. Acquire the session lock (unchanged coordinator/journal lifecycle).
2. Poll the **canonical pane classifier** (`classifyPane`, via `readyState`) until the pane is **injectable**, with a bounded timeout. The injectable rule is decided from classifier result fields/evidence, not ad-hoc text matching:
   - state **`idle`** (empty `>` prompt + footer, no spinner); **or**
   - state **`done`** *only* when the classifier evidence proves an **empty active prompt + footer AND no spinner/busy signal** (`evidence.footer && evidence.emptyPrompt && !evidence.spinnerActive`).

   A **bare `done` marker is not accepted.** `done` is marker-complete and can overlap stop hooks, so `done` + spinner/busy/queued-message is non-injectable. A **stale `done` marker resting on a clearly idle empty prompt stays usable.** Thinking / `needs_input` / `permission_prompt` / `unknown` / `crashed` — and the "edit queued messages" pane (wording varies by Claude Code version) — **never** qualify.
3. Only when injectable, paste + Enter, run the autocomplete confirmation, then the existing fresh-idle readiness barrier.

If the pane never becomes injectable within the budget, `ccb slash` returns a **not-injected** result with **no `enterText`**, exit 7, truthful journal (`not-injected`, `safeToRetry: true`) and telemetry: `readiness.phase: "pre-injection"`, `readiness.reason: "baseline-not-idle"` (busy) or `"baseline-capture-failed"` (ccmux capture error), plus `preInjection` (state, reason, waitedMs, attempts, evidence). The lock is released cleanly. This is deliberately distinct from a **post-injection** readiness timeout, which is exit 6 with `readiness.reason: "timeout-not-ready"` / `"timeout-stale"`.

The timeout is configurable: `--idle-timeout-ms` (pre-injection gate) defaults to `--ready-timeout-ms` (post-injection barrier), so a single knob tolerates long stop hooks. The live stress harness passes `config.readyTimeoutMs` to both budgets (single-session and isolation).

**Caveat — `done` is marker-complete, not pane-idle.** ccmux's terminal `send` status `done` (and the pane classifier's `done` state from a `CCMUX_DONE:<uuid>` marker in view) means *the job reached a completion marker*, **not** that Claude's pane is provably idle. Stop hooks can keep the pane busy past the marker. The pre-injection gate therefore does **not** accept a bare `done`: it requires `done` to coincide with classifier-proven idle evidence (empty prompt + footer, no spinner). `send` status `done` is **not** redefined to mean pane-idle.

### Per-session injection serialization

`send`, `type`, `slash`, and `steer` serialize only their terminal-injection critical section. They do not lock the full Claude task.

- Lock ownership starts with atomic filesystem create (`O_EXCL`) under `~/.codex-claude-bridge/locks`, keyed by session name.
- A contender may recover a `pre-write` or `acknowledged` owner only when the recorded PID is definitely dead (`ESRCH`). Timestamps, TTLs, and heartbeats never authorize a steal.
- A dead owner in `injecting` remains fenced. The bridge process may be gone while its ccmux/tmux child is still running, so automatic reclaim could overlap terminal writes.
- Dead-owner recovery claims the exact lock generation with an atomic hard link, verifies the tombstone, removes the dead canonical record, then competes for a fresh `O_EXCL` acquisition.
- Release requires both owner token and command ID. A delayed prior owner cannot release a recovered owner's lock.
- Before transport starts, a proven baseline failure is `not-injected`. After transport may have started, every failure is `uncertain` and is never retried automatically.
- `send` uses two phases: `ccmux send` runs under the lock and returns a job acknowledgment; `ccmux wait JOB_ID` runs after release. This lets `steer` enter the same session while Claude is still working.
- After `ccmux send` acknowledges the job, `ccb` allows up to 5000 ms to observe that the injection landed before calling it confirmed. Delivery is recognized when either the pane **tail re-renders** (the bottom fingerprint changes from the pre-injection baseline) **or** the pane **transitions from a quiescent baseline (idle, or a done marker resting on an idle empty prompt) into an active state** (`thinking`, `needs_input`, `permission_prompt`) — the same signal a human reads. The transition is gated on a quiescent baseline, so an already-busy pane can never falsely confirm delivery. The second path exists because a long/wrapped prompt renders its spinner *above* the static footer that anchors the bottom of the pane, so the tail alone can stay byte-identical to the idle baseline — that was the `CCB100J30B` trial-27 false negative (`injection-not-observed` on a prompt that had actually landed). No observable change and no active transition within the budget yields `ack: "uncertain"` and exit 9; the validated job payload remains in telemetry for inspection, but `ccb` does not enter the terminal wait or retry automatically.
- `slash` keeps the lock through its readiness barrier. `steer` releases after tmux confirms the paste operation returned.
- This protocol guarantees per-session mutual exclusion and at-most-once automatic injection on one host. It does not guarantee FIFO fairness, distributed locking, or exactly-once delivery after a crash.

### Durable lifecycle recovery

The command journal records `queued`, `pre-write`, `injecting`, `acknowledged`, and `released` transitions as atomic per-command JSON files. It stores metadata only, never prompt text.

- Journal failure before transport stops the command with `not-injected`.
- Journal failure after transport starts returns `uncertain`.
- Restart reconciliation requires a definitely dead owner PID. Live and unknown owners are left untouched.
- A recovered `injecting` command is `uncertain` with `safeToRetry: false`. The bridge never resends it automatically.
- `ccb commands --json` and `ccb command-status ID --json` report the persisted record.

Operator rule: never delete a live-owner lock merely because it is old. Inspect the PID and target pane first. An `injecting` tombstone means delivery may have happened; inspect Claude before sending the command again.

### Stress & fault harness

The P1 stress/fault harness exercises the lifecycle above at scale and under injected crashes. Its deterministic unit, fault-recovery, and 3-session isolation tests run under `npm test` (no Claude); the live 100-trial slash-then-prompt run is opt-in (`--live --yes`), never part of `npm test`, and has passed once on Windows (2026-07-30, prefix `CCB100J30D`, final release-candidate code). See [STRESS.md](./STRESS.md) for exact commands, prerequisites, artifacts, and limitations.

### Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | Success, including graceful `watch` termination on `done`/`crashed`/Ctrl+C.                     |
| 1    | Uncaught error (typically a failing `ccmux` or `tmux` subprocess).                              |
| 2    | Usage error: bad flag, missing required argument, or `approve`/`deny` refused (no prompt).      |
| 3    | `approve`/`deny` saw a prompt but could not safely pick an option.                              |
| 4    | `watch` capture threw an error.                                                                 |
| 5    | `watch` reached `--timeout-ms`.                                                                 |
| 6    | `slash` (waited): delivered, but the readiness barrier did not confirm a ready pane.             |
| 7    | Injection stopped before transport; nothing was delivered.                                      |
| 8    | Session injection lock is busy or cannot be safely recovered.                                   |
| 9    | Delivery or terminal outcome is uncertain; inspect before retrying.                              |

### What Codex should do on `unknown` or refusal

- **On `state: "unknown"`**: do not send keystrokes. Either wait and re-`inspect`, or `capture --lines 200` and read the pane yourself.
- **On exit code 2 from `approve`/`deny`**: the state was not a prompt. Read `inspect` to see what state the session is actually in and adjust your orchestration.
- **On exit code 3 from `approve`/`deny`**: a prompt is visible but the bridge could not match an option label. Either inspect the option list and call `ccb choose N` with the known number, or fall back to `ccb type` / `ccb key` with raw keystrokes.
- **On `watch` exit code 4**: the session or `ccmux` is unhealthy. Run `ccb doctor`, then `ccb status`.
- **On `watch` exit code 5**: the session did not reach `done`/`crashed` within `--timeout-ms`. Decide whether to extend the timeout, intervene manually, or give up.
- **On `ccb slash` exit code 6** (waited, delivered but not ready): do not immediately `send` — the pane did not settle to a ready state. Read `readiness.state`/`readiness.reason` from the slash output and `ccb inspect` to see why (e.g. the slash opened a menu), resolve it, then retry.
- **On `ccb slash` exit code 7** (waited, baseline capture failed): nothing was delivered. The session or `ccmux` is unhealthy — run `ccb doctor`, then `ccb status`, and re-establish the session before retrying.

## Confidence labels

These labels summarize the test matrix above in one line per capability. They are backed only by the evidence cited; they are not guarantees.

- **High confidence**: ANSI stripping, `idle` classification, `approve`/`deny` refusal on non-prompts, numeric flag validation.
- **Medium confidence**: `done` classification (live evidence is indirect/completion-protocol smoke), `thinking` classification (glyph-agnostic but signature-dependent), `watch` transitions and Ctrl+C handling (live smoke only, no automated watch-loop test), Windows patch idempotency, multiline steer for short ASCII payloads, longer steer payloads.
- **Low confidence**: `permission_prompt` and `needs_input` classification against real CC popups, `approve`/`deny` against real numbered or cursor menus, inline `y/n` against real CC prompts, all behavior on macOS and Linux, behavior after a Claude Code TUI version bump.

## Suggested next tests before calling it production-grade

In rough priority order. Each item is a concrete gap, not a wishlist.

1. **Real permission popups, all three platforms.** Start a session with `ccb start --safe-permissions` (which in the tested ccmux version suppresses bypass-permissions behavior and surfaces real prompts), trigger a real Bash or Edit tool permission prompt, capture the actual pane bytes, and add them as a fixture. Repeat on Windows, Linux, and macOS. Until this exists, `permission_prompt` classification is unverified outside synthetic fixtures.
2. **Crash / recovery tests.** Bridge-process recovery is already covered deterministically (a real child process writes a journal record in `queued`/`pre-write`, `injecting`, or `acknowledged`/`released` state, then dies; the parent reconciles via the real-PID liveness probe — see `test/fault-recovery.test.mjs`). What is **not** verified live: kill the `claude` process inside a live `tmux` session and confirm the classifier produces `crashed` (or a documented `unknown` with the right `evidence`); kill the `tmux` server and confirm the recovery runbook in [OPERATIONS.md](./OPERATIONS.md) actually works.
3. **Unnumbered cursor menu, end-to-end.** Synthesize a real CC TUI session that produces an unnumbered arrow-key menu and verify that `approve`/`deny` navigation reaches the correct option. Currently this is only tested at the unit level with synthetic labels.
4. **Cross-platform smoke.** Run the full `inspect` / `watch` / `steer` smoke suite on Linux and macOS. Several code paths key off `process.platform === "win32"` and have only been exercised on Windows.
5. **Large-payload steer.** Verify a 10 KB+ multiline payload still arrives intact end-to-end. The temp-file + `paste-buffer -dpr` path should handle it but has not been measured.
6. **Unicode / emoji payload.** Same as above with non-ASCII content (CJK, emoji, combining marks).
7. **Watch SIGTERM handling.** Verify that orchestration tools that send SIGTERM (rather than SIGINT) trigger the `stopped` event cleanly.
8. **`doctor` patch-state check.** Add a `doctor` warning when `ccmux` is installed but the Windows patch is missing, so upgrades cannot silently regress.
9. **`claude` CLI version drift.** A test that runs `claude --version` and warns when the version is outside the range the classifier was built against (currently v2.1.150).
10. **Property-style fuzz tests for the classifier.** Generate random panes with shuffled footer / spinner / option combinations and assert that classification never crashes and never returns a non-`unknown` state without supporting `evidence`.

Until at least items 1–3 are done, treat the bridge as a useful supervised tool, not as an unattended production component.
