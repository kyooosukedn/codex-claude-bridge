// P1 per-session command serialization coordinator.
//
// Problem this closes: concurrent `send`, `slash`, and `steer` injections into
// one Claude session can interleave and corrupt the prompt stream, yet locking
// the whole task would block a same-session `steer` while Claude is thinking.
// This module serializes only the terminal-injection critical section using a
// daemon-free local lockfile, then releases before any terminal wait.
//
// Safety model (see docs/adr/0001-per-session-command-serialization.md):
//   - Fresh ownership is created with O_EXCL (open "wx").
//   - An existing lock is reclaimed ONLY when its recorded owner PID is
//     definitely dead, proven by process.kill(pid, 0) returning ESRCH. Time
//     alone never makes a live owner stale — no TTL, lease, or heartbeat.
//   - Dead-owner recovery renames the canonical lock to a UUID quarantine
//     sibling, then requires a fresh O_EXCL win. The renamer gets no priority.
//   - Once transport may have started (phase "injecting"), a failure is
//     "uncertain" and is never retried automatically — at-most-once injection.
//
// The store is injected so contract tests drive an in-memory FakeStore while
// filesystem tests drive the real O_EXCL/rename behavior below.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Session names map 1:1 to lockfile basenames, so they must be path-safe:
// no separators, no traversal. `[A-Za-z0-9._-]+` plus an explicit refusal of
// "." / ".." keeps the name a single path component under the lock directory.
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_LOCK_DIR = process.env.CCB_HOME
  ? path.join(process.env.CCB_HOME, "locks")
  : path.join(os.homedir(), ".codex-claude-bridge", "locks");

// Pre-write failures (baseline capture, validation, pre-spawn) are the only
// retryable injection failures. Transport-started failures never retry.
export const DEFAULT_PRE_WRITE_ATTEMPTS = 3;

// Validate a session name and return the safe single-component string.
// Throws on anything containing a path separator, empty, or a traversal dot.
export function validateSessionName(session) {
  const value = String(session ?? "");
  if (!SESSION_NAME_RE.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid session name: ${JSON.stringify(session)}`);
  }
  return value;
}

// Resolve the canonical lockfile path for a session under a lock directory.
// The validated name is a single component, and we additionally assert the
// resolved path cannot escape the directory.
export function resolveLockPath(session, lockDir = DEFAULT_LOCK_DIR) {
  const safe = validateSessionName(session);
  const dir = path.resolve(lockDir);
  const resolved = path.resolve(dir, `${safe}.lock`);
  const relative = path.relative(dir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Session name resolves outside the lock directory: ${JSON.stringify(session)}`);
  }
  return resolved;
}

