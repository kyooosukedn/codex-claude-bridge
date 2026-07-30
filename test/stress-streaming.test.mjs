// Streaming observation integration for runStress / runMultiSessionIsolation.
//
// Proves the harness certifies delivery from ACCUMULATED snapshots, not a
// single final scrollback — so `tmux history-limit 2000` cannot manufacture
// spurious "lost" tokens, and transient corruption that later scrolls away is
// still caught.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMultiSessionPlan,
  runMultiSessionIsolation,
  runStress,
} from "../lib/stress-harness.mjs";

// Rolling-window fake: the pane only retains the last `window` tokens sent.
// This models a real tmux history-limit. Optional hooks:
//   - duplicateAt: append a second copy of a token whenever it is in view
//     (simulates a real double injection visible in one frame).
//   - dropAt: a send whose token never enters the pane (lost delivery).
//   - baselineStale: tokens present in the BASELINE capture only (stale
//     same-prefix leftovers from a prior run).
//   - failCaptureOnCall: throw on the Nth capture (capture-error fail-closed).
function rollingDeps({
  window = 3,
  duplicateAt = null,
  dropAt = null,
  baselineStale = [],
  failCaptureOnCall = null,
} = {}) {
  const scrollback = [];
  let captureCalls = 0;
  return {
    slash: async () => ({ exitCode: 0 }),
    send: async (_session, promptText) => {
      const m = promptText.match(/CCBSTRESS-\d+/);
      if (m && m[0] !== dropAt) scrollback.push(m[0]);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async () => {
      captureCalls += 1;
      if (failCaptureOnCall === captureCalls) {
        throw new Error("ccmux capture failed");
      }
      if (captureCalls === 1 && baselineStale.length) {
        return baselineStale.join("\n");
      }
      const view = scrollback.slice(-window);
      let text = view.join("\n");
      if (duplicateAt && scrollback.includes(duplicateAt)) {
        text += `\n${duplicateAt}`;
      }
      return text;
    },
    sleep: async () => {},
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  };
}

const baseConfig = (trials) => ({
  mode: "dry-run",
  trials,
  session: "ccb-x",
  idPrefix: "CCBSTRESS",
  slashCommand: "/model default",
});

test("streaming: 100 sequential tokens pass even when final snapshot holds only the last few", async () => {
  // window=3 means the final capture shows only trials 98..100. Final-only
  // observation would report 97 lost; streaming must certify all 100.
  const result = await runStress({
    config: baseConfig(100),
    deps: rollingDeps({ window: 3 }),
  });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.matchedCount, 100);
  assert.equal(result.verdict.lost.length, 0);
  assert.equal(result.observation.mode, "streaming");
  assert.ok(result.observation.snapshots > 100);
});

test("streaming: two copies of a token in one snapshot fail as duplicate", async () => {
  const result = await runStress({
    config: baseConfig(6),
    deps: rollingDeps({ window: 6, duplicateAt: "CCBSTRESS-003" }),
  });
  assert.equal(result.verdict.ok, false);
  assert.ok(result.verdict.duplicates.includes("CCBSTRESS-003"));
  assert.equal(result.observation.maxConcurrent, 2);
});

test("streaming: a token repeating across overlapping snapshots does not false-duplicate", async () => {
  // Large window: every token persists (once per snapshot) across many captures.
  const result = await runStress({
    config: baseConfig(10),
    deps: rollingDeps({ window: 10 }),
  });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.duplicates.length, 0);
  assert.equal(result.observation.maxConcurrent, 1);
});

test("streaming: a dropped token (never observed) fails as lost", async () => {
  const result = await runStress({
    config: baseConfig(5),
    deps: rollingDeps({ window: 5, dropAt: "CCBSTRESS-003" }),
  });
  assert.equal(result.verdict.ok, false);
  assert.deepEqual(result.verdict.lost, ["CCBSTRESS-003"]);
});

test("streaming: stale same-prefix baseline fails as extra (not ignored)", async () => {
  const result = await runStress({
    config: baseConfig(3),
    deps: rollingDeps({ window: 3, baselineStale: ["CCBSTRESS-999"] }),
  });
  assert.equal(result.verdict.ok, false);
  assert.ok(result.verdict.extra.includes("CCBSTRESS-999"));
});

test("streaming: a capture error fails closed and stays machine-verifiable", async () => {
  // Force a capture failure on a mid-run observation.
  const result = await runStress({
    config: baseConfig(4),
    deps: rollingDeps({ window: 4, failCaptureOnCall: 3 }),
  });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.observationError, true);
  assert.ok(result.observation.captureErrors >= 1);
});

test("streaming: a later token observed before an earlier one fails as reorder", async () => {
  // Custom fake: token 001 is rendered late (only after 002 appears), so 002 is
  // first-seen before 001 -> genuine delivery reorder.
  const delivered = [];
  const deps = {
    slash: async () => ({ exitCode: 0 }),
    send: async (_s, promptText) => {
      const m = promptText.match(/CCBSTRESS-\d+/);
      if (m) delivered.push(m[0]);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async () => {
      const view = delivered.filter((t) => t !== "CCBSTRESS-001");
      if (delivered.includes("CCBSTRESS-002")) view.push("CCBSTRESS-001");
      return view.join("\n");
    },
    sleep: async () => {},
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  };
  const result = await runStress({ config: baseConfig(4), deps });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.reordered, true);
});

// ---------------------------------------------------------------------------
// Isolation streaming: a transient foreign token fails even after eviction.
// ---------------------------------------------------------------------------

function isolationRollingDeps({ leakSession, leakToken, leakWhileOwnLE = 1, window = 2 } = {}) {
  const panes = {};
  return {
    slash: async () => ({ exitCode: 0 }),
    send: async (session, promptText) => {
      const m = promptText.match(/CCB-[A-Za-z0-9._-]+-\d+/);
      panes[session] = panes[session] || [];
      if (m) panes[session].push(m[0]);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async (session) => {
      const own = (panes[session] || []).slice(-window);
      let text = own.join("\n");
      if (
        session === leakSession &&
        (panes[session] || []).length <= leakWhileOwnLE
      ) {
        text += `\n${leakToken}`;
      }
      return text;
    },
    now: () => new Date(),
  };
}

test("isolation streaming: transient cross-session leak fails after later eviction", async () => {
  const plan = buildMultiSessionPlan({
    sessions: ["sess-a", "sess-b", "sess-c"],
    trialsPerSession: 3,
    idPrefix: "CCB",
  });
  // sess-a briefly shows sess-b's second token during its first trial, then the
  // leak is gone. Final capture is clean, but streaming retains the foreign
  // token -> extra -> fail.
  const result = await runMultiSessionIsolation({
    plan,
    deps: isolationRollingDeps({ leakSession: "sess-a", leakToken: "CCB-sess-b-002" }),
  });
  assert.equal(result.ok, false);
  const a = result.perSession.find((e) => e.session === "sess-a");
  assert.equal(a.verdict.ok, false);
  assert.ok(a.verdict.extra.includes("CCB-sess-b-002"));
});

test("isolation streaming: clean rolling panes pass", async () => {
  const plan = buildMultiSessionPlan({
    sessions: ["sess-a", "sess-b", "sess-c"],
    trialsPerSession: 5,
    idPrefix: "CCB",
  });
  const result = await runMultiSessionIsolation({
    plan,
    deps: isolationRollingDeps({ window: 2 }),
  });
  assert.equal(result.ok, true);
  for (const entry of result.perSession) {
    assert.equal(entry.verdict.ok, true, `${entry.session} leaked or lost`);
    assert.equal(entry.verdict.observation.mode, "streaming");
  }
});
