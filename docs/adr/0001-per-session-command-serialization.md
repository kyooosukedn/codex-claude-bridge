# ADR 0001: Per-session command serialization

- **Status:** Proposed, revision 2
- **Date:** 2026-07-25
- **Scope:** P1 serialization for `ccb send`, `ccb slash`, and `ccb steer`
- **Out of scope:** native Claude Channels, the R2 broker, remote/shared filesystems

## Decision

`ccb` will serialize only the terminal-injection critical section for a given
Claude session. It will not hold a lock while Claude performs the task.

The coordinator uses one local lockfile per session:

```text
$CCB_HOME/locks/<safe-session>.lock
```

Fresh ownership is created with `open(..., "wx")`. An existing lock is reclaimed
only when its recorded owner process is definitely dead. Time alone never makes a
live owner stale.

For `send`, `ccb` will split the public ccmux protocol:

```text
lock
  capture baseline
  ccmux send --session NAME PROMPT
  parse job JSON
  observe injection state change
unlock
ccmux wait JOB_ID --timeout-ms MS
```

The `ccmux wait` call is outside the lock. This preserves ccmux job state and lets
`steer` inject while Claude is still working.

## Why this boundary

The bridge has two different timelines:

1. **Injection:** baseline, paste, Enter, and evidence that the pane changed.
2. **Execution:** Claude thinks, uses tools, asks questions, and eventually emits
   `CCMUX_DONE:<job-id>`.

Only injection must be mutually exclusive. Locking execution would prevent a
same-session `steer` command from reaching Claude during a long task.

The lock guarantees mutual exclusion, not FIFO fairness. Codex should submit
dependent commands sequentially. Concurrent callers either acquire, wait with a
bounded policy, or receive a truthful busy result.

## Safety invariants

1. At most one live owner may inject into a session at a time.
2. Different sessions use different lockfiles and may inject concurrently.
3. A live owner is never displaced because a deadline elapsed.
4. Only a matching owner token may release a lock.
5. Dead-owner recovery still requires a fresh atomic acquire.
6. Once transport may have started, the command is never retried automatically.
7. Terminal waiting is always outside the injection lock.
8. Success is based on observed evidence, not a sleep or a guessed timeout.

## Lock record

The lockfile is a single JSON object:

```json
{
  "version": 1,
  "session": "reviewer",
  "ownerToken": "1f2f0c6e-...",
  "pid": 4321,
  "commandId": "68b6f8a2-...",
  "commandClass": "prompt",
  "phase": "pre-write",
  "createdAt": "2026-07-25T12:00:00.000Z",
  "updatedAt": "2026-07-25T12:00:00.000Z"
}
```

`phase` is one of:

- `pre-write`: no transport process has started; retry may be safe.
- `injecting`: transport was started; outcome may be uncertain.
- `acknowledged`: injection evidence was observed; terminal wait may proceed.

The phase is persisted before crossing each boundary. A record recovered in
`injecting` is reported as an abandoned uncertain command. Recovery never
silently resubmits it.

## Acquire

Fresh acquire:

1. Validate the session against `[A-Za-z0-9._-]+`.
2. Create the lock directory with user-only permissions.
3. Generate a random owner token and command id.
4. Open the canonical lockfile with `O_CREAT | O_EXCL`.
5. Write the complete `pre-write` record through that file handle.
6. Flush and close before returning ownership.

If the file already exists, read and validate it. Missing, malformed, or
permission-denied metadata fails closed. It is not evidence that the owner died.

## Owner liveness

Recovery is local-host only. The production liveness check uses
`process.kill(pid, 0)`:

- success: owner is live
- `EPERM`: owner may be live; fail closed
- `ESRCH`: owner is definitely absent and may be recovered
- every other result: unknown; fail closed

PID reuse is handled conservatively. If a dead owner's PID was reused, the lock
looks live and requires explicit operator repair. This trades availability for
safety. It cannot create two writers.

No TTL, lease expiry, or heartbeat is used as a fencing mechanism. A paused live
process may resume and write later; tmux has no fencing token that could reject
that writer. Therefore timeout-based stealing cannot be made safe here.

## Dead-owner recovery

When the owner is definitely dead:

1. Atomically rename the canonical lockfile to a unique quarantine path.
2. If rename fails because another contender moved it, restart acquisition.
3. Attempt a normal fresh `O_EXCL` acquire at the canonical path.
4. The process that performed the rename has no priority. Any contender may win
   the fresh acquire, and exactly one can win.
5. Preserve quarantine metadata for diagnostics until bounded cleanup.

The rename removes the dead generation. `O_EXCL` creates the new generation.
There is no unconditional overwrite and no read-then-replace claim.

