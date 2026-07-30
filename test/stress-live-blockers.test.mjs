// Second-review live-path blockers: (A) isolation capture budget, (B) fail
// closed on malformed result shapes, (C) per-session fail-fast on slash/send
// failure. All deterministic fakes; never launches Claude.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMultiSessionPlan,
  computeRunVerdict,
  runMultiSessionIsolation,
  runStress,
} from "../lib/stress-harness.mjs";

// ---------------------------------------------------------------------------
// A — isolation capture must receive an explicit, finite line budget (never
// undefined, which would reach ccmux as "--lines undefined").
// ---------------------------------------------------------------------------

test("runMultiSessionIsolation passes captureLines to deps.capture", async () => {
  let received = null;
  const plan = buildMultiSessionPlan({
    sessions: ["a", "b"],
    trialsPerSession: 1,
    idPrefix: "CCB",
  });
  await runMultiSessionIsolation({
    plan,
    captureLines: 1234,
    deps: {
      slash: async () => ({ exitCode: 0 }),
      send: async () => ({ exitCode: 0, body: { status: "done" } }),
      capture: async (_session, lines) => { received = lines; return ""; },
      now: () => new Date(),
    },
  });
  assert.equal(received, 1234);
});

test("runMultiSessionIsolation never passes an undefined capture budget", async () => {
  const seen = [];
  const plan = buildMultiSessionPlan({
    sessions: ["a", "b"],
    trialsPerSession: 1,
    idPrefix: "CCB",
  });
  await runMultiSessionIsolation({
    plan,
    deps: {
      slash: async () => ({ exitCode: 0 }),
      send: async () => ({ exitCode: 0, body: { status: "done" } }),
      capture: async (_session, lines) => { seen.push(lines); return ""; },
      now: () => new Date(),
    },
  });
  // Streaming: each session captures at baseline + after-trial + final, so the
  // call count is > 1 per session. The invariant under test is that EVERY call
  // receives a positive-integer budget (never undefined).
  assert.ok(seen.length >= 2, `expected multiple streaming captures, got ${seen.length}`);
  for (const lines of seen) {
    assert.ok(Number.isInteger(lines) && lines > 0, `captureLines must be a positive int, got ${lines}`);
  }
});

// ---------------------------------------------------------------------------
// B — computeRunVerdict must fail closed on malformed shapes: a missing
// slash/send exitCode is NOT treated as 0, and a missing terminal status is
// NOT treated as done.
// ---------------------------------------------------------------------------

const OK_TOKEN = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };

test("computeRunVerdict fails closed when slash exitCode is missing", () => {
  const v = computeRunVerdict({
    tokenVerdict: OK_TOKEN,
    trialResults: [{ id: "X", slash: {}, send: { exitCode: 0, body: { status: "done" } } }],
  });
  assert.equal(v.ok, false);
  assert.equal(v.undelivered[0].slashOk, false);
});

test("computeRunVerdict fails closed when send exitCode is missing", () => {
  const v = computeRunVerdict({
    tokenVerdict: OK_TOKEN,
    trialResults: [{ id: "X", slash: { exitCode: 0 }, send: { body: { status: "done" } } }],
  });
  assert.equal(v.ok, false);
  assert.equal(v.undelivered[0].sendOk, false);
});

test("computeRunVerdict fails closed when send has no terminal status", () => {
  const v = computeRunVerdict({
    tokenVerdict: OK_TOKEN,
    trialResults: [{ id: "X", slash: { exitCode: 0 }, send: { exitCode: 0 } }],
  });
  assert.equal(v.ok, false);
  assert.equal(v.undelivered[0].status, null);
});

test("computeRunVerdict still passes a well-formed delivered trial", () => {
  const v = computeRunVerdict({
    tokenVerdict: OK_TOKEN,
    trialResults: [{ id: "X", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } }],
  });
  assert.equal(v.ok, true);
});

// ---------------------------------------------------------------------------
// C — per-session fail-fast. A non-success slash records a skipped-send and
// stops the session; a non-done send stops the session. Remaining trials are
// not attempted and appear lost. A failing session does not cancel others.
// ---------------------------------------------------------------------------

function baseConfig(trials) {
  return { mode: "dry-run", trials, session: "x", idPrefix: "CCBSTRESS", slashCommand: "/m" };
}

test("runStress does not call send after a slash failure and stops later trials", async () => {
  let slashCalls = 0;
  let sendCalls = 0;
  const result = await runStress({
    config: baseConfig(5),
    deps: {
      slash: async () => { slashCalls += 1; return slashCalls === 2 ? { exitCode: 6 } : { exitCode: 0 }; },
      send: async () => { sendCalls += 1; return { exitCode: 0, body: { status: "done" } }; },
      capture: async () => "",
      now: () => new Date(),
    },
  });
  assert.equal(slashCalls, 2, "should stop at the failing slash");
  assert.equal(sendCalls, 1, "send must not run for the failed trial or any later one");
  assert.equal(result.verdict.ok, false);
  // remaining trials (3,4,5) were never sent -> lost
  assert.ok(result.verdict.lost.includes("CCBSTRESS-004"));
});

test("runStress stops after a send timeout and attempts no later trial", async () => {
  let sendCalls = 0;
  const result = await runStress({
    config: baseConfig(4),
    deps: {
      slash: async () => ({ exitCode: 0 }),
      send: async () => {
        sendCalls += 1;
        return sendCalls === 2 ? { exitCode: 5, body: { status: "timeout" } } : { exitCode: 0, body: { status: "done" } };
      },
      capture: async () => "",
      now: () => new Date(),
    },
  });
  assert.equal(sendCalls, 2);
  assert.equal(result.verdict.ok, false);
  assert.ok(result.verdict.lost.includes("CCBSTRESS-003"));
});

test("runStress marks the failed trial as undelivered with a skipped-send on slash failure", async () => {
  const result = await runStress({
    config: baseConfig(3),
    deps: {
      slash: async () => ({ exitCode: 7 }),
      send: async () => { throw new Error("send must not be called"); },
      capture: async () => "",
      now: () => new Date(),
    },
  });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.undelivered[0].id, "CCBSTRESS-001");
  assert.equal(result.verdict.undelivered[0].slashOk, false);
});

test("isolation fail-fast: a failing session is stopped but independent sessions complete", async () => {
  const sendCalls = { a: 0, b: 0, c: 0 };
  const plan = buildMultiSessionPlan({
    sessions: ["a", "b", "c"],
    trialsPerSession: 3,
    idPrefix: "CCB",
  });
  const result = await runMultiSessionIsolation({
    plan,
    captureLines: 1000,
    deps: {
      slash: async (s) => ({ exitCode: s === "b" ? 6 : 0 }),
      send: async (s) => { sendCalls[s] += 1; return { exitCode: 0, body: { status: "done" } }; },
      capture: async () => "",
      now: () => new Date(),
    },
  });
  assert.equal(sendCalls.b, 0, "failing session must not call send");
  assert.equal(sendCalls.a, 3, "independent session a must complete");
  assert.equal(sendCalls.c, 3, "independent session c must complete");
  assert.equal(result.ok, false);
  const b = result.perSession.find((e) => e.session === "b");
  assert.equal(b.verdict.ok, false);
  assert.equal(b.verdict.undelivered[0].slashOk, false);
});
