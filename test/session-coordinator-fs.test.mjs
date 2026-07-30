// Filesystem-backed contract for the P1 per-session coordinator.
//
// lib/session-coordinator.mjs ships a production file lock store. These tests
// prove the real-filesystem primitives an in-memory FakeStore cannot: O_EXCL
// across child processes, atomic rename, quarantine containment, the 0600 mode
// on POSIX, and fail-closed handling of a malformed canonical lock.
//
// Acquire / dead-owner-recovery races that drive the same store through real
// child processes live at the bottom of this file (added with Task 3).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireSessionLock,
  createFileLockStore,
  DEFAULT_LOCK_DIR,
  DEFAULT_PRE_WRITE_ATTEMPTS,
} from "../lib/session-coordinator.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_URL = pathToFileURL(path.resolve(HERE, "../lib/session-coordinator.mjs")).href;
const IS_POSIX = process.platform !== "win32";

async function mkLockDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ccb-coord-"));
}

function sampleRecord(overrides = {}) {
  return {
    version: 1,
    session: "reviewer",
    ownerToken: "owner-1",
    pid: 4321,
    commandId: "command-1",
    commandClass: "prompt",
    phase: "pre-write",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

// Run a child node process whose -e body is ESM, resolving with stdout/stderr.
function runChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`child exited ${code}\nstdout: ${out}\nstderr: ${err}`));
        return;
      }
      resolve({ out, err });
    });
  });
}

test("exports a default lock dir and pre-write attempt budget", () => {
  assert.equal(typeof DEFAULT_LOCK_DIR, "string");
  assert.ok(DEFAULT_LOCK_DIR.length > 0);
  assert.ok(DEFAULT_PRE_WRITE_ATTEMPTS >= 1);
});

test("createExclusive writes a 0600 record and wins once", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });
  const record = sampleRecord();

  const first = await store.createExclusive(target, record);
  assert.equal(first.created, true);

  const second = await store.createExclusive(target, sampleRecord({ ownerToken: "owner-2" }));
  assert.equal(second.created, false);

  const readBack = await store.read(target);
  assert.equal(readBack.ownerToken, "owner-1");

  if (IS_POSIX) {
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("read returns null for missing and throws malformed for garbage", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });

  assert.equal(await store.read(target), null);

  await fs.writeFile(target, "{not json", { mode: 0o600 });
  await assert.rejects(
    () => store.read(target),
    (error) => error.malformed === true,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("real O_EXCL permits exactly one winner across child processes", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "race.lock");
  const record = sampleRecord({ session: "race" });

  const childScript = (token) => `
const { createFileLockStore } = await import(${JSON.stringify(LIB_URL)});
const store = createFileLockStore();
const r = await store.createExclusive(${JSON.stringify(target)}, ${JSON.stringify({ ...record, ownerToken: token })});
process.stdout.write(JSON.stringify(r));
`;

  const tokens = Array.from({ length: 6 }, (_, i) => `child-${i}`);
  const results = await Promise.all(
    tokens.map((token) => runChild(childScript(token)).then(({ out }) => JSON.parse(out))),
  );

  const winners = results.filter((r) => r.created);
  assert.equal(winners.length, 1, `expected one O_EXCL winner, got ${winners.length}`);

  const readBack = await createFileLockStore().read(target);
  assert.equal(readBack.session, "race");
  await fs.rm(dir, { recursive: true, force: true });
});

test("hard-link claim identifies one generation and never overwrites quarantine", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const quarantine = path.join(dir, "reviewer.lock.dead-1.quarantine");
  const store = createFileLockStore({ lockDir: dir });

  await store.createExclusive(canonical, sampleRecord());

  const claimed = await store.claimDeadGeneration(canonical, quarantine);
  assert.equal(claimed.claimed, true);
  assert.equal((await store.read(canonical)).ownerToken, "owner-1");
  const quarantined = await store.read(quarantine);
  assert.equal(quarantined.ownerToken, "owner-1");

  // Re-seed and pre-create the quarantine target: rename must refuse.
  const refused = await store.claimDeadGeneration(canonical, quarantine);
  assert.equal(refused.claimed, false);
  // Canonical untouched because rename refused to overwrite the quarantine.
  assert.equal((await store.read(canonical)).ownerToken, "owner-1");

  await fs.rm(dir, { recursive: true, force: true });
});

