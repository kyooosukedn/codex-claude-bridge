// RED contract for P1 per-session serialization.
//
// lib/session-coordinator.mjs intentionally does not exist in this design slice.
// This file must fail only with ERR_MODULE_NOT_FOUND until implementation starts.

import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireSessionLock,
  coordinateInjection,
  releaseSessionLock,
  validateSessionName,
} from "../lib/session-coordinator.mjs";

class FakeStore {
  constructor() {
    this.files = new Map();
  }

  async createExclusive(filePath, record) {
    if (this.files.has(filePath)) return { created: false };
    this.files.set(filePath, structuredClone(record));
    return { created: true };
  }

  async read(filePath) {
    const record = this.files.get(filePath);
    return record ? structuredClone(record) : null;
  }

  async claimDeadGeneration(filePath, quarantinePath) {
    if (!this.files.has(filePath) || this.files.has(quarantinePath)) {
      return { claimed: false };
    }
    const record = this.files.get(filePath);
    this.files.set(quarantinePath, structuredClone(record));
    return { claimed: true };
  }

  async updateIfOwner(filePath, ownerToken, commandId, patch) {
    const record = this.files.get(filePath);
    if (
      !record ||
      record.ownerToken !== ownerToken ||
      record.commandId !== commandId
    ) {
      return { updated: false };
    }
    this.files.set(filePath, { ...record, ...structuredClone(patch) });
    return { updated: true };
  }

  async unlinkIfOwner(filePath, ownerToken, commandId) {
    const record = this.files.get(filePath);
    if (
      !record ||
      record.ownerToken !== ownerToken ||
      record.commandId !== commandId
    ) {
      return { unlinked: false };
    }
    this.files.delete(filePath);
    return { unlinked: true };
  }
}

function uuidSequence(prefix = "token") {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function lockArgs(overrides = {}) {
  return {
    session: "alpha",
    commandId: "command-1",
    commandClass: "prompt",
    pid: 101,
    now: () => new Date("2026-07-25T12:00:00.000Z"),
    randomUUID: uuidSequence(),
    isProcessAlive: async () => true,
    store: new FakeStore(),
    lockDir: "/ccb/locks",
    ...overrides,
  };
}

test("session names are safe path components", () => {
  assert.equal(validateSessionName("alpha.1-test"), "alpha.1-test");
  assert.throws(() => validateSessionName("../alpha"));
  assert.throws(() => validateSessionName("alpha/beta"));
  assert.throws(() => validateSessionName("alpha\\beta"));
});

test("same session permits exactly one live owner", async () => {
  const store = new FakeStore();
  const first = await acquireSessionLock(
    lockArgs({ store, randomUUID: () => "owner-a" }),
  );
  const second = await acquireSessionLock(
    lockArgs({
      store,
      commandId: "command-2",
      pid: 202,
      randomUUID: () => "owner-b",
      isProcessAlive: async (pid) => pid === 101,
    }),
  );

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "live-owner");
  assert.equal((await store.read(first.lockPath)).ownerToken, "owner-a");
});

test("different sessions acquire independently", async () => {
  const store = new FakeStore();
  const [alpha, beta] = await Promise.all([
    acquireSessionLock(
      lockArgs({ store, session: "alpha", randomUUID: () => "owner-a" }),
    ),
    acquireSessionLock(
      lockArgs({
        store,
        session: "beta",
        commandId: "command-2",
        pid: 202,
        randomUUID: () => "owner-b",
      }),
    ),
  ]);

  assert.equal(alpha.acquired, true);
  assert.equal(beta.acquired, true);
  assert.notEqual(alpha.lockPath, beta.lockPath);
});

test("an old timestamp never displaces a live PID", async () => {
  const store = new FakeStore();
  const first = await acquireSessionLock(
    lockArgs({
      store,
      now: () => new Date("2000-01-01T00:00:00.000Z"),
      randomUUID: () => "owner-a",
    }),
  );
  const second = await acquireSessionLock(
    lockArgs({
      store,
      commandId: "command-2",
      pid: 202,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
      randomUUID: () => "owner-b",
      isProcessAlive: async (pid) => pid === 101,
    }),
  );

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "live-owner");
  assert.equal((await store.read(first.lockPath)).ownerToken, "owner-a");
});

