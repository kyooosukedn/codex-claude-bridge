# P1 Per-session Serialization Implementation Plan

> Execute with `superpowers:test-driven-development`. One task, one focused
> commit. Codex reviews and accepts; Claude workers do not accept their own work.

**Goal:** Prevent concurrent `send`, `slash`, and `steer` injections from
interleaving within one Claude session while preserving cross-session concurrency
and same-session steering during a long Claude task.

**Architecture:** Add a daemon-free local coordinator backed by an `O_EXCL`
lockfile. Reclaim only a definitely dead PID through an atomic hard-link
generation claim plus fresh `O_EXCL`. Split public ccmux `send` and `wait`; hold the lock through
observed injection acknowledgment, then wait outside it.

**ADR:** `docs/adr/0001-per-session-command-serialization.md`

## Constraints

- Do not start the R2 native broker.
- Do not import global ccmux `core.mjs`.
- Do not auto-steal a lock based on age, TTL, or heartbeat.
- Do not retry after transport may have started.
- Do not claim FIFO ordering.
- Do not commit `.ccmux/`, prompts, logs, tokens, or temp repro files.
- Preserve slash exit codes 0, 6, and 7.

## Files

Create:

- `lib/session-coordinator.mjs`
- `test/session-coordinator-fs.test.mjs`
- `test/send-serialization.test.mjs`

Modify:

- `bin/codex-claude-bridge.mjs`
- `package.json`
- `docs/RELIABILITY.md`

Already present:

- `test/session-coordinator.test.mjs`

## Public module contract

`lib/session-coordinator.mjs` exports:

```js
export const DEFAULT_LOCK_DIR;
export const DEFAULT_PRE_WRITE_ATTEMPTS;

export function validateSessionName(session);
export function createFileLockStore(options = {});

export async function acquireSessionLock({
  session,
  commandId,
  commandClass,
  pid,
  lockDir,
  store,
  isProcessAlive,
  randomUUID,
  now,
});

export async function releaseSessionLock({
  lockPath,
  ownerToken,
  commandId,
  store,
});

export async function coordinateInjection({
  session,
  commandId,
  commandClass,
  pid,
  lockDir,
  store,
  isProcessAlive,
  randomUUID,
  now,
  maxPreWriteAttempts,
  captureBaseline,
  inject,
  observeInjection,
});
```

The injected store contract is:

```js
{
  createExclusive(filePath, record),
  read(filePath),
  claimDeadGeneration(filePath, quarantinePath),
  updateIfOwner(filePath, ownerToken, commandId, patch),
  unlinkIfOwner(filePath, ownerToken, commandId),
}
```

Production methods must return explicit result objects. Expected contention,
missing files, and owner mismatch are not represented by swallowed exceptions.

## Result model

Acquire result:

```js
{
  acquired: boolean,
  reason:
    | "created"
    | "recovered-dead-owner"
    | "live-owner"
    | "unknown-owner"
    | "malformed-lock"
    | "contended"
    | "io-error",
  lockPath,
  ownerToken,
  commandId,
  recovered,
  priorPhase,
  quarantinePath,
  heldBy,
}
```

Coordinate result:

```js
{
  commandId,
  commandClass,
  session,
  ack: "injected" | "not-injected" | "uncertain" | "busy" | "error",
  attempts,
  injectedAt,
  reason,
  payload,
  states,
}
```

`states` uses:

```text
queued -> pre-write -> injecting -> acknowledged -> released
```

Terminal states are tracked by ccmux after release, not by the lock record.

## Task 1: Land the RED contract

Files:

- Verify `test/session-coordinator.test.mjs`

Steps:

1. Run:

   ```powershell
   node --test test/session-coordinator.test.mjs
   ```

2. Require failure caused only by:

   ```text
   ERR_MODULE_NOT_FOUND: lib/session-coordinator.mjs
   ```