test("hard-link claim refuses a quarantine name that escapes the lock directory", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const escape = path.join(dir, "..", "escaped.quarantine");
  const store = createFileLockStore({ lockDir: dir });

  await store.createExclusive(canonical, sampleRecord());
  const refused = await store.claimDeadGeneration(canonical, escape);
  assert.equal(refused.claimed, false);
  // Canonical still present; nothing escaped the directory.
  assert.equal((await store.read(canonical)).ownerToken, "owner-1");
  await assert.rejects(() => fs.readFile(path.join(dir, "..", "escaped.quarantine")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("updateIfOwner is atomic and requires token plus command id", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });
  await store.createExclusive(canonical, sampleRecord());

  const wrongToken = await store.updateIfOwner(canonical, "wrong", "command-1", { phase: "injecting" });
  assert.equal(wrongToken.updated, false);
  const wrongCommand = await store.updateIfOwner(canonical, "owner-1", "wrong", { phase: "injecting" });
  assert.equal(wrongCommand.updated, false);

  const ok = await store.updateIfOwner(canonical, "owner-1", "command-1", { phase: "injecting" });
  assert.equal(ok.updated, true);
  assert.equal((await store.read(canonical)).phase, "injecting");
  // No temp siblings leak into the lock directory after the atomic rename.
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ["reviewer.lock"]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("unlinkIfOwner refuses missing, malformed, and mismatched records", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });

  // Missing.
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, false);

  // Owned, wrong credentials.
  await store.createExclusive(canonical, sampleRecord());
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "wrong")).unlinked, false);
  assert.equal((await store.unlinkIfOwner(canonical, "wrong", "command-1")).unlinked, false);

  // Owned, matching credentials.
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, true);
  assert.equal(await store.read(canonical), null);

  // Malformed canonical lock fails closed (no unlink, no throw).
  await fs.writeFile(canonical, "{garbage", { mode: 0o600 });
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, false);

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Task 3: acquire and dead-owner recovery against the real filesystem.
// ---------------------------------------------------------------------------

const NOW = () => new Date("2026-07-25T12:00:00.000Z");

test("acquire creates a fresh lock via O_EXCL", async () => {
  const dir = await mkLockDir();
  const store = createFileLockStore({ lockDir: dir });
  const result = await acquireSessionLock({
    session: "reviewer",
    commandId: "command-1",
    commandClass: "prompt",
    pid: 4321,
    lockDir: dir,
    store,
    isProcessAlive: async () => "live",
    randomUUID: () => "owner-1",
    now: NOW,
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reason, "created");
  assert.equal(result.recovered, false);
  assert.equal(result.priorPhase, null);
  assert.equal(result.ownerToken, "owner-1");
  assert.equal(result.commandId, "command-1");
  assert.equal(result.lockPath, path.join(dir, "reviewer.lock"));
  const record = await store.read(result.lockPath);
  assert.equal(record.phase, "pre-write");
  assert.equal(record.pid, 4321);
  assert.equal(record.session, "reviewer");
  await fs.rm(dir, { recursive: true, force: true });
});

test("acquire reports live-owner and does not recover", async () => {
  const dir = await mkLockDir();
  const store = createFileLockStore({ lockDir: dir });
  const first = await acquireSessionLock({
    session: "reviewer", commandId: "command-1", commandClass: "prompt",
    pid: 4321, lockDir: dir, store,
    isProcessAlive: async () => "live", randomUUID: () => "owner-1", now: NOW,
  });
  assert.equal(first.acquired, true);

  const second = await acquireSessionLock({
    session: "reviewer", commandId: "command-2", commandClass: "prompt",
    pid: 9999, lockDir: dir, store,
    isProcessAlive: async (pid) => (pid === 4321 ? "live" : "dead"),
    randomUUID: () => "owner-2", now: NOW,
  });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "live-owner");
  assert.equal(second.heldBy.pid, 4321);
  assert.equal(second.heldBy.commandId, "command-1");
  assert.equal((await store.read(first.lockPath)).ownerToken, "owner-1");
  await fs.rm(dir, { recursive: true, force: true });
});

