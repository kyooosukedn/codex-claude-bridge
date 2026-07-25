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
//   { createExclusive, read, rename, updateIfOwner, unlinkIfOwner }
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

  // Atomically move the canonical lock to a quarantine sibling. The quarantine
  // path MUST sit in the same directory as the canonical path, and a target
  // that already exists is never overwritten. Returns { renamed }.
  async function rename(filePath, quarantinePath) {
    const canonicalDir = path.resolve(path.dirname(filePath));
    const quarantineDir = path.resolve(path.dirname(quarantinePath));
    if (canonicalDir !== quarantineDir) return { renamed: false };

    // POSIX rename(2) silently overwrites an existing destination, which would
    // destroy a prior quarantine generation. Refuse instead.
    try {
      await fsp.stat(quarantinePath);
      return { renamed: false };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      await fsp.rename(filePath, quarantinePath);
      return { renamed: true };
    } catch (error) {
      // Source already moved by another contender, or target appeared in the
      // race window — either way this contender did not perform the rename.
      if (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST") {
        return { renamed: false };
      }
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

  return { createExclusive, read, rename, updateIfOwner, unlinkIfOwner };
}

// ---------------------------------------------------------------------------
// Acquire, release, and coordinate are implemented in later slices of this
// plan (Tasks 3-4). They are exported as failing stubs so the contract test
// module links and reports per-behavior RED until each lands.
// ---------------------------------------------------------------------------

export async function acquireSessionLock() {
  throw new Error("acquireSessionLock: not implemented in this slice");
}

export async function releaseSessionLock() {
  throw new Error("releaseSessionLock: not implemented in this slice");
}

export async function coordinateInjection() {
  throw new Error("coordinateInjection: not implemented in this slice");
}