## Release

A live owner is never reclaimed, so its canonical lock generation cannot be
replaced while it is allowed to release.

Release:

1. Read the canonical record.
2. Require exact `ownerToken` and `commandId` matches.
3. Unlink only on a match.
4. Missing or mismatched ownership is a no-op and a non-success result.

The critical proof is the no-live-reclaim invariant. Token comparison alone would
not fix a compare-then-unlink race if live owners could be replaced. Revision 1
allowed expiry replacement and therefore could let an old owner unlink a new
one. Revision 2 removes that state transition.

## Retry classification

Retry is based on the last proven phase:

| Failure point | Classification | Auto-retry |
| --- | --- | --- |
| Validation or baseline capture, before spawn | `not-injected` | bounded |
| Lock busy or owner liveness unknown | `busy` | bounded wait only |
| `ccmux` spawn attempted | `uncertain` until proven otherwise | never |
| `ccmux` nonzero, timeout, or malformed output after spawn | `uncertain` | never |
| Job JSON valid and observed barrier passes | `injected` | never |
| Job JSON valid but observed barrier fails | `uncertain` | never |

This is deliberately conservative. `ccmux send` can fail after a paste or Enter,
so a nonzero exit is not proof that nothing was delivered.

## `send` protocol

`ccb send` must use ccmux's public CLI, not import its global internal
`core.mjs`.

Inside the lock:

1. Capture a pane baseline before transport starts.
2. Persist phase `injecting`.
3. spawn `ccmux send --session <name> <prompt>` without `--wait`.
4. Parse exactly one job object and require non-empty `id`, matching `session`,
   `status: "sent"`, and a valid `sentAt`.
5. Run a bounded observed barrier against the baseline. Accept evidence such as
   pane signature change, a transition to `thinking`/`needs_input`, or the job id
   appearing in the pane. A fixed sleep is not acknowledgment.
6. Persist `acknowledged`, release, and retain the job id.

Outside the lock:

```text
ccmux wait <job-id> --timeout-ms <ms> --settle-ms <ms>
```

This keeps ccmux responsible for `makeJob`, prompt wrapping, state.json,
`CCMUX_DONE`, and done-file handling. It also avoids binding `ccb` to an
undocumented module path or export surface.

## `slash` protocol

`slash` keeps its existing fail-closed readiness behavior:

1. acquire
2. capture baseline
3. paste and Enter
4. wait for the existing observed readiness barrier
5. release

A baseline failure before paste is `not-injected`. Any failure after paste starts
is `uncertain`. Existing exit codes 0, 6, and 7 remain stable.

## `steer` protocol

`steer` acquires the same per-session lock, performs one ccmux/tmux injection,
observes transport success, and releases immediately. It does not require Claude
to be idle and does not wait for terminal completion.

Because `send` releases before `ccmux wait`, `steer` can acquire while the prompt
job is running.

## Failure and operator behavior

- Live but stuck owner: report owner PID, command id, phase, and lock path.
- Dead `pre-write` owner: quarantine and allow a new command.
- Dead `injecting` owner: quarantine, report abandoned uncertain command, and do
  not retry that command.
- Malformed lock: fail closed and require `ccb doctor`/manual repair.
- PID reuse: fail closed and require repair.
- tmux server loss: transport fails; post-spawn result is uncertain.

A future repair command must inspect and display evidence before deleting a lock.
It must never silently run during normal acquire.

## Testing requirements

Contract tests must prove:

- same-session exclusion
- different-session concurrency
- steer after send acknowledgment but before terminal completion
- old timestamps do not displace a live PID
- concurrent recovery of one dead owner produces exactly one new owner
- a delayed old token cannot release the new owner
- post-spawn uncertainty is never retried
- pre-write failure is the only retryable injection failure
- public ccmux `send` and `wait` occur on opposite sides of release

At least one test must use real child processes and the production filesystem
store. In-memory tests alone cannot prove `O_EXCL` or rename behavior.

## Consequences

Positive:

- no paid SDK or API dependency
- persistent ccmux jobs remain authoritative
- safe same-session injection and concurrent independent sessions
- steering remains available during long Claude tasks
- crash recovery favors at-most-once behavior

Negative:

- a live stuck owner requires operator action
- PID reuse can conservatively block recovery
- the coordinator is local-host only
- `ccb send` must parse ccmux's public JSON output and preserve uncertain states

## Future boundary

R2 may replace the local lock with a broker queue and durable session registry.
That can add FIFO scheduling and stronger lifecycle recovery. It is not started
here while native Channels R0 remains NO-GO. The injection/terminal split and
at-most-once state model are designed to remain valid behind that future broker.