test("acquire treats unknown liveness as non-reclaimable", async () => {
  const dir = await mkLockDir();
  const store = createFileLockStore({ lockDir: dir });
  await acquireSessionLock({
    session: "reviewer", commandId: "command-1", commandClass: "prompt",
    pid: 4321, lockDir: dir, store,
    isProcessAlive: async () => "live", randomUUID: () => "owner-1", now: NOW,
  });
  // EPERM-style uncertainty maps to "unknown" and must fail closed.
  const result = await acquireSessionLock({
    session: "reviewer", commandId: "command-2", commandClass: "prompt",
    pid: 9999, lockDir: dir, store,
    isProcessAlive: async () => "unknown", randomUUID: () => "owner-2", now: NOW,
  });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, "unknown-owner");
  assert.equal(result.heldBy.pid, 4321);
  await fs.rm(dir, { recursive: true, force: true });
});

test("acquire recovers a definitely dead owner via quarantine + fresh O_EXCL", async () => {
  const dir = await mkLockDir();
  const store = createFileLockStore({ lockDir: dir });
  const canonical = path.join(dir, "reviewer.lock");
  // Seed a dead-owner generation directly.
  await store.createExclusive(canonical, sampleRecord({
    session: "reviewer", ownerToken: "dead", pid: 4321,
    commandId: "dead-cmd", phase: "pre-write",
  }));

  const result = await acquireSessionLock({
    session: "reviewer", commandId: "command-2", commandClass: "prompt",
    pid: 9999, lockDir: dir, store,
    isProcessAlive: async () => "dead",
    randomUUID: () => "new-owner", now: NOW,
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reason, "recovered-dead-owner");
  assert.equal(result.recovered, true);
  assert.equal(result.priorPhase, "pre-write");
  assert.equal(result.ownerToken, "new-owner");
  assert.equal(result.commandId, "command-2");
  // Canonical now owned by the recoverer; dead generation quarantined.
  assert.equal((await store.read(canonical)).ownerToken, "new-owner");
  assert.ok(result.quarantinePath, "quarantine path returned");
  assert.notEqual(result.quarantinePath, canonical);
  const quarantined = await store.read(result.quarantinePath);
  assert.equal(quarantined.ownerToken, "dead");
  await fs.rm(dir, { recursive: true, force: true });
});

test("concurrent dead-owner recovery yields exactly one new owner", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "race.lock");
  const goFile = path.join(dir, "GO");
  const store = createFileLockStore({ lockDir: dir });
  // The dead owner's pid is a sentinel no live child will hold. Each contender
  // runs with its own real process.pid, so isProcessAlive (below) reports the
  // dead owner as dead and every fellow contender as live — exactly what
  // production process.kill(pid,0) would observe. This isolates the rename +
  // O_EXCL race instead of cascading recovery onto live contenders.
  const deadPid = 2147483647;
  await store.createExclusive(canonical, sampleRecord({
    session: "race", ownerToken: "dead", pid: deadPid,
    commandId: "dead-cmd", phase: "pre-write",
  }));

  const N = 8;
  const childScript = (i) => `
const { acquireSessionLock, createFileLockStore } = await import(${JSON.stringify(LIB_URL)});
const fs = await import("node:fs/promises");
const { setTimeout: sleep } = await import("node:timers/promises");
const dir = ${JSON.stringify(dir)};
const goFile = ${JSON.stringify(goFile)};
const readyFile = ${JSON.stringify(path.join(dir, `ready-${i}`))};
const deadPid = ${deadPid};
await fs.writeFile(readyFile, "", { mode: 0o600 });
for (;;) { try { await fs.access(goFile); break; } catch { await sleep(5); } }
const store = createFileLockStore();
const result = await acquireSessionLock({
  session: "race",
  commandId: ${JSON.stringify(`cmd-${i}`)},
  commandClass: "prompt",
  pid: process.pid,
  lockDir: dir,
  store,
  isProcessAlive: async (pid) => (pid === deadPid ? "dead" : "live"),
  randomUUID: () => ${JSON.stringify(`owner-${i}`)},
  now: () => new Date("2026-07-25T12:00:00.000Z"),
});
process.stdout.write(JSON.stringify(result));
`;

  const pending = Array.from({ length: N }, (_, i) => runChild(childScript(i)));
  // Wait until every child is parked on the barrier, then release them together.
  await Promise.all(Array.from({ length: N }, async (_, i) => {
    const readyFile = path.join(dir, `ready-${i}`);
    for (;;) {
      try { await fs.access(readyFile); break; } catch { await sleep(10); }
    }
  }));
  await fs.writeFile(goFile, "", { mode: 0o600 });

  const results = await Promise.all(
    pending.map((p) => p.then(({ out }) => JSON.parse(out))),
  );

  const winners = results.filter((r) => r.acquired);
  // Core invariant: exactly one contender ends up owning the canonical lock.
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
  const winner = winners[0];

  // Two valid fresh-ownership outcomes — both arise SOLELY from winning a fresh
  // O_EXCL on the canonical path, never from the rename-only claim:
  //   - "recovered-dead-owner": this contender claimed the dead generation,
  //     unlinked it, and won the fresh O_EXCL itself.
  //   - "created": a DIFFERENT contender claimed + unlinked the dead generation,
  //     and this contender raced its INITIAL O_EXCL through the gap before the
  //     claim winner's fresh O_EXCL, becoming the sole fresh owner. That is
  //     allowed by design — the rename-only claim never confers ownership.
  if (winner.reason === "recovered-dead-owner") {
    assert.equal(winner.recovered, true);
    assert.equal(winner.priorPhase, "pre-write");
    assert.ok(winner.quarantinePath, "recovered winner reports the tombstone it set");
    assert.notEqual(winner.quarantinePath, canonical);
  } else if (winner.reason === "created") {
    assert.equal(winner.recovered, false);
    assert.equal(winner.priorPhase, null);
    assert.equal(winner.quarantinePath, null);
  } else {
    assert.fail(`unexpected winner reason: ${winner.reason}`);
  }

  // Canonical metadata always equals the O_EXCL winner — never a rename-only
  // contender.
  const canonicalRecord = await store.read(canonical);
  assert.equal(canonicalRecord.ownerToken, winner.ownerToken);
  assert.equal(canonicalRecord.commandId, winner.commandId);

  // No non-winner reports ownership. (winners.length === 1 already guarantees
  // this; spell it out for clarity.)
  for (const r of results) {
    if (r !== winner) assert.equal(r.acquired, false);
  }

  // A contender that entered recovery (set a quarantinePath) but did NOT win the
  // fresh O_EXCL reports contended, never acquired. In the "created" race this
  // includes the claim winner itself, whose fresh O_EXCL lost to the racer.
  for (const r of results) {
    if (r.quarantinePath && !r.acquired) {
      assert.equal(r.reason, "contended");
    }
  }

  // Deterministic quarantine evidence: exactly one contender hard-linked the
  // dead generation into the tombstone derived from the dead owner's token, and
  // it holds the dead generation regardless of who won the fresh O_EXCL.
  const tombstone = await store.read(path.join(dir, "race.lock.dead.quarantine"));
  assert.equal(tombstone.ownerToken, "dead");
  assert.equal(tombstone.commandId, "dead-cmd");
  assert.equal(tombstone.phase, "pre-write");

  await fs.rm(dir, { recursive: true, force: true });
});

test("acquire lazily creates a missing lock directory", async () => {
  const root = await mkLockDir();
  const freshDir = path.join(root, "nested", "locks");
  const store = createFileLockStore();
  const result = await acquireSessionLock({
    session: "reviewer", commandId: "command-1", commandClass: "prompt",
    pid: 4321, lockDir: freshDir, store,
    isProcessAlive: async () => "live", randomUUID: () => "owner-1", now: NOW,
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reason, "created");
  assert.equal((await store.read(path.join(freshDir, "reviewer.lock"))).ownerToken, "owner-1");
  await fs.rm(root, { recursive: true, force: true });
});