test("concurrent dead-owner recovery creates exactly one new owner", async () => {
  const store = new FakeStore();
  const dead = await acquireSessionLock(
    lockArgs({ store, randomUUID: () => "dead-owner" }),
  );
  assert.equal(dead.acquired, true);

  const contenders = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      acquireSessionLock(
        lockArgs({
          store,
          commandId: `recovery-${index}`,
          pid: 200 + index,
          randomUUID: () => `new-owner-${index}`,
          isProcessAlive: async () => false,
        }),
      ),
    ),
  );

  const winners = contenders.filter((result) => result.acquired);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].recovered, true);
  assert.equal(winners[0].priorPhase, "pre-write");
  const canonical = await store.read(winners[0].lockPath);
  assert.equal(canonical.ownerToken, winners[0].ownerToken);
});

test("a delayed old token cannot release a recovered owner", async () => {
  const store = new FakeStore();
  const oldOwner = await acquireSessionLock(
    lockArgs({ store, randomUUID: () => "old-owner" }),
  );
  const newOwner = await acquireSessionLock(
    lockArgs({
      store,
      commandId: "command-2",
      pid: 202,
      randomUUID: () => "new-owner",
      isProcessAlive: async () => false,
    }),
  );
  assert.equal(newOwner.acquired, true);

  const delayed = await releaseSessionLock({
    lockPath: oldOwner.lockPath,
    ownerToken: oldOwner.ownerToken,
    commandId: oldOwner.commandId,
    store,
  });
  assert.equal(delayed.released, false);
  assert.equal((await store.read(newOwner.lockPath)).ownerToken, "new-owner");

  const current = await releaseSessionLock({
    lockPath: newOwner.lockPath,
    ownerToken: newOwner.ownerToken,
    commandId: newOwner.commandId,
    store,
  });
  assert.equal(current.released, true);
  assert.equal(await store.read(newOwner.lockPath), null);
});

test("post-spawn uncertainty is never retried", async () => {
  const store = new FakeStore();
  let baselineCalls = 0;
  let injectionCalls = 0;

  const result = await coordinateInjection({
    ...lockArgs({ store }),
    maxPreWriteAttempts: 3,
    captureBaseline: async () => {
      baselineCalls += 1;
      return { signature: "idle" };
    },
    inject: async () => {
      injectionCalls += 1;
      const error = new Error("ccmux exited after transport started");
      error.transportStarted = true;
      throw error;
    },
    observeInjection: async () => {
      throw new Error("must not observe after inject throws");
    },
  });

  assert.equal(result.ack, "uncertain");
  assert.equal(result.attempts, 1);
  assert.equal(baselineCalls, 1);
  assert.equal(injectionCalls, 1);
});

test("only a proven pre-write failure may retry", async () => {
  const store = new FakeStore();
  let baselineCalls = 0;
  let injectionCalls = 0;

  const result = await coordinateInjection({
    ...lockArgs({ store }),
    maxPreWriteAttempts: 3,
    captureBaseline: async () => {
      baselineCalls += 1;
      if (baselineCalls === 1) {
        const error = new Error("capture failed before spawn");
        error.transportStarted = false;
        throw error;
      }
      return { signature: "idle" };
    },
    inject: async () => {
      injectionCalls += 1;
      return {
        id: "job-1",
        session: "alpha",
        status: "sent",
        sentAt: "2026-07-25T12:00:01.000Z",
      };
    },
    observeInjection: async () => ({ observed: true, reason: "pane-changed" }),
  });

  assert.equal(result.ack, "injected");
  assert.equal(result.attempts, 2);
  assert.equal(baselineCalls, 2);
  assert.equal(injectionCalls, 1);
  assert.equal(result.payload.id, "job-1");
});

test("send lock ends before terminal wait so steer can acquire", async () => {
  const store = new FakeStore();
  let terminal = false;

  const send = await coordinateInjection({
    ...lockArgs({ store }),
    captureBaseline: async () => ({ signature: "idle" }),
    inject: async () => ({
      id: "job-1",
      session: "alpha",
      status: "sent",
      sentAt: "2026-07-25T12:00:01.000Z",
    }),
    observeInjection: async () => ({ observed: true, reason: "thinking" }),
  });
  assert.equal(send.ack, "injected");
  assert.equal(terminal, false);

  const steer = await coordinateInjection({
    ...lockArgs({
      store,
      commandId: "steer-1",
      commandClass: "steer",
      pid: 202,
      randomUUID: () => "steer-owner",
    }),
    captureBaseline: async () => ({ signature: "thinking" }),
    inject: async () => ({ status: "sent" }),
    observeInjection: async () => ({ observed: true, reason: "pane-changed" }),
  });
  assert.equal(steer.ack, "injected");
  assert.equal(terminal, false);

  terminal = true;
  assert.equal(terminal, true);
});
