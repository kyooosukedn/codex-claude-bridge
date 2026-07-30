// Pre-injection idle baseline gate for mode-changing slash commands.
//
// Live finding (3-session isolation, trial C): a slash was injected while the
// pane was still thinking (stop hooks running after the previous send's ccmux
// terminal "done"). The command mutated the session after the caller had
// already received a failure. The production slash path must now acquire the
// lock, then confirm an INJECTABLE baseline (idle/done) under that lock BEFORE
// any transport write. Thinking / needs_input / permission / unknown panes,
// and the "Press up to edit queued messages" pane, never receive the slash.

import assert from "node:assert/strict";
import test from "node:test";

import { awaitIdleBaseline, isBaselineInjectable } from "../lib/readiness.mjs";
import { executeCoordinatedSlash } from "../bin/codex-claude-bridge.mjs";
import {
  computeRunVerdict,
  formatFailureReport,
} from "../lib/stress-harness.mjs";
import {
  IDLE_PANE,
  NEEDS_INPUT_PANE,
  THINKING_PANE,
} from "./fixtures.mjs";

// Realistic queued-message pane (from the live artifact): the bottom active
// line is the queued-message hint, not an empty `>` prompt. The canonical
// classifier must NOT read this as idle.
const QUEUED_PANE = [
  "● Acknowledge with a single OK.",
  "",
  "  OK",
  "",
  "  Press ↑ to edit queued messages (1 queued)",
  "",
  "─────────────────────────────────────────────────────────────────── ccb-c ──",
  "────────────────────────────────────────────────────────────────────────────────",
  "  glm-5.2 │ project ████████░░ 80%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
].join("\n");

