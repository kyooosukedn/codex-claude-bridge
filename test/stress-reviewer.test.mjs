// Reviewer-driven strengthening of the P1 harness.
// Covers: delivery-aware verdict (item 1), single-occurrence prompt +
// id-prefix validation (item 2), bounded readiness wait before trial 1
// (item 3), and the opt-in 3-session isolation path (item 5).

import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitReady,
  buildMultiSessionPlan,
  buildTrials,
  computeRunVerdict,
  formatFailureReport,
  runMultiSessionIsolation,
  sendTerminalStatus,
  tokenPattern,
} from "../lib/stress-harness.mjs";

// ---------------------------------------------------------------------------
// Item 1 — run verdict MUST fail on any nonzero slash/send exitCode or a
// send terminal status other than "done", even when every token is present.
// ---------------------------------------------------------------------------

test("sendTerminalStatus reads body.status then body.terminal.status", () => {
  assert.equal(sendTerminalStatus({ body: { status: "done" } }), "done");
  assert.equal(sendTerminalStatus({ body: { terminal: { status: "timeout" } } }), "timeout");
  assert.equal(sendTerminalStatus({ exitCode: 9 }), null);
});

test("computeRunVerdict passes when every trial is delivered and done", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const trialResults = [
    { id: "CCBSTRESS-001", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } },
    { id: "CCBSTRESS-002", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } },
  ];
  const verdict = computeRunVerdict({ tokenVerdict, trialResults });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.deliveryOk, true);
  assert.deepEqual(verdict.undelivered, []);
});

test("computeRunVerdict fails when a send exited nonzero even with all tokens present", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const trialResults = [
    { id: "CCBSTRESS-001", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } },
    { id: "CCBSTRESS-002", slash: { exitCode: 0 }, send: { exitCode: 9 } },
  ];
  const verdict = computeRunVerdict({ tokenVerdict, trialResults });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.deliveryOk, false);
  assert.deepEqual(verdict.undelivered.map((u) => u.id), ["CCBSTRESS-002"]);
});

test("computeRunVerdict fails when send terminal status is timeout", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const trialResults = [
    { id: "CCBSTRESS-001", slash: { exitCode: 0 }, send: { exitCode: 5, body: { status: "timeout" } } },
  ];
  const verdict = computeRunVerdict({ tokenVerdict, trialResults });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.undelivered[0].status, "timeout");
});

test("computeRunVerdict fails when a slash exited nonzero", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const trialResults = [
    { id: "CCBSTRESS-001", slash: { exitCode: 6 }, send: { exitCode: 0, body: { status: "done" } } },
  ];
  const verdict = computeRunVerdict({ tokenVerdict, trialResults });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.undelivered[0].slashOk, false);
});

// ---------------------------------------------------------------------------
// Item 2 — the prompt embeds the token exactly once and instructs Claude NOT
// to repeat it; id-prefix is strictly validated before building a RegExp.
// ---------------------------------------------------------------------------

test("buildTrials prompt contains the id exactly once and asks not to repeat it", () => {
  const [trial] = buildTrials({ count: 1 });
  const matches = trial.promptText.match(/CCBSTRESS-001/g) || [];
  assert.equal(matches.length, 1, "token must appear exactly once in the prompt");
  assert.match(trial.promptText, /do not repeat|without repeating|reply|acknowledge/i);
});

test("tokenPattern rejects an id-prefix with RegExp metacharacters", () => {
  assert.throws(() => tokenPattern("bad|prefix"), /id-prefix|invalid/i);
  assert.throws(() => tokenPattern("a]b"), /id-prefix|invalid/i);
});

test("buildTrials rejects an unsafe id-prefix", () => {
  assert.throws(() => buildTrials({ count: 2, idPrefix: "x*y" }), /id-prefix|invalid/i);
});

// ---------------------------------------------------------------------------
// Item 3 — bounded readiness wait before trial 1. Deterministic fake clock.
// ---------------------------------------------------------------------------

