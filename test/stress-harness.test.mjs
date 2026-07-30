// Unit coverage for the opt-in P1 stress / fault harness.
//
// The live harness (bin/ccb-stress.mjs) launches real Claude sessions and is
// never invoked from `npm test`. Everything machine-verifiable about a run —
// argument parsing, trial planning, token extraction, the lost/duplicate/
// reorder verdict, report formatting, and artifact cleanup — lives in
// lib/stress-harness.mjs as pure functions and is exercised here with
// deterministic inputs on whatever platform `npm test` runs on.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMultiSessionPlan,
  buildTrials,
  computeVerdict,
  createBoundedSleep,
  defaultIsReady,
  extractTokens,
  parseStressConfig,
  runMultiSessionIsolation,
} from "../lib/stress-harness.mjs";

// ---------------------------------------------------------------------------
// Verdict aggregation — the machine-verifiable core of "zero lost / duplicate /
// reordered".
// ---------------------------------------------------------------------------

test("computeVerdict passes when observed ids match expected in order", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
    observedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.lost, []);
  assert.deepEqual(verdict.extra, []);
  assert.deepEqual(verdict.duplicates, []);
  assert.equal(verdict.reordered, false);
  assert.equal(verdict.matchedCount, 3);
});

test("computeVerdict flags a lost id", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
    observedIds: ["CCBSTRESS-001", "CCBSTRESS-003"],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.lost, ["CCBSTRESS-002"]);
  assert.equal(verdict.matchedCount, 2);
});

test("computeVerdict flags a duplicate id", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002"],
    observedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-002"],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.duplicates, ["CCBSTRESS-002"]);
  assert.equal(verdict.duplicateDetails[0].count, 2);
});

test("computeVerdict flags reordered delivery", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
    observedIds: ["CCBSTRESS-002", "CCBSTRESS-001", "CCBSTRESS-003"],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reordered, true);
});

test("computeVerdict flags an unexpected extra id", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002"],
    observedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-999"],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.extra, ["CCBSTRESS-999"]);
});

test("computeVerdict reports observed and expected counts for the report", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002"],
    observedIds: ["CCBSTRESS-001"],
  });
  assert.equal(verdict.expectedCount, 2);
  assert.equal(verdict.observedCount, 1);
});

// ---------------------------------------------------------------------------
// Token extraction from a captured pane.
// ---------------------------------------------------------------------------

