# P1 Stress & Fault Harness

The P1 acceptance gate is **100 consecutive slash-then-prompt trials with zero
lost, duplicated, or reordered prompts**, plus deterministic crash recovery at
every lifecycle boundary and no cross-session leakage. This document is the
honest operating manual for the harness that proves it.

## Live evidence (2026-07-30)

The release-candidate code passed a full live run on Windows:

- **100/100 trials, prefix `CCB100J30D` (final release-candidate code)** — 100
  observed/matched; zero lost, duplicate, extra, reorder, or undelivered; zero
  capture errors. Streaming observation: 102 snapshots, 100 distinct tokens,
  `maxConcurrent=1`. Started 2026-07-30T20:21:41.707Z, ended 20:52:04.292Z.
  Artifact: `~/.codex-claude-bridge/stress/2026-07-30T20-21-41-706Z/`.
- **3-session isolation (separate clean run)** — 3 named sessions × 3 trials
  live, no cross-session token leakage. Artifact:
  `~/.codex-claude-bridge/stress/2026-07-30T17-34-12-837Z/`.

An earlier full run on the post-observer-fix code (prefix `CCB100J30C`) also
passed 100/100; `CCB100J30D` is the run on the final code and is the primary
evidence.

`npm run check` independently passes on Windows (258 main + 40 native), and
`git diff --check` is clean. This is one passing run on one host, not continuous
integration: the live command can still regress, so re-run `--live --yes` before
relying on it. Real `claude`/`tmux` process kill and restart is **still not**
exercised live — only the deterministic real-child bridge-process recovery (see
the limitations and [RELIABILITY.md](./RELIABILITY.md)).

### What the first full run caught: `CCB100J30B` trial 27

An earlier full run (prefix `CCB100J30B`) passed trials 1–26, then recorded
trial 27 as `slashOk=true, sendOk=false` and stopped. The prompt **was**
delivered — a manual `inspect` showed the full wrapped prompt in the pane with
the session `thinking/Deliberating`. The post-injection observer had confirmed
delivery only by comparing the **bottom 12 lines** of the pane to the
pre-injection baseline; a long/wrapped prompt renders its spinner *above* the
static footer that anchors those 12 lines, so the tail never changed and the
observer reported `injection-not-observed` (a false negative → `ack:
"uncertain"`).