// Production lock store backed by the local filesystem. Returns the injected
// store contract:
//   { createExclusive, read, claimDeadGeneration, updateIfOwner, unlinkIfOwner }
//
// Every method returns an explicit result object. Expected contention, missing
// files, and owner mismatch are never represented by swallowed exceptions.
export function createFileLockStore(options = {}) {
  const fsp = options.fs ?? fs;
  const randomUUID = options.randomUUID ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);

  // O_EXCL create. Writes the full serialized record through the handle,
  // fsyncs, then closes. Returns { created } — false on EEXIST, never throws
  // for the expected "already owned" collision.
  async function createExclusive(filePath, record) {
    let handle;
    try {
      handle = await fsp.open(filePath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") return { created: false };
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { created: true };
  }

  // Read and parse a canonical record. Returns null for a missing file.
  // Unparseable bytes are a malformed lock: throw an error flagged .malformed
  // so callers can fail closed instead of guessing the owner is absent.
  async function read(filePath) {
    let content;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(content);
    } catch (error) {
      const wrapped = new Error(`Malformed lock record at ${filePath}: ${error.message}`);
      wrapped.malformed = true;
      wrapped.path = filePath;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  // Atomically claim a dead generation for recovery by hard-linking the
  // canonical lock into a quarantine tombstone. fs.link is a single syscall
  // that fails with EEXIST if the tombstone already exists, so exactly one
  // contender wins the claim with no precheck/rename TOCTOU — and without
  // touching canonical. The tombstone is preserved for diagnostics; there is
  // no eager cleanup. The quarantine path MUST sit in the same directory as
  // the canonical path. Returns { claimed }.
  async function claimDeadGeneration(canonical, quarantine) {
    const canonicalDir = path.resolve(path.dirname(canonical));
    const quarantineDir = path.resolve(path.dirname(quarantine));
    if (canonicalDir !== quarantineDir) return { claimed: false };
    try {
      await fsp.link(canonical, quarantine);
      return { claimed: true };
    } catch (error) {
      // EEXIST: another contender already claimed this generation.
      // ENOENT: canonical vanished (recovered or released) before we linked.
      if (error.code === "EEXIST" || error.code === "ENOENT") return { claimed: false };
      throw error;
    }
  }

  // Conditional update for the current owner only. Verifies ownerToken AND
  // commandId, then writes a temp sibling, fsyncs, and atomically renames it
  // over the canonical file so a crash cannot leave a truncated record.
  // Missing, malformed, or mismatched records are a no-op { updated: false }.
  async function updateIfOwner(filePath, ownerToken, commandId, patch) {
    let record;
    try {
      record = await read(filePath);
    } catch (error) {
      if (error.malformed) return { updated: false };
      throw error;
    }
    if (
      !record ||
      record.ownerToken !== ownerToken ||
      record.commandId !== commandId
    ) {
      return { updated: false };
    }
    const next = { ...record, ...structuredClone(patch) };
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(tmp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    try {
      await fsp.rename(tmp, filePath);
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {});
      throw error;
    }
    return { updated: true };
  }

  // Conditional unlink for the current owner only. Verifies ownerToken AND
  // commandId before unlinking. Missing, malformed, or mismatched records
  // (including a lock recovered by a new owner) are a no-op { unlinked: false }.
  async function unlinkIfOwner(filePath, ownerToken, commandId) {
    let record;
    try {
      record = await read(filePath);
    } catch (error) {
      if (error.malformed) return { unlinked: false };
      throw error;
    }
    if (
      !record ||
      record.ownerToken !== ownerToken ||
      record.commandId !== commandId
    ) {
      return { unlinked: false };
    }
    try {
      await fsp.unlink(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return { unlinked: false };
      throw error;
    }
    return { unlinked: true };
  }

  return { createExclusive, read, claimDeadGeneration, updateIfOwner, unlinkIfOwner };
}

// ---------------------------------------------------------------------------
// Acquire (Task 3). Release and coordinate land in Task 4.
// ---------------------------------------------------------------------------

// Normalize liveness inputs that may be boolean (in-memory tests) or the
// production tristate. true/"live" => live; false/"dead" => dead; anything
// else => unknown (fail closed).
function classifyAlive(result) {
  if (result === true || result === "live") return "live";
  if (result === false || result === "dead") return "dead";
  return "unknown";
}

// Production liveness probe. process.kill(pid, 0) sends no signal; only its
// error code is meaningful: ESRCH proves the PID is absent, EPERM or anything
// else is uncertain and must fail closed (PID reuse, permissions, etc.).
export function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

// Structural validation of a canonical lock record. A record missing required
// fields or carrying a non-integer pid cannot prove its owner is dead, so it
// is treated as malformed and fails closed rather than being recovered.
function validateLockRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (record.version !== 1) return null;
  if (typeof record.session !== "string" || record.session.length === 0) return null;
  if (typeof record.ownerToken !== "string" || record.ownerToken.length === 0) return null;
  if (typeof record.commandId !== "string" || record.commandId.length === 0) return null;
  if (typeof record.commandClass !== "string") return null;
  if (typeof record.phase !== "string") return null;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
  return record;
}

async function ensureLockDir(lockDir) {
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
}

// Attempt to acquire ownership of a session's lock. Fresh ownership is created
// with O_EXCL. On collision the existing owner is checked: a live or uncertain
// owner fails closed; only a definitely-dead owner is recovered, by renaming
// the canonical lock to a quarantine sibling and then requiring a fresh O_EXCL
// win. The renamer gets no priority — any contender may win the fresh acquire,
// and exactly one can.
//
// The acquire is single-pass: at most one rename and one fresh createExclusive.
// This is what guarantees exactly one winner when many contenders race a dead
// owner whose liveness probe reports dead regardless of pid.
export async function acquireSessionLock({
  session,
  commandId,
  commandClass = "prompt",
  pid,
  lockDir = DEFAULT_LOCK_DIR,
  store = createFileLockStore(),
  isProcessAlive = defaultIsProcessAlive,
  randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto),
  now = () => new Date(),
}) {
  const states = ["queued"];

  let lockPath;
  try {
    lockPath = resolveLockPath(session, lockDir);
  } catch (error) {
    return { acquired: false, reason: "io-error", error: error.message, lockPath: null, states };
  }

  const ownerToken = randomUUID();
  const commandIdResolved = commandId ?? randomUUID();
  const timestamp = now().toISOString();
  const record = {
    version: 1,
    session,
    ownerToken,
    pid,
    commandId: commandIdResolved,
    commandClass,
    phase: "pre-write",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  states.push("pre-write");

  // O_EXCL acquire. The lock directory is created lazily — only if the store
  // reports ENOENT — so the common path is a single store call. That keeps a
  // pure in-memory contention race deterministic (microtask lockstep), since no
  // real filesystem I/O on the hot path can scatter contenders out of order.
  let first;
  try {
    first = await store.createExclusive(lockPath, record);
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states };
    }
    try {
      await ensureLockDir(path.dirname(lockPath));
      first = await store.createExclusive(lockPath, record);
    } catch (retryError) {
      return { acquired: false, reason: "io-error", error: retryError.message, lockPath, ownerToken, commandId: commandIdResolved, states };
    }
  }
  if (first.created) {
    return {
      acquired: true,
      reason: "created",
      lockPath,
      ownerToken,
      commandId: commandIdResolved,
      recovered: false,
      priorPhase: null,
      quarantinePath: null,
      heldBy: null,
      states,
    };
  }

  // Collision: read and validate the existing canonical record. A missing file
  // means another contender already quarantined it; fail closed as contended.
  let existing;
  try {
    existing = await store.read(lockPath);
  } catch (error) {
    if (error.malformed) {
      return { acquired: false, reason: "malformed-lock", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy: null };
    }
    return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states };
  }
  if (existing === null) {
    return { acquired: false, reason: "contended", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy: null };
  }
  const validated = validateLockRecord(existing);
  if (!validated) {
    return { acquired: false, reason: "malformed-lock", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy: existing };
  }

  const heldBy = {
    pid: validated.pid,
    commandId: validated.commandId,
    commandClass: validated.commandClass,
    ownerToken: validated.ownerToken,
    phase: validated.phase,
  };

  let alive;
  try {
    alive = classifyAlive(await isProcessAlive(validated.pid));
  } catch {
    alive = "unknown";
  }
  if (alive === "live") {
    return { acquired: false, reason: "live-owner", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }
  if (alive === "unknown") {
    return { acquired: false, reason: "unknown-owner", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }

  // Definitely dead: claim the dead generation with an atomic hard link into a
  // deterministic quarantine tombstone, then unlink the canonical lock and
  // require a fresh O_EXCL win. The tombstone path is derived from the dead
  // owner's owner token, so every contender that read THIS dead generation aims
  // at the same tombstone. fs.link fails with EEXIST if the tombstone already
  // exists, so exactly one contender wins the claim — atomically, with no
  // precheck/rename TOCTOU and without touching canonical. Only the claim
  // winner verifies the linked record is still the dead generation, unlinks the
  // definitely-dead canonical lock, and attempts the fresh acquire. A fresh
  // owner's canonical lock can never be removed this way: by the time a fresh
  // owner exists the tombstone already exists, so no other contender can claim.
  // No timestamp/TTL fencing; ownership comes solely from the fresh O_EXCL.
  const priorPhase = validated.phase;
  const quarantinePath = path.join(
    path.dirname(lockPath),
    `${path.basename(lockPath)}.${validated.ownerToken}.quarantine`,
  );
  let claim;
  try {
    claim = await store.claimDeadGeneration(lockPath, quarantinePath);
  } catch (error) {
    return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }
  if (!claim.claimed) {
    // Another contender already claimed this dead generation (or canonical
    // vanished). Do not touch canonical; that contender finishes recovery.
    return {
      acquired: false,
      reason: "contended",
      lockPath,
      ownerToken,
      commandId: commandIdResolved,
      recovered: false,
      priorPhase,
      quarantinePath,
      heldBy: null,
      states,
    };
  }
  // Safety net: confirm the tombstone still holds the dead generation we
  // validated. With the deterministic tombstone this cannot legitimately fail,
  // but if canonical was somehow replaced between read and link we abstain
  // without unlinking canonical.
  let tombstone;
  try {
    tombstone = await store.read(quarantinePath);
  } catch (error) {
    if (error.malformed) {
      return { acquired: false, reason: "malformed-lock", lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
    }
    return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }
  if (!tombstone || tombstone.ownerToken !== validated.ownerToken) {
    return {
      acquired: false,
      reason: "contended",
      lockPath,
      ownerToken,
      commandId: commandIdResolved,
      recovered: false,
      priorPhase,
      quarantinePath,
      heldBy: null,
      states,
    };
  }
  // Remove the dead owner's canonical lock. Only the claim winner reaches here,
  // so canonical is unlinked exactly once; the dead generation persists as the
  // quarantine tombstone (same inode via the hard link).
  let removed;
  try {
    removed = await store.unlinkIfOwner(lockPath, validated.ownerToken, validated.commandId);
  } catch (error) {
    return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }
  if (!removed.unlinked) {
    return {
      acquired: false,
      reason: "contended",
      lockPath,
      ownerToken,
      commandId: commandIdResolved,
      recovered: false,
      priorPhase,
      quarantinePath,
      heldBy: null,
      states,
    };
  }
  // Fresh O_EXCL acquire at the now-free canonical path.
  let fresh;
  try {
    fresh = await store.createExclusive(lockPath, record);
  } catch (error) {
    return { acquired: false, reason: "io-error", error: error.message, lockPath, ownerToken, commandId: commandIdResolved, states, heldBy };
  }
  if (fresh.created) {
    return {
      acquired: true,
      reason: "recovered-dead-owner",
      lockPath,
      ownerToken,
      commandId: commandIdResolved,
      recovered: true,
      priorPhase,
      quarantinePath,
      heldBy: null,
      states,
    };
  }
  return {
    acquired: false,
    reason: "contended",
    lockPath,
    ownerToken,
    commandId: commandIdResolved,
    recovered: false,
    priorPhase,
    quarantinePath,
    heldBy: null,
    states,
  };
}

// ---------------------------------------------------------------------------
// Release and coordinate land in Task 4. Exported as failing stubs so the
// contract test module continues to link and report per-behavior RED.
// ---------------------------------------------------------------------------

export async function releaseSessionLock({
  lockPath,
  ownerToken,
  commandId,
  store = createFileLockStore(),
}) {
  try {
    const result = await store.unlinkIfOwner(lockPath, ownerToken, commandId);
    return {
      released: result.unlinked === true,
      reason: result.unlinked === true ? "released" : "not-owner",
    };
  } catch (error) {
    return { released: false, reason: "io-error", error: error.message };
  }
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function coordinateInjection({
  session,
  commandId,
  commandClass = "prompt",
  pid = process.pid,
  lockDir = DEFAULT_LOCK_DIR,
  store = createFileLockStore(),
  isProcessAlive = defaultIsProcessAlive,
  randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto),
  now = () => new Date(),
  maxPreWriteAttempts = DEFAULT_PRE_WRITE_ATTEMPTS,
  captureBaseline,
  inject,
  observeInjection,
}) {
  if (typeof captureBaseline !== "function" || typeof inject !== "function") {
    throw new TypeError("captureBaseline and inject are required");
  }

  const resolvedCommandId = commandId || randomUUID();
  const attemptsLimit = Math.max(1, Number(maxPreWriteAttempts) || 1);

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    const acquired = await acquireSessionLock({
      session,
      commandId: resolvedCommandId,
      commandClass,
      pid,
      lockDir,
      store,
      isProcessAlive,
      randomUUID,
      now,
    });

    if (!acquired.acquired) {
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "busy",
        attempts: attempt,
        injectedAt: null,
        reason: acquired.reason,
        payload: null,
        states: [...(acquired.states || ["queued"]), "busy"],
      };
    }

    const states = [...(acquired.states || ["queued"]), "pre-write"];
    let baseline;
    try {
      baseline = await captureBaseline();
    } catch (error) {
      await releaseSessionLock({
        lockPath: acquired.lockPath,
        ownerToken: acquired.ownerToken,
        commandId: acquired.commandId,
        store,
      });
      if (attempt < attemptsLimit) continue;
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "not-injected",
        attempts: attempt,
        injectedAt: null,
        reason: "baseline-error",
        payload: null,
        states: [...states, "released"],
        error: error.message,
      };
    }

    const phaseUpdate = await store.updateIfOwner(
      acquired.lockPath,
      acquired.ownerToken,
      acquired.commandId,
      { phase: "injecting", updatedAt: asIso(now()) },
    );
    if (!phaseUpdate.updated) {
      await releaseSessionLock({
        lockPath: acquired.lockPath,
        ownerToken: acquired.ownerToken,
        commandId: acquired.commandId,
        store,
      });
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "not-injected",
        attempts: attempt,
        injectedAt: null,
        reason: "phase-update-failed",
        payload: null,
        states: [...states, "released"],
      };
    }

    states.push("injecting");
    let payload;
    try {
      payload = await inject({ baseline, commandId: resolvedCommandId });
    } catch (error) {
      await releaseSessionLock({
        lockPath: acquired.lockPath,
        ownerToken: acquired.ownerToken,
        commandId: acquired.commandId,
        store,
      });
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "uncertain",
        attempts: attempt,
        injectedAt: null,
        reason: "transport-error",
        payload: null,
        states: [...states, "released"],
        error: error.message,
      };
    }

    let observation = { observed: true, reason: "transport-returned" };
    if (typeof observeInjection === "function") {
      try {
        observation = await observeInjection({ baseline, payload });
      } catch (error) {
        observation = { observed: false, reason: "observation-error", error };
      }
    }

    if (!observation || observation.observed !== true) {
      await releaseSessionLock({
        lockPath: acquired.lockPath,
        ownerToken: acquired.ownerToken,
        commandId: acquired.commandId,
        store,
      });
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "uncertain",
        attempts: attempt,
        injectedAt: null,
        reason: observation?.reason || "not-observed",
        payload,
        states: [...states, "released"],
      };
    }

    const injectedAt = asIso(now());
    const acknowledged = await store.updateIfOwner(
      acquired.lockPath,
      acquired.ownerToken,
      acquired.commandId,
      { phase: "acknowledged", updatedAt: injectedAt },
    );
    const released = await releaseSessionLock({
      lockPath: acquired.lockPath,
      ownerToken: acquired.ownerToken,
      commandId: acquired.commandId,
      store,
    });

    if (!acknowledged.updated || !released.released) {
      return {
        commandId: resolvedCommandId,
        commandClass,
        session,
        ack: "uncertain",
        attempts: attempt,
        injectedAt: null,
        reason: !acknowledged.updated ? "ack-update-failed" : "release-failed",
        payload,
        states,
      };
    }

    return {
      commandId: resolvedCommandId,
      commandClass,
      session,
      ack: "injected",
      attempts: attempt,
      injectedAt,
      reason: observation.reason || "observed",
      payload,
      states: [...states, "acknowledged", "released"],
    };
  }

  throw new Error("unreachable");
}