3. Confirm contracts cover:

   - same-session exclusion
   - different-session concurrency
   - live PID despite old timestamp
   - concurrent dead-owner recovery
   - old-token-safe release
   - uncertain post-spawn no retry
   - pre-write retry only
   - steering before terminal completion

Do not add a placeholder module merely to make imports pass.

## Task 2: Implement validation and production store

Files:

- Create `lib/session-coordinator.mjs`
- Create `test/session-coordinator-fs.test.mjs`

Implement:

1. Validate session with `[A-Za-z0-9._-]+`.
2. Resolve lock path only under `$CCB_HOME/locks`.
3. Create directories as user-only where the platform supports modes.
4. `createExclusive` uses `fs.promises.open(path, "wx", 0o600)`, writes the full
   serialized record through that handle, calls `handle.sync()`, then closes.
5. `claimDeadGeneration` uses `fs.link` to create a deterministic quarantine
   tombstone without overwriting an existing generation claim.
6. `updateIfOwner` verifies token and command id, writes a temp sibling, syncs,
   then atomically renames over the canonical file. Only the current live owner
   calls this operation.
7. `unlinkIfOwner` refuses missing, malformed, or mismatched records.

Filesystem tests:

- real `O_EXCL` permits one winner across child processes
- real hard-link claim permits one contender for a dead generation
- quarantine names cannot escape the lock directory
- malformed canonical lock fails closed
- mode is `0600` on POSIX

Commands:

```powershell
node --test test/session-coordinator-fs.test.mjs
node --test test/session-coordinator.test.mjs
```

Commit:

```text
Add atomic per-session lock store
```

## Task 3: Implement acquire and dead-owner recovery

Files:

- Modify `lib/session-coordinator.mjs`
- Extend `test/session-coordinator-fs.test.mjs`

Algorithm:

1. Try normal `createExclusive`.
2. On success, return owner.
3. On collision, read and validate canonical record.
4. Call injected `isProcessAlive(pid)`.
5. Treat `true` and `unknown` as non-reclaimable.
6. Only `false`, backed by `ESRCH` in production, enters recovery.
7. Hard-link canonical to a deterministic quarantine path derived from the dead
   owner token.
8. Only the link winner verifies the tombstone and unlinks canonical.
9. Return ownership only after a new `createExclusive` succeeds.

Production liveness:

```js
try {
  process.kill(pid, 0);
  return "live";
} catch (error) {
  if (error.code === "ESRCH") return "dead";
  return "unknown";
}
```

Required race test:

- seed one dead-owner lock
- spawn at least eight child contenders
- release all contenders with one synchronization barrier
- assert exactly one returns `acquired: true`
- assert canonical metadata equals that winner
- assert no contender reports ownership merely because it won the hard-link claim

Do not use timestamps as a reclaim predicate.

Commit:

```text
Recover locks only from definitely dead owners
```

## Task 4: Implement phase updates, release, and retry policy

Files:

- Modify `lib/session-coordinator.mjs`
- Verify `test/session-coordinator.test.mjs`

`coordinateInjection` sequence:

1. Acquire.
2. Run `captureBaseline` while phase is `pre-write`.
3. On proven pre-write failure, release and retry up to
   `maxPreWriteAttempts`.
4. Persist phase `injecting` before calling `inject`.
5. From this point, any throw is `uncertain`; never retry.
6. Validate the injection payload.
7. Run `observeInjection`.
8. Missing evidence is `uncertain`; never retry.
9. Persist `acknowledged`.
10. Release in `finally`.

Release must require both owner token and command id.

Required tests:

- wrong token cannot unlink
- delayed old token cannot unlink recovered owner
- throw before `inject` retries
- throw from `inject` executes once
- malformed injection payload executes once
- observed barrier failure executes once

Commit:

```text
Add at-most-once injection coordinator
```

## Task 5: Split `send` injection from terminal wait

Files:

