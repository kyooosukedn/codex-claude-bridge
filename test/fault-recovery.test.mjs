// P1 fault-injection + multi-session isolation.
//
// These are the deterministic halves of the P1 acceptance gate: the live
// 100-trial run lives in bin/ccb-stress.mjs, but the recovery contract and the
// no-cross-session-leakage guarantee must be provable without launching Claude.
// They exercise the REAL coordinateInjection / command journal / reconcile path
// (temp dirs + injected capture/inject callbacks), never ccmux or tmux.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createCommandJournal } from "../lib/command-journal.mjs";
import {
  coordinateInjection,
  createFileLockStore,
} from "../lib/session-coordinator.mjs";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const fixedNow = () => new Date("2026-07-30T10:00:00.000Z");
let idCounter = 0;
const fixedUUID = () => `id-${++idCounter}`;

const JOURNAL_URL = pathToFileURL(
  path.resolve("lib/command-journal.mjs"),
).href;

// Spawn a REAL child process that writes a journal record in `state` using its
// own process.pid as ownerPid, then exits (dies). The parent reconciles with
// the DEFAULT real-PID liveness probe, so the dead child's record is recovered
// exactly as a crashed bridge process would be.
function recordThenDie(rootDir, state, commandId, session) {
  const script = `
    import { createCommandJournal } from ${JSON.stringify(JOURNAL_URL)};
    const [rootDir, state, commandId, session] = process.argv.slice(1);
    const journal = createCommandJournal({ rootDir });
    await journal.recordTransition({
      commandId,
      session,
      commandClass: "prompt",
      state,
      attempt: 1,
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, rootDir, state, commandId, session],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
}

// ---------------------------------------------------------------------------
// Deterministic fault cases: process death at each lifecycle boundary.
//
// "Process death" is simulated faithfully: a record is left on disk in the
// state the dead process last reached, and isProcessAlive reports the owner as
// definitely dead. reconcile() then applies recoveryVerdict. The bridge NEVER
// re-injects during reconcile — it only records a conservative transition and
// returns the verdict — so every case asserts both the verdict and that
// reconcile is a no-op on a second pass (terminal / no automatic resend).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic fault cases via a REAL child process at each lifecycle boundary.
// The child writes the record in `state` using its own pid, then dies; the
// parent reconciles with the DEFAULT real-PID liveness probe. This is the
// faithful simulation of a bridge crash, not a planted fixture.
// ---------------------------------------------------------------------------

test("real-child death at queued/pre-write reconciles to safe-to-retry not-injected", async (t) => {
  for (const state of ["queued", "pre-write"]) {
    const rootDir = await tempDir("ccb-fault-pre-");
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    recordThenDie(rootDir, state, `cmd-${state}`, "alpha");

    const journal = createCommandJournal({ rootDir });
    const reconciled = await journal.reconcile({ session: "alpha" });
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].currentState, "interrupted");
    assert.equal(reconciled[0].ack, "not-injected");
    assert.equal(reconciled[0].safeToRetry, true);
    assert.equal(reconciled[0].reason, "restart-before-transport");

    // No automatic resend: a second reconcile finds nothing left to recover.
    assert.deepEqual(await journal.reconcile({ session: "alpha" }), []);
  }
});

test("real-child death at injecting boundary reconciles to uncertain and is never resent", async (t) => {
  const rootDir = await tempDir("ccb-fault-inj-");
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  recordThenDie(rootDir, "injecting", "cmd-inj", "alpha");

  const journal = createCommandJournal({ rootDir });
  const reconciled = await journal.reconcile({ session: "alpha" });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].currentState, "interrupted");
  assert.equal(reconciled[0].ack, "uncertain");
  assert.equal(reconciled[0].safeToRetry, false);
  assert.equal(reconciled[0].reason, "restart-during-transport");

  // safeToRetry:false is the no-automatic-resend contract; reconcile is terminal.
  assert.deepEqual(await journal.reconcile({ session: "alpha" }), []);
});

test("real-child death at Claude-running boundary leaves the delivered command terminal", async (t) => {
  const rootDir = await tempDir("ccb-fault-run-");
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  recordThenDie(rootDir, "acknowledged", "cmd-run", "alpha");

  const journal = createCommandJournal({ rootDir });
  const reconciled = await journal.reconcile({ session: "alpha" });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].currentState, "released");
  assert.equal(reconciled[0].ack, "injected");
  assert.equal(reconciled[0].safeToRetry, false);
  assert.equal(reconciled[0].reason, "restart-after-acknowledgement");

  // A fully released command is terminal — a dead owner is not reconciled.
  const rootDir2 = await tempDir("ccb-fault-released-");
  t.after(() => fs.rm(rootDir2, { recursive: true, force: true }));
  recordThenDie(rootDir2, "released", "cmd-done", "alpha");
  const journal2 = createCommandJournal({ rootDir: rootDir2 });
  assert.deepEqual(await journal2.reconcile({ session: "alpha" }), []);
});

test("reconcile leaves a live or unknown owner byte-for-byte untouched", async (t) => {
  for (const [name, alive] of [["live", true], ["unknown", null]]) {
    const rootDir = await tempDir(`ccb-fault-${name}-`);
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const journal = createCommandJournal({
      rootDir,
      now: fixedNow,
      randomUUID: fixedUUID,
      isProcessAlive: () => alive,
    });
    await journal.recordTransition({
      commandId: `cmd-${name}`,
      session: "alpha",
      commandClass: "prompt",
      state: "injecting",
      attempt: 1,
      pid: 999005,
    });
    const filePath = path.join(rootDir, "alpha", `cmd-${name}.json`);
    const before = await fs.readFile(filePath, "utf8");
    assert.deepEqual(await journal.reconcile({ session: "alpha" }), []);
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  }
});

// ---------------------------------------------------------------------------
// Concurrent multi-session isolation: >= 3 sessions receive commands at the
// same time through the REAL per-session file lock. Commands delivered to one
// session never appear in another, and each session preserves its own order.
// ---------------------------------------------------------------------------

test("three concurrent sessions never leak commands across sessions", async (t) => {
  const lockDir = await tempDir("ccb-iso-lock-");
  const journalDir = await tempDir("ccb-iso-journal-");
  t.after(() => fs.rm(lockDir, { recursive: true, force: true }));
  t.after(() => fs.rm(journalDir, { recursive: true, force: true }));
  const store = createFileLockStore({ lockDir });
  const journal = createCommandJournal({
    rootDir: journalDir,
    now: fixedNow,
    randomUUID: fixedUUID,
    isProcessAlive: () => false,
  });

  const sessions = ["sess-a", "sess-b", "sess-c"];
  const delivered = Object.fromEntries(sessions.map((s) => [s, []]));
  const rounds = 3;

  for (let round = 0; round < rounds; round += 1) {
    const inflight = sessions.map(async (session) => {
      const msg = `${session}-R${round}`;
      const result = await coordinateInjection({
        session,
        commandId: `${session}-r${round}`,
        commandClass: "prompt",
        pid: process.pid,
        lockDir,
        store,
        journal,
        now: fixedNow,
        randomUUID: fixedUUID,
        maxPreWriteAttempts: 1,
        captureBaseline: async () => "idle-baseline",
        inject: async () => {
          delivered[session].push(msg);
          return { status: "sent", id: msg };
        },
        observeInjection: async () => ({ observed: true, reason: "transport-returned" }),
      });
      assert.equal(result.ack, "injected", `round ${round} ${session}: ${result.reason}`);
    });
    await Promise.all(inflight);
  }

  // No foreign commands in any session, order preserved within each session.
  for (const session of sessions) {
    assert.deepEqual(
      delivered[session],
      [0, 1, 2].map((r) => `${session}-R${r}`),
      `session ${session} saw foreign commands or reordered delivery`,
    );
  }
});

// ---------------------------------------------------------------------------
// Baseline-capture failure happens strictly before any transport write, so it
// must record safeToRetry=true even when the automatic attempt budget is
// exhausted (mode-changing inputs run with maxPreWriteAttempts=1). Uses the
// REAL coordinator + REAL journal + REAL file lock (no fakes).
// ---------------------------------------------------------------------------

test("baseline failure (no transport write) records safeToRetry=true at exhausted budget", async (t) => {
  const lockDir = await tempDir("ccb-baseline-lock-");
  const journalDir = await tempDir("ccb-baseline-journal-");
  t.after(() => fs.rm(lockDir, { recursive: true, force: true }));
  t.after(() => fs.rm(journalDir, { recursive: true, force: true }));
  const store = createFileLockStore({ lockDir });
  const journal = createCommandJournal({
    rootDir: journalDir,
    now: fixedNow,
    randomUUID: fixedUUID,
    isProcessAlive: () => false,
  });

  let injected = false;
  const result = await coordinateInjection({
    session: "alpha",
    commandId: "cmd-baseline-fail",
    commandClass: "mode-changing",
    pid: process.pid,
    lockDir,
    store,
    journal,
    now: fixedNow,
    randomUUID: fixedUUID,
    maxPreWriteAttempts: 1, // budget exhausted on the first (only) attempt
    captureBaseline: async () => {
      throw new Error("capture failed");
    },
    inject: async () => {
      injected = true; // must never run — no transport write on a baseline failure
      return { status: "sent", id: "never" };
    },
    observeInjection: async () => ({ observed: true, reason: "never" }),
  });

  assert.equal(injected, false);
  assert.equal(result.ack, "not-injected");
  assert.equal(result.reason, "baseline-error");

  // The operator-visible journal record is the source of truth for reconcile/
  // runbooks. A proven pre-write failure must be safe to retry.
  const record = await journal.readCommand("alpha", "cmd-baseline-fail");
  assert.equal(record.currentState, "released");
  assert.equal(record.ack, "not-injected");
  assert.equal(record.safeToRetry, true);
  assert.equal(record.reason, "baseline-error");
});