test("extractTokens returns ids in captured order, ignoring noise", () => {
  const text =
    "some scrollback\nCCBSTRESS-001 reply\nnoise CCBSTRESS-002\nCCBSTRESS-003";
  const ids = extractTokens(text, { pattern: /CCBSTRESS-\d{3}/g });
  assert.deepEqual(ids, ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"]);
});

test("extractTokens preserves raw capture order including repeats", () => {
  const ids = extractTokens("CCBSTRESS-007 CCBSTRESS-007", {
    pattern: /CCBSTRESS-\d{3}/g,
  });
  assert.deepEqual(ids, ["CCBSTRESS-007", "CCBSTRESS-007"]);
});

// ---------------------------------------------------------------------------
// Trial planning — unique, zero-padded, monotonic ids.
// ---------------------------------------------------------------------------

test("buildTrials emits unique zero-padded ids and matching prompts", () => {
  const trials = buildTrials({ count: 3 });
  assert.deepEqual(
    trials.map((t) => t.id),
    ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
  );
  for (const trial of trials) {
    assert.ok(trial.promptText.includes(trial.id));
    assert.ok(Number.isInteger(trial.index) && trial.index >= 1);
  }
});

test("buildTrials pads to the width of the count", () => {
  const trials = buildTrials({ count: 100 });
  assert.equal(trials[0].id, "CCBSTRESS-001");
  assert.equal(trials[99].id, "CCBSTRESS-100");
  assert.equal(new Set(trials.map((t) => t.id)).size, 100);
});

// ---------------------------------------------------------------------------
// Opt-in safety.
// ---------------------------------------------------------------------------

test("parseStressConfig defaults to dry-run and never reports live mode", () => {
  const config = parseStressConfig(["--trials", "5", "--session", "ccb-x"]);
  assert.equal(config.mode, "dry-run");
  assert.equal(config.trials, 5);
  assert.equal(config.session, "ccb-x");
});

test("parseStressConfig refuses live mode without explicit confirmation", () => {
  assert.throws(
    () => parseStressConfig(["--trials", "5", "--live"]),
    /--yes|confirm/i,
  );
});

test("parseStressConfig enables live mode only with --live and --yes", () => {
  const config = parseStressConfig([
    "--trials",
    "5",
    "--session",
    "ccb-x",
    "--live",
    "--yes",
  ]);
  assert.equal(config.mode, "live");
});

test("parseStressConfig rejects a non-positive trial count", () => {
  for (const bad of ["0", "-3", "abc", "1.5"]) {
    assert.throws(
      () => parseStressConfig(["--trials", bad]),
      /trials|positive/i,
      `expected rejection for --trials ${bad}`,
    );
  }
});

test("parseStressConfig requires a session name in live mode", () => {
  assert.throws(
    () => parseStressConfig(["--trials", "5", "--live", "--yes"]),
    /session/i,
  );
});

test("parseStressConfig allows live isolation without --session", () => {
  const config = parseStressConfig([
    "--isolation",
    "--sessions",
    "a,b,c",
    "--live",
    "--yes",
  ]);
  assert.equal(config.mode, "live");
  assert.equal(config.isolation, true);
  assert.deepEqual(config.sessions, ["a", "b", "c"]);
});

test("parseStressConfig still requires --session for non-isolation live mode", () => {
  assert.throws(
    () => parseStressConfig(["--trials", "5", "--live", "--yes"]),
    /session/i,
  );
});

// ---------------------------------------------------------------------------
// defaultIsReady — version-agnostic idle hints.
// ---------------------------------------------------------------------------

test("defaultIsReady matches the empty prompt, footer, and queued-messages hint", () => {
  // The leading "Press up" wording has varied across Claude Code versions, so
  // we match the stable "edit queued messages" phrase without it.
  assert.equal(defaultIsReady("  > \n  bypass permissions on"), true);
  assert.equal(defaultIsReady("  edit queued messages"), true);
  assert.equal(defaultIsReady("  Press up edit queued messages"), true);
});

test("defaultIsReady returns false for non-idle pane text", () => {
  assert.equal(defaultIsReady("  ⠋ thinking hard"), false);
  assert.equal(defaultIsReady(""), false);
});

// ---------------------------------------------------------------------------
// createBoundedSleep — the live --sleep-ms wiring.
// ---------------------------------------------------------------------------

test("createBoundedSleep pauses only for a positive duration (zero stays fast)", async () => {
  let called = null;
  const sleep = createBoundedSleep(async (ms) => {
    called = ms;
  });
  // Zero/undefined budget must be a true no-op so the default fast run is
  // unchanged.
  called = null;
  await sleep(0);
  assert.equal(called, null);
  called = null;
  await sleep(undefined);
  assert.equal(called, null);
  called = null;
  await sleep(NaN);
  assert.equal(called, null);
  // A positive budget actually pauses (passes the duration to the sleep impl).
  called = null;
  await sleep(250);
  assert.equal(called, 250);
});

// ---------------------------------------------------------------------------
// runMultiSessionIsolation — --sleep-ms must reach deps.sleep in isolation too.
// ---------------------------------------------------------------------------

function isolationDeps(plan, sleeps) {
  const idsBySession = Object.fromEntries(
    plan.sessions.map((s) => [s.session, s.trials.map((t) => t.id).join("\n")]),
  );
  return {
    // Each capture surfaces this session's token so the run verdicts ok.
    capture: async (session) => `${idsBySession[session] ?? ""}\nok`,
    slash: async () => ({ exitCode: 0 }),
    send: async () => ({ exitCode: 0, body: { status: "done" } }),
    sleep: async (ms) => { sleeps.push(ms); },
  };
}

test("runMultiSessionIsolation forwards a positive sleepMs to deps.sleep", async () => {
  const plan = buildMultiSessionPlan({
    sessions: ["a", "b"],
    trialsPerSession: 1,
    idPrefix: "CCBISO",
  });
  const sleeps = [];
  const result = await runMultiSessionIsolation({ plan, deps: isolationDeps(plan, sleeps), sleepMs: 250 });
  assert.equal(result.ok, true);
  // One successful trial per session -> one paced sleep each, forwarded exactly.
  assert.deepEqual(sleeps, [250, 250]);
});

test("runMultiSessionIsolation defaults to an explicit zero sleep (never undefined)", async () => {
  // Regression: the driver used to call deps.sleep() with no argument, which the
  // live bounded sleep treats as a no-op — so --sleep-ms was inert in isolation.
  // The default must thread an explicit 0 (the live sleep no-ops on 0, fast).
  const plan = buildMultiSessionPlan({
    sessions: ["a", "b"],
    trialsPerSession: 1,
    idPrefix: "CCBISO",
  });
  const sleeps = [];
  const result = await runMultiSessionIsolation({ plan, deps: isolationDeps(plan, sleeps) });
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [0, 0]);
});