- Modify `bin/codex-claude-bridge.mjs`
- Create `test/send-serialization.test.mjs`

Add a dependency-injected `executeSend` function. Keep the CLI branch thin.

Inside `coordinateInjection`:

1. capture existing pane baseline
2. spawn public command:

   ```text
   ccmux send --session <session> <prompt>
   ```

3. do not pass `--wait`
4. parse stdout as one JSON object
5. require:

   - non-empty string `id`
   - matching `session`
   - `status === "sent"`
   - parseable `sentAt`

6. run a bounded readiness observation against the baseline
7. return the validated job as payload

After `coordinateInjection` returns `ack: "injected"` and the lock is released:

```text
ccmux wait <job.id> --timeout-ms <timeout> --settle-ms <settle>
```

Never import `claude-code-tmux/src/core.mjs`. Never reconstruct ccmux's wrapped
prompt. ccmux remains owner of job ids, `CCMUX_DONE`, done files, and state.

Failure classification:

- failure before subprocess spawn: `not-injected`
- any nonzero, timeout, or malformed stdout after spawn: `uncertain`
- valid job plus failed observed barrier: `uncertain`

Tests use fake subprocess and fake observer:

- `send` args omit `--wait`
- `ccmux wait` starts after release event
- job id passed to wait exactly matches send output
- malformed output does not retry
- nonzero after spawn does not retry
- steer acquires before fake terminal wait resolves

Commit:

```text
Split ccmux send acknowledgment from terminal wait
```

## Task 6: Route `slash` and `steer`

Files:

- Modify `bin/codex-claude-bridge.mjs`
- Extend existing slash tests
- Create focused steer serialization tests

Slash:

- wrap existing `executeSlash` injection in `coordinateInjection`
- preserve baseline-before-paste behavior
- preserve exit 7 for baseline failure
- preserve exit 6 for delivered but not ready
- map every post-paste failure to uncertain

Steer:

- wrap the existing steer transport in `coordinateInjection`
- do not require idle state
- do not wait for terminal completion
- map transport-started failure to uncertain

Required integration order:

```text
send acquire
send inject
send observed ack
send release
steer acquire
steer inject
steer release
send terminal completion
```

Commit:

```text
Serialize slash and steer injection per session
```

## Task 7: Wire tests and reliability docs

Files:

- Modify `package.json`
- Modify `docs/RELIABILITY.md`

Add coordinator unit and integration tests to `npm test`. Do not leave critical
tests as manually invoked files.

Document:

- local-host scope
- no FIFO guarantee
- live stuck owner requires repair
- PID reuse fails closed
- post-spawn uncertainty is not retried
- send lock excludes terminal wait

Commands:

```powershell
npm test
npm run test:native
npm run check
```

Commit:

```text
Document and enforce serialization reliability
```

## Acceptance

Automated:

- all old 67 control tests remain green
- all old 40 native tests remain green
- new contract, filesystem race, and CLI ordering tests are green
- Windows and Ubuntu CI are green
- installed npm-junction CLI test remains green

Manual:

1. Start one Claude session.
2. Launch a long `ccb send`.
3. While Claude is thinking, run `ccb steer`.
4. Confirm steer arrives before the send terminal marker.
5. Race two same-session injection attempts; confirm no interleaved prompt.
6. Run sends against two sessions; confirm both inject concurrently.
7. Kill an owner in `pre-write`; confirm one contender recovers.
8. Kill an owner in `injecting`; confirm the abandoned command is reported
   uncertain and not resubmitted.

## Review gate

Reject implementation if any of these appear:

- `expiresAt`, lease TTL, or heartbeat used for reclaim
- unconditional overwrite of canonical ownership
- dynamic import of global ccmux internals
- `ccmux send --wait` inside the lock
- automatic retry after subprocess spawn
- sleeps used as injection acknowledgment
- tests omitted from `npm test`
- R2 broker work mixed into P1