// Done marker resting on a clearly idle frame: marker within the last 8 lines
// AND an empty `>` prompt + footer AND no active spinner. This must stay
// injectable (a stale marker must not block an idle pane).
const DONE_IDLE_PANE = [
  "● bridge works",
  "  CCMUX_DONE:61f5ba28-55da-4200-bf1a-6ef36d0bfe74",
  "✻ Baked for 1s",
  "─────────────────────────────────────────────────────────────────── x ──",
  ">",
  "────────────────────────────────────────────────────────────────────────────────",
  "  glm-5.2 │ work ░░░░░░░░░░ 6%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// Done marker WHILE the pane is busy: an active spinner is still in view. The
// bare done marker must NOT make this injectable (marker-complete != idle).
const DONE_SPINNER_PANE = [
  "● Bash(npm test)",
  "  ⎿ Running…",
  "✢ Running tests… (2m 10s · ↓ 4.2k tokens)",
  "  CCMUX_DONE:61f5ba28-55da-4200-bf1a-6ef36d0bfe74",
  "─────────────────────────────────────────────────────────────────── x ──",
  ">",
  "────────────────────────────────────────────────────────────────────────────────",
  "  glm-5.2 │ project ██░░░░░░░░ 22%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// Done marker over a queued-message pane (no empty prompt). Non-injectable.
const DONE_QUEUED_PANE = [
  "● OK",
  "  CCMUX_DONE:61f5ba28-55da-4200-bf1a-6ef36d0bfe74",
  "  Press ↑ to edit queued messages (1 queued)",
  "─────────────────────────────────────────────────────────────────── x ──",
  "────────────────────────────────────────────────────────────────────────────────",
  "  glm-5.2 │ project ██░░░░░░░░ 22%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// ---------------------------------------------------------------------------
// Unit: awaitIdleBaseline / isBaselineInjectable (canonical classifier).
// ---------------------------------------------------------------------------

test("isBaselineInjectable: idle is injectable; thinking/needs_input/queued are not", () => {
  assert.equal(isBaselineInjectable(IDLE_PANE).injectable, true);
  assert.equal(isBaselineInjectable(THINKING_PANE).injectable, false);
  assert.equal(isBaselineInjectable(NEEDS_INPUT_PANE).injectable, false);
  assert.equal(isBaselineInjectable(QUEUED_PANE).injectable, false);
});

test("isBaselineInjectable: done + idle evidence (empty prompt + footer, no spinner) is injectable", () => {
  const r = isBaselineInjectable(DONE_IDLE_PANE);
  assert.equal(r.state, "done");
  assert.equal(r.injectable, true);
  assert.equal(r.evidence.footer, true);
  assert.equal(r.evidence.emptyPrompt, true);
  assert.equal(r.evidence.spinnerActive, false);
});

test("isBaselineInjectable: done + active spinner is NOT injectable (bare done rejected)", () => {
  const r = isBaselineInjectable(DONE_SPINNER_PANE);
  assert.equal(r.state, "done");
  assert.equal(r.injectable, false);
  assert.equal(r.evidence.spinnerActive, true);
});

test("isBaselineInjectable: done + queued-message (no empty prompt) is NOT injectable", () => {
  const r = isBaselineInjectable(DONE_QUEUED_PANE);
  assert.equal(r.state, "done");
  assert.equal(r.injectable, false);
  assert.equal(r.evidence.emptyPrompt, false);
});

test("awaitIdleBaseline: thinking then idle resolves to idle", async () => {
  let i = 0;
  const panes = [THINKING_PANE, IDLE_PANE];
  let clock = 0;
  const r = await awaitIdleBaseline({
    read: async () => panes[i++],
    timeoutMs: 5000,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(r.idle, true);
  assert.equal(r.reason, "idle");
  assert.equal(r.state, "idle");
});

test("awaitIdleBaseline: stays thinking -> timeout-busy, never injectable", async () => {
  let clock = 0;
  const r = await awaitIdleBaseline({
    read: async () => THINKING_PANE,
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(r.idle, false);
  assert.equal(r.reason, "timeout-busy");
  assert.equal(r.state, "thinking");
});

test("awaitIdleBaseline: capture error aborts cleanly (capture-error)", async () => {
  let clock = 0;
  const r = await awaitIdleBaseline({
    read: async () => { throw new Error("ccmux capture failed"); },
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(r.idle, false);
  assert.equal(r.reason, "capture-error");
});

test("awaitIdleBaseline: done+idle evidence resolves to injectable", async () => {
  let clock = 0;
  const r = await awaitIdleBaseline({
    read: async () => DONE_IDLE_PANE,
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(r.idle, true);
  assert.equal(r.injectable, true);
  assert.equal(r.state, "done");
});

test("awaitIdleBaseline: done+spinner stays non-injectable -> timeout-busy", async () => {
  let clock = 0;
  const r = await awaitIdleBaseline({
    read: async () => DONE_SPINNER_PANE,
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(r.idle, false);
  assert.equal(r.injectable, false);
  assert.equal(r.reason, "timeout-busy");
  assert.equal(r.state, "done");
});

// ---------------------------------------------------------------------------
// Integration: executeCoordinatedSlash pre-injection gate.
// ---------------------------------------------------------------------------

// Recording coordinator that mirrors the locked critical section: acquire lock,
// run captureBaseline (the gate) under the lock, inject only if it returned a
// baseline, release. This is where the real coordinator serializes contenders;
// the per-session lock semantics themselves are covered by the
// session-coordinator suite. Here we assert the gate runs inside that section.
function recordingCoordinator(rec) {
  return async ({ captureBaseline, inject }) => {
    rec.lockAcquired = true;
    let baseline;
    try {
      baseline = await captureBaseline();
    } catch (e) {
      rec.captureBaselineThrew = e;
      rec.released = true;
      return {
        ack: "not-injected",
        reason: "baseline-error",
        error: e.message,
        commandId: "cmd-1",
        commandClass: "mode-changing",
        session: "x",
        attempts: 1,
        injectedAt: null,
        payload: null,
        states: ["queued", "pre-write", "released"],
      };
    }
    rec.injectCalled = true;
    const payload = await inject({ baseline });
    rec.released = true;
    return {
      ack: "injected",
      payload,
      commandId: payload.commandId,
      commandClass: "mode-changing",
      attempts: 1,
      states: ["queued", "injecting", "acknowledged", "released"],
    };
  };
}

function gateDeps({ panes, barrierReady = true }) {
  let i = 0;
  let clock = 0;
  const rec = { lockAcquired: false, injectCalled: false, released: false };
  return {
    _rec: rec,
    coordinateInjection: recordingCoordinator(rec),
    capture: async () => panes[Math.min(i++, panes.length - 1)],
    enterText: (session, t) => ({ session, entered: true, bytes: t.length }),
    sendEnter: (session) => ({ session }),
    modeReadyBarrier: async () => ({
      ready: barrierReady,
      state: barrierReady ? "idle" : "thinking",
      reason: barrierReady ? "fresh-ready" : "timeout-not-ready",
      waitedMs: 1,
      attempts: 1,
      evidence: {},
    }),
    now: () => new Date(Date.UTC(2026, 6, 30, 0, 0, 0, clock)),
    sleep: async (ms) => { clock += ms; },
  };
}

test("slash gate: thinking then idle -> inject exactly once, only after idle", async () => {
  const deps = gateDeps({ panes: [THINKING_PANE, IDLE_PANE] });
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "idle-timeout-ms": "5000" },
    deps,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(deps._rec.injectCalled, true);
  assert.equal(result.body.preInjection, undefined);
});

test("slash gate: stays thinking -> no injection, not-injected nonzero result", async () => {
  const deps = gateDeps({ panes: [THINKING_PANE] });
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "idle-timeout-ms": "3000" },
    deps,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 7);
  assert.equal(deps._rec.injectCalled, false);
  assert.equal(result.body.readiness.phase, "pre-injection");
  assert.equal(result.body.readiness.reason, "baseline-not-idle");
  assert.equal(result.body.preInjection.state, "thinking");
});

test("slash gate: needs_input -> no injection", async () => {
  const deps = gateDeps({ panes: [NEEDS_INPUT_PANE] });
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "idle-timeout-ms": "3000" },
    deps,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(deps._rec.injectCalled, false);
  assert.equal(result.body.readiness.reason, "baseline-not-idle");
  assert.equal(result.body.preInjection.state, "needs_input");
});

test("slash gate: queued-message pane (artifact fixture) -> no injection", async () => {
  const deps = gateDeps({ panes: [QUEUED_PANE] });
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "idle-timeout-ms": "3000" },
    deps,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(deps._rec.injectCalled, false);
  assert.equal(result.body.readiness.reason, "baseline-not-idle");
});

test("slash gate: gate runs under the lock (captureBaseline before inject, release on busy)", async () => {
  const deps = gateDeps({ panes: [THINKING_PANE] });
  await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "idle-timeout-ms": "2000" },
    deps,
  });
  // The lock was acquired and released even though the pane stayed busy, and
  // inject was never reached. Same-section serialization is preserved because
  // the gate is the coordinator's captureBaseline callback.
  assert.equal(deps._rec.lockAcquired, true);
  assert.equal(deps._rec.released, true);
  assert.equal(deps._rec.injectCalled, false);
  assert.ok(deps._rec.captureBaselineThrew instanceof Error);
});

// ---------------------------------------------------------------------------
// Reports: distinguish pre-injection idle timeout from post-injection readiness
// timeout.
// ---------------------------------------------------------------------------

const TOKEN_OK = { ok: true, expectedCount: 1, observedCount: 1, matchedCount: 1, lost: [], extra: [], duplicates: [], duplicateDetails: [], reordered: false };

test("report: pre-injection idle timeout is labeled pre-injection", () => {
  const v = computeRunVerdict({
    tokenVerdict: TOKEN_OK,
    trialResults: [
      {
        id: "T-1",
        slash: {
          exitCode: 7,
          body: { readiness: { phase: "pre-injection", reason: "baseline-not-idle", state: "thinking" } },
        },
        send: { skipped: true },
      },
    ],
  });
  assert.equal(v.deliveryOk, false);
  assert.equal(v.undelivered[0].slashPhase, "pre-injection");
  assert.equal(v.undelivered[0].slashReason, "baseline-not-idle");
  const text = formatFailureReport(v);
  assert.match(text, /pre-injection/);
  assert.match(text, /baseline-not-idle/);
});

test("report: post-injection readiness timeout is labeled post-injection", () => {
  const v = computeRunVerdict({
    tokenVerdict: TOKEN_OK,
    trialResults: [
      {
        id: "T-1",
        slash: {
          exitCode: 6,
          body: { readiness: { reason: "timeout-not-ready", state: "thinking" } },
        },
        send: { skipped: true },
      },
    ],
  });
  assert.equal(v.deliveryOk, false);
  assert.equal(v.undelivered[0].slashPhase, "post-injection");
  assert.equal(v.undelivered[0].slashReason, "timeout-not-ready");
  const text = formatFailureReport(v);
  assert.match(text, /post-injection/);
  assert.match(text, /timeout-not-ready/);
});