The observer now also treats an **idle→active** state transition
(`thinking`/`needs_input`/`permission_prompt`) as delivery proof — the same
signal a human reads — gated on a quiescent baseline so an already-busy pane can
never falsely confirm delivery. At-most-once safety and retry classification are
unchanged. The `CCB100J30D` run above passed with this fix. See
[RELIABILITY.md](./RELIABILITY.md#per-session-injection-serialization).

## What is opt-in vs. always-on

| Surface | Runs by default? | Launches Claude? |
| --- | --- | --- |
| `npm test` (deterministic unit + fault + isolation tests) | yes | **no** |
| `npm run stress:dry-run` | no | **no** — prints the trial plan only |
| `npm run stress` / `node bin/ccb-stress.mjs --live --yes` | no | **yes** |

`npm test` and `npm run check` never start a Claude session and never mutate a
live session. The live run requires **both** `--live` and `--yes`, or it exits
with a usage error.

## Deterministic coverage (always-on, in `npm test`)

These prove the contract without any Claude, ccmux, or tmux dependency:

- `test/stress-harness.test.mjs` — verdict aggregation (lost / duplicate /
  reorder / extra detection), token extraction, trial planning, opt-in parsing.
- `test/stress-report.test.mjs` — `runStress` driver with deterministic fakes,
  report formatting (platform-aware), safe artifact cleanup, traversal refusal.
- `test/stress-reviewer.test.mjs` — delivery-aware verdict (nonzero exit / non-
  `done` terminal fails), single-occurrence prompt + id-prefix validation, bounded
  readiness wait, 3-session isolation (fakes, no Claude).
- `test/token-observer.test.mjs` — pure streaming accumulator: cross-snapshot
  no-false-duplicate, single-frame double, first-seen order, foreign retention,
  capture-error fail-closed.
- `test/stress-streaming.test.mjs` — rolling-window integration: 100 tokens pass
  with a tiny final window, single-frame duplicate fails, no false duplicate,
  drop/reorder/stale-baseline/capture-error fail, transient cross-session leak
  fails after eviction.
- `test/fault-recovery.test.mjs` — process death at `queued`/`pre-write`,
  `injecting`, and `acknowledged`/`released` boundaries; safe reconciliation;
  no automatic resend; 3-session concurrent isolation against the **real**
  per-session file lock.
- `test/stress-cli.test.mjs` — the entrypoint dry-runs safely and live mode is
  gated behind `--live --yes`.

## Prerequisites for a live run

1. Windows: run `ccb patch-ccmux-windows` first (package upgrades revert it).
2. `ccb doctor --json` passes (node, npm, pi, claude, ccmux, tmux all ok).
3. A funded Claude account; the run sends N real prompts.
4. Either pre-start a session or pass `--start`.

## Exact commands

Dry-run (plan only, safe):

```sh
node bin/ccb-stress.mjs --trials 100 --session ccb-stress
# or: npm run stress:dry-run
```

First controlled live trial (recommended: start small):

```sh
node bin/ccb-stress.mjs --trials 5 --session ccb-stress-live \
  --slash "/model default" --capture-lines 2000 --start --live --yes
```

Full P1 gate (100 trials):

```sh
node bin/ccb-stress.mjs --trials 100 --session ccb-stress-live \
  --slash "/model default" --capture-lines 8000 --start --live --yes
```

3-session isolation (concurrently target 3 named sessions, verify no foreign
token in any pane):

```sh
node bin/ccb-stress.mjs --isolation --sessions ccb-a,ccb-b,ccb-c \
  --trials 10 --start --live --yes
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--trials N` | 100 | Number of slash-then-prompt trials (positive int). |
| `--session NAME` | ccb-stress | Target session; **required in live mode**. |
| `--slash CMD` | `/model default` | Slash command run before each prompt. |
| `--id-prefix PREFIX` | CCBSTRESS | Unique-id prefix; tokens are `PREFIX-NNN`. |
| `--capture-lines N` | 4000 | `ccmux capture` line budget for token extraction. |
| `--sleep-ms MS` | 0 | Pause between trials. |
| `--start` | off | Create the session via `ccmux start` if absent, then wait for confirmed readiness (bounded by `--ready-timeout-ms`) before trial 1. |
| `--ready-timeout-ms MS` | 60000 | Bounded readiness wait after `--start`. Aborts trial 1 if the pane never shows an input prompt. |
| `--isolation` | off | 3-session concurrent isolation mode (see below). |
| `--sessions A,B,C` | derived | Named sessions for `--isolation` (>=2; validated). |
| `--out-dir DIR` | auto | Override the artifacts directory. |
| `--cleanup` | off | Remove a prior artifacts dir (only under its root). |
| `--live --yes` | off | Enable live mode; both required. |

## Artifacts

Each live run writes, under `--out-dir` or
`<CCB_HOME|~/.codex-claude-bridge>/stress/<UTC timestamp>/`:

- `verdict.json` — machine-verifiable: `config`, `verdict` (ok, counts, lost,
  duplicate, extra, reordered), `observation` (mode `streaming`, snapshots,
  distinctTokens, maxConcurrent, captureErrors, firstSeenSample — token ids
  only, never prompt bodies), `deliveryFailures`, `observedCount`, timestamps.
- `report.txt` — human-readable `STRESS PASS|FAIL` summary + failure detail.

Machine-verifiable pass: `verdict.verdict.ok === true` AND
`verdict.verdict.lost/duplicate/extra` all empty AND `reordered === false`.

Exit codes: `0` ok / dry-run, `1` failed verdict, `2` usage error.

## How delivery is verified

Each trial sends a prompt whose body is a unique zero-padded token
(`CCBSTRESS-001` … `CCBSTRESS-100`) **exactly once**, followed by an instruction
to acknowledge with a single `OK` and **not** to repeat the token. The command
journal independently records each command's lifecycle
(`queued → pre-write → injecting → acknowledged → released`) with unique command
ids, so `ccb commands --json` is corroborating evidence.

**Streaming observation (required by `tmux history-limit 2000`).** A single
final pane capture cannot honestly retain 100 trial tokens — early tokens scroll
out of the captured window and would be misreported as "lost". The harness
therefore **accumulates evidence across snapshots**:

1. a **baseline** capture before trial 1 (detects stale same-prefix tokens from
   a prior run, which surface as extra/duplicate/reorder instead of being
   trusted or ignored);
2. a capture **after every attempted send** and after every slash failure; and
3. a **final** snapshot.

A pure token observer (`lib/token-observer.mjs`) maintains, across snapshots:
**first-seen order** (the honest chronological delivery order, used for the
reorder check) and the **maximum simultaneous occurrence count** per token in
any single snapshot. A token that persists in scrollback across many captures
stays count-1 (NOT a duplicate); two copies in one snapshot become count-2 (a
real duplicate). Foreign/unexpected tokens are retained and surface as "extra".
The verdict is computed from this accumulated multiset, not a final scrollback.

Zero-padding makes "reordered" a plain sequence comparison against first-seen
order. A run passes only when **both** hold:

1. **Token integrity** — `lost`, `duplicate`, `extra` all empty and `reordered === false`.
2. **Delivery integrity** — every trial's `slash`/`send` exited 0 AND every
   `send` reached terminal status `done`.

Delivery integrity fails closed: a missing or non-numeric `exitCode` is **not**
treated as 0, and a missing terminal status is **not** treated as `done`.
**Observation fails closed too:** any capture error is recorded (never silently
dropped) and forces `verdict.ok = false` with `observationError = true`.

**Fail-fast per session.** If a `slash` is not explicit success, the harness
records a skipped-send for that trial and stops the session (no injection into a
not-ready/unknown pane). If a `send` is not exit 0 + terminal `done`, it stops
the session. Un-attempted trials appear as `lost` tokens; the failed/skipped
trial appears as `undelivered` (with `slashOk`/`sendOk`/`status`/`skipped`). In
isolation, one failing session never cancels the independent sessions.

Machine-verifiable pass: `verdict.verdict.ok === true` (which requires both
above), equivalently `deliveryOk === true` and the token fields clean.

### 3-session isolation mode

`--isolation` concurrently drives every named session (default 3 derived from
`--session`, or explicit via `--sessions`) with a session-scoped id prefix
(`PREFIX-SESSION-NNN`). Each pane gets its own streaming observer (global
pattern) with a baseline + per-trial + final captures, so a foreign token that
appears briefly and is later evicted from scrollback still fails the run. A
session passes only when its tokens are intact AND every trial was cleanly
delivered (slash/send exit 0, send terminal `done`); a foreign token in a pane,
or any undelivered trial, fails the run. Live isolation does **not** require
`--session`. The deterministic equivalent (fakes, no Claude) runs in
`test/stress-reviewer.test.mjs` and `test/stress-streaming.test.mjs`; the live
path requires `--live --yes`.

## Honest limitations

1. **Model noncompliance can cause a conservative false failure.** The prompt
   asks Claude to acknowledge with a single `OK` and not repeat the token. If the
   model echoes the token anyway, the pane will show it twice and the run flags a
   spurious duplicate. This is conservative by design (a real double injection is
   indistinguishable from an echo) — re-run, or inspect the journal to confirm
   the command was injected exactly once.
2. **Scrollback budget (largely mitigated by streaming).** The harness no longer
   relies on one final capture; it ingests a snapshot after every send, so a
   token only needs to be visible briefly to be observed. Still raise
   `--capture-lines` or add `--sleep-ms` if a token is never visible in any
   retained snapshot (extremely busy panes). A lost token remains a real signal,
   not just a capture artifact — cross-check the journal.
3. **At-most-once, not exactly-once after a crash.** The bridge never
   automatically resends an `uncertain`/`injecting` command. A live crash during
   a trial is reported honestly; reconciliation marks it `interrupted` and
   `safeToRetry:false`. An operator decides whether to resend.
4. **Single host, non-FIFO across contenders.** Serialization is local-host per
   session. The stress harness drives one session sequentially, so contender
   fairness is out of scope here (see docs/RELIABILITY.md).
5. **Claude nondeterminism.** Claude may render tokens slowly or echo them in
   tool output; capture timing affects what is observed. The verdict reports
   observed state, never inferred success.
6. **Cost and time.** A 100-trial live run sends 100 real prompts and 100 slash
   commands. Budget for it.
7. **Real permission popups are not exercised.** Use `ccb start
   --safe-permissions` separately if you need popup coverage; the harness does
   not drive approvals.
8. **Slash autocomplete confirmation is heuristic.** Each trial's `slash` step
   uses `ccb slash`, which in waited mode now sends a bounded, guarded
   confirmation Enter when the bottom active input still contains exactly the
   submitted command (Claude Code v2.1.218 autocomplete otherwise leaves it
   staged). The match is ANSI/NBSP/whitespace-normalized and at most one extra
   Enter is sent; the outcome is in `readiness.confirmation`. This is a
   best-effort heuristic against live TUI rendering, not a guarantee — a
   confirmation that mis-fires (sent or withheld) surfaces as a delivery
   verdict failure, never a silent pass.
9. **Pre-injection idle baseline gates each slash.** A mode-changing slash is
   only injected once the pane is injectable under the lock: state `idle`, or
   state `done` only when classifier evidence proves an empty active prompt +
   footer with no spinner (a bare done marker is rejected — it is
   marker-complete, not proof of idle). A thinking/needs_input/permission/
   unknown/queued pane never receives it. A pane that stays busy past the
   budget yields a not-injected trial (`readiness.phase: "pre-injection"`,
   exit 7) rather than a risky injection. Reports distinguish this
   **pre-injection idle timeout** (`slashPhase=pre-injection`) from a
   **post-injection readiness timeout** (`slashPhase=post-injection`, exit 6).
   Because the gate must wait for stop hooks to finish, raise
   `--ready-timeout-ms` (or `--idle-timeout-ms`) for live runs that exercise
   heavy hooks (the harness already wires `config.readyTimeoutMs` into both the
   pre- and post-injection budgets). `send` status `done` is ccmux
   marker-complete, not a proof of pane-idle — see
   [RELIABILITY.md](./RELIABILITY.md#pre-injection-idle-baseline).
10. **Streaming is not perfect exactly-once proof.** Duplicate detection uses
    the maximum simultaneous count across retained snapshots. Two occurrences
    of a token that NEVER coexist in any single retained snapshot would read as
    count-1 and be missed. The at-most-once injection model and the command
    journal (`ccb commands --json`) make this case unlikely and independently
    auditable, but streaming observation alone is not a mathematical
    exactly-once proof.
11. **Post-injection observation is heuristic.** A `send` is acknowledged only
    after the observer sees the injection land: a tail re-render, **or** (after an
    idle baseline) a transition into `thinking`/`needs_input`/`permission_prompt`.
    The transition path was added because a long/wrapped prompt can leave the
    bottom tail byte-identical to the idle baseline — its spinner renders above
    the static footer — which was the `CCB100J30B` trial-27 false negative
    (`injection-not-observed` on a delivered prompt). It is gated on a quiescent
    baseline, so an already-busy pane can never falsely confirm delivery
    (at-most-once preserved). If neither signal fires within the budget the send
    is `uncertain` (exit 9) and never auto-retried; a transiently slow render can
    still cause a conservative false failure — inspect the pane and journal.

For the reliability model, exit codes, and recovery runbook, see
[RELIABILITY.md](./RELIABILITY.md).