test("awaitReady confirms readiness within a bounded timeout", async () => {
  let clock = 0;
  let calls = 0;
  const result = await awaitReady({
    capture: async () => (calls++ === 0 ? "loading" : "> idle"),
    isReady: (t) => t.includes(">"),
    timeoutMs: 1000,
    intervalMs: 1,
    now: () => clock,
    sleep: async () => { clock += 10; },
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
});

test("awaitReady returns not-ready after the bounded timeout", async () => {
  let clock = 0;
  const result = await awaitReady({
    capture: async () => "loading",
    isReady: (t) => t.includes(">"),
    timeoutMs: 50,
    intervalMs: 1,
    now: () => clock,
    sleep: async () => { clock += 10; },
  });
  assert.equal(result.ready, false);
  assert.ok(result.attempts >= 1);
  assert.equal(result.tail, "loading");
});

// ---------------------------------------------------------------------------
// Item 5 — opt-in 3-session isolation. Fakes only; never launches Claude.
// ---------------------------------------------------------------------------

function isolationDeps({ foreignFor = null } = {}) {
  const panes = {};
  return {
    slash: async () => ({ exitCode: 0 }),
    send: async (session, prompt) => {
      panes[session] = panes[session] || [];
      panes[session].push(prompt);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async (session) => {
      const own = (panes[session] || []).join("\n");
      return foreignFor === session ? `${own}\nCCB-B-002` : own;
    },
    now: () => new Date(),
  };
}

test("runMultiSessionIsolation passes when each pane has only its own tokens", async () => {
  const plan = buildMultiSessionPlan({
    sessions: ["sess-a", "sess-b", "sess-c"],
    trialsPerSession: 3,
    idPrefix: "CCB",
  });
  const result = await runMultiSessionIsolation({ plan, deps: isolationDeps() });
  assert.equal(result.ok, true);
  assert.equal(result.perSession.length, 3);
  for (const entry of result.perSession) {
    assert.equal(entry.verdict.ok, true, `${entry.session} leaked or lost tokens`);
  }
});

test("runMultiSessionIsolation fails when a foreign token appears in a pane", async () => {
  const plan = buildMultiSessionPlan({
    sessions: ["sess-a", "sess-b", "sess-c"],
    trialsPerSession: 3,
    idPrefix: "CCB",
  });
  const result = await runMultiSessionIsolation({
    plan,
    deps: isolationDeps({ foreignFor: "sess-a" }),
  });
  assert.equal(result.ok, false);
  const a = result.perSession.find((e) => e.session === "sess-a");
  assert.ok(a.verdict.extra.includes("CCB-B-002"));
});

// ---------------------------------------------------------------------------
// Defect 2 — isolation MUST be delivery-aware. Even when every token is
// observed, a nonzero slash/send exit or a non-done send terminal status must
// fail the run. (Token-only verdict was a false pass.)
// ---------------------------------------------------------------------------

// Adversarial fake: tokens are ALWAYS observed, but delivery can be corrupted
// per session — exactly the false-pass shape the reviewer flagged.
function deliveryDeps({ badSlashSession, badSendSession, timeoutSession } = {}) {
  const panes = {};
  return {
    slash: async (session) => ({ exitCode: badSlashSession === session ? 6 : 0 }),
    send: async (session, prompt) => {
      panes[session] = panes[session] || [];
      const match = prompt.match(/CCB-[A-Za-z0-9._-]+-\d+/);
      if (match) panes[session].push(match[0]);
      if (badSendSession === session) return { exitCode: 9 };
      if (timeoutSession === session) return { exitCode: 5, body: { status: "timeout" } };
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async (session) => (panes[session] || []).join("\n"),
    now: () => new Date(),
  };
}

function threeSessionPlan() {
  return buildMultiSessionPlan({
    sessions: ["sess-a", "sess-b", "sess-c"],
    trialsPerSession: 3,
    idPrefix: "CCB",
  });
}

test("isolation fails when a slash exits nonzero even with all tokens observed", async () => {
  const result = await runMultiSessionIsolation({
    plan: threeSessionPlan(),
    deps: deliveryDeps({ badSlashSession: "sess-b" }),
  });
  assert.equal(result.ok, false);
  const b = result.perSession.find((e) => e.session === "sess-b");
  assert.equal(b.verdict.ok, false);
  assert.ok(b.verdict.undelivered.length > 0);
  assert.equal(b.verdict.undelivered[0].slashOk, false);
});

test("isolation fails when a send exits nonzero even with all tokens observed", async () => {
  const result = await runMultiSessionIsolation({
    plan: threeSessionPlan(),
    deps: deliveryDeps({ badSendSession: "sess-b" }),
  });
  assert.equal(result.ok, false);
  const b = result.perSession.find((e) => e.session === "sess-b");
  assert.equal(b.verdict.ok, false);
  assert.equal(b.verdict.undelivered[0].sendOk, false);
});

test("isolation fails when a send terminal status is timeout", async () => {
  const result = await runMultiSessionIsolation({
    plan: threeSessionPlan(),
    deps: deliveryDeps({ timeoutSession: "sess-b" }),
  });
  assert.equal(result.ok, false);
  const b = result.perSession.find((e) => e.session === "sess-b");
  assert.equal(b.verdict.ok, false);
  assert.equal(b.verdict.undelivered[0].status, "timeout");
});

test("isolation records per-session trialResults for diagnostics", async () => {
  const result = await runMultiSessionIsolation({
    plan: threeSessionPlan(),
    deps: deliveryDeps(),
  });
  const b = result.perSession.find((e) => e.session === "sess-b");
  assert.equal(b.trialResults.length, 3);
  assert.ok(b.trialResults[0].id);
});

// ---------------------------------------------------------------------------
// Defect 3 — failure reports must visibly surface undelivered trial details.
// ---------------------------------------------------------------------------

test("formatFailureReport lists undelivered trial ids with slash/send/status detail", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const verdict = computeRunVerdict({
    tokenVerdict,
    trialResults: [
      { id: "CCBSTRESS-001", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } },
      { id: "CCBSTRESS-002", slash: { exitCode: 6 }, send: { exitCode: 0, body: { status: "done" } } },
      { id: "CCBSTRESS-003", slash: { exitCode: 0 }, send: { exitCode: 5, body: { status: "timeout" } } },
    ],
  });
  const text = formatFailureReport(verdict);
  assert.match(text, /undelivered/i);
  assert.match(text, /CCBSTRESS-002/);
  assert.match(text, /CCBSTRESS-003/);
  assert.match(text, /slashOk.*false|false.*slashOk/i);
  assert.match(text, /timeout/);
});

test("formatFailureReport stays terse for a clean delivery-aware verdict", () => {
  const tokenVerdict = { ok: true, lost: [], extra: [], duplicates: [], reordered: false };
  const verdict = computeRunVerdict({
    tokenVerdict,
    trialResults: [
      { id: "CCBSTRESS-001", slash: { exitCode: 0 }, send: { exitCode: 0, body: { status: "done" } } },
    ],
  });
  assert.equal(formatFailureReport(verdict).trim(), "");
});
