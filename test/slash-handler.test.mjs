// Handler-level regression coverage for `ccb slash` (P1 slice 1, review rework).
//
// These tests drive the REAL slash orchestration (executeSlash, the function
// main() calls) with injected subprocess fakes that record every call. They
// prove handler behavior — not just pure helpers:
//   - wiring / call ordering (captureBaseline -> enterText -> modeReadyBarrier)
//   - fail-closed baseline: capture failure aborts BEFORE delivery (no enterText)
//   - waited ready:false exits NONZERO; ready:true / --no-wait exit 0
//   - --no-wait skips baseline capture AND the barrier
//   - injectedAt is recorded only after successful injection
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeSlash } from "../bin/codex-claude-bridge.mjs";

// Exit-code contract documented in docs/RELIABILITY.md.
const SLASH_NOT_READY_EXIT = 6;
const SLASH_BASELINE_FAILED_EXIT = 7;

// Fake subprocess layer: records call order + counts, returns scripted results,
// and advances a fake clock so timestamp ordering is observable.
function makeFakes({ baseline, barrier, enterThrows } = {}) {
  const log = [];
  let now = 1_700_000_000_000;
  let enterTextCalledAt = null;
  const deps = {
    now: () => now,
    captureBaseline: async (session) => {
      log.push(`captureBaseline:${session}`);
      if (baseline === "__throw__") throw new Error("ccmux capture exploded");
      return baseline ?? "BASELINE-PANE";
    },
    enterText: (session, text, enter) => {
      log.push(`enterText:${session}`);
      enterTextCalledAt = now;
      now += 50; // simulate injection taking time
      if (enterThrows) throw enterThrows;
      return {
        session,
        tmuxSession: `ccmux-${session}`,
        entered: enter,
        bytes: Buffer.byteLength(text),
      };
    },
    modeReadyBarrier: async (session, b, timeoutMs, intervalMs) => {
      log.push(`modeReadyBarrier:${session}`);
      now += 2000; // simulate polling
      return barrier;
    },
  };
  return { deps, log, enterTextCalledAt: () => enterTextCalledAt };
}

test("slash ready path: exit 0, correct ordering, telemetry", async () => {
  const f = makeFakes({
    baseline: "BASELINE-PANE",
    barrier: {
      ready: true,
      state: "idle",
      reason: "fresh-ready",
      waitedMs: 2000,
      attempts: 3,
      evidence: { footer: true },
    },
  });
  const { body, exitCode } = await executeSlash({
    session: "s1",
    text: "/effort low",
    opts: {},
    deps: f.deps,
  });
  assert.equal(exitCode, 0, "ready -> exit 0");
  assert.deepEqual(f.log, [
    "captureBaseline:s1",
    "enterText:s1",
    "modeReadyBarrier:s1",
  ]);
  assert.equal(body.command, "/effort low");
  assert.equal(body.session, "s1");
  assert.equal(body.tmuxSession, "ccmux-s1");
  assert.equal(body.entered, true);
  assert.ok(body.commandId, "commandId present");
  assert.ok(body.injectedAt, "injectedAt present");
  assert.equal(body.readiness.ready, true);
  assert.equal(body.readiness.state, "idle");
  assert.equal(body.readiness.attempts, 3);
});

test("slash baseline capture fails: fail-closed, NO delivery, exit 7", async () => {
  const f = makeFakes({
    baseline: "__throw__",
    barrier: { ready: true, state: "idle", reason: "fresh-ready", waitedMs: 0, attempts: 0, evidence: {} },
  });
  const { body, exitCode } = await executeSlash({
    session: "s1",
    text: "/x",
    opts: {},
    deps: f.deps,
  });
  assert.equal(exitCode, SLASH_BASELINE_FAILED_EXIT);
  assert.deepEqual(
    f.log,
    ["captureBaseline:s1"],
    "must NOT call enterText or barrier after baseline failure",
  );
  assert.equal(body.readiness.ready, false);
  assert.equal(body.readiness.reason, "baseline-capture-failed");
  assert.equal(
    body.injectedAt,
    undefined,
    "no injectedAt — nothing was injected",
  );
});

test("slash waited ready:false: delivery happened but exit NONZERO (6)", async () => {
  const f = makeFakes({
    baseline: "BASELINE-PANE",
    barrier: {
      ready: false,
      state: "idle",
      reason: "timeout-stale",
      waitedMs: 30000,
      attempts: 31,
      evidence: {},
    },
  });
  const { body, exitCode } = await executeSlash({
    session: "s1",
    text: "/x",
    opts: {},
    deps: f.deps,
  });
  assert.notEqual(exitCode, 0, "waited ready:false must NOT exit 0");
  assert.equal(exitCode, SLASH_NOT_READY_EXIT);
  assert.deepEqual(f.log, [
    "captureBaseline:s1",
    "enterText:s1",
    "modeReadyBarrier:s1",
  ]);
  assert.ok(body.injectedAt, "telemetry still emitted on non-ready");
  assert.equal(body.readiness.ready, false);
  assert.equal(body.readiness.reason, "timeout-stale");
  assert.equal(body.readiness.attempts, 31);
});

test("slash --no-wait: exit 0, skips baseline AND barrier, still delivers", async () => {
  const f = makeFakes({
    baseline: "BASELINE-PANE",
    barrier: { ready: false, state: "idle", reason: "timeout-stale", waitedMs: 0, attempts: 0, evidence: {} },
  });
  const { body, exitCode } = await executeSlash({
    session: "s1",
    text: "/x",
    opts: { "no-wait": true },
    deps: f.deps,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(f.log, ["enterText:s1"], "no baseline capture, no barrier");
  assert.deepEqual(body.readiness, {
    waited: false,
    ready: null,
    reason: "skipped",
  });
  assert.ok(body.injectedAt, "delivered, so injectedAt present");
});

test("injectedAt is recorded AFTER successful injection (truthful)", async () => {
  const f = makeFakes({
    baseline: "BASELINE-PANE",
    barrier: {
      ready: true,
      state: "idle",
      reason: "fresh-ready",
      waitedMs: 0,
      attempts: 1,
      evidence: {},
    },
  });
  const { body } = await executeSlash({
    session: "s1",
    text: "/x",
    opts: {},
    deps: f.deps,
  });
  const injectedAtMs = Date.parse(body.injectedAt);
  assert.ok(
    injectedAtMs >= f.enterTextCalledAt(),
    "injectedAt must be at/after the moment enterText was invoked",
  );
});

test("injectedAt never set when injection itself fails", async () => {
  const f = makeFakes({
    baseline: "BASELINE-PANE",
    barrier: { ready: true, state: "idle", reason: "fresh-ready", waitedMs: 0, attempts: 1, evidence: {} },
    enterThrows: new Error("tmux broken"),
  });
  await assert.rejects(
    () => executeSlash({ session: "s1", text: "/x", opts: {}, deps: f.deps }),
    /tmux broken/,
  );
});
