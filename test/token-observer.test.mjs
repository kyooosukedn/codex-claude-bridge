// Pure unit tests for the streaming token observer/accumulator.

import assert from "node:assert/strict";
import test from "node:test";

import { createTokenObserver } from "../lib/token-observer.mjs";

const RE = () => /CCBSTRESS-\d+/g;

test("repeated token across snapshots (once each) is NOT a duplicate", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001");
  o.ingestText("CCBSTRESS-001\nCCBSTRESS-002");
  o.ingestText("CCBSTRESS-001"); // persists in scrollback
  assert.deepEqual(o.effectiveObserved(), ["CCBSTRESS-001", "CCBSTRESS-002"]);
  assert.equal(o.summary().maxConcurrent, 1);
});

test("two copies in ONE snapshot count as a duplicate (maxConcurrent 2)", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001");
  o.ingestText("CCBSTRESS-001\nCCBSTRESS-001"); // double injection in one frame
  o.ingestText("CCBSTRESS-001");
  assert.deepEqual(o.effectiveObserved(), ["CCBSTRESS-001", "CCBSTRESS-001"]);
  assert.equal(o.summary().maxConcurrent, 2);
});

test("first-seen order is preserved across snapshots", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-003");
  o.ingestText("CCBSTRESS-001");
  o.ingestText("CCBSTRESS-002");
  assert.deepEqual(o.firstSeenOrder, ["CCBSTRESS-003", "CCBSTRESS-001", "CCBSTRESS-002"]);
});

test("foreign/unexpected tokens are retained (surface as extra downstream)", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001\nCCBSTRESS-999");
  assert.ok(o.firstSeenOrder.includes("CCBSTRESS-999"));
  assert.ok(o.effectiveObserved().includes("CCBSTRESS-999"));
});

test("ingestError records a capture failure without throwing (fail closed)", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001");
  o.ingestError(new Error("ccmux capture failed"), { phase: "after-send:CCBSTRESS-002" });
  o.ingestText("CCBSTRESS-002");
  const s = o.summary();
  assert.equal(s.captureErrors, 1);
  assert.match(s.lastCaptureError, /ccmux capture failed/);
  assert.equal(s.snapshots, 3);
});

test("summary reports streaming mode and useful counts without prompt text", () => {
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001\nCCBSTRESS-002");
  o.ingestText("CCBSTRESS-002");
  const s = o.summary();
  assert.equal(s.mode, "streaming");
  assert.equal(s.snapshots, 2);
  assert.equal(s.distinctTokens, 2);
  assert.equal(s.maxConcurrent, 1);
  assert.equal(s.captureErrors, 0);
  // sample contains token ids, never prompt bodies
  assert.ok(JSON.stringify(s).includes("CCBSTRESS-001"));
  assert.ok(!JSON.stringify(s).toLowerCase().includes("acknowledge"));
});

test("effectiveObserved expansion makes computeVerdict flag a single-frame double", () => {
  // Local re-derivation of the duplicate check to keep this test independent of
  // computeVerdict internals: a maxConcurrent of 2 means the effective multiset
  // contains the token twice.
  const o = createTokenObserver({ pattern: RE() });
  o.ingestText("CCBSTRESS-001\nCCBSTRESS-001");
  const eff = o.effectiveObserved();
  const counts = new Map();
  for (const id of eff) counts.set(id, (counts.get(id) ?? 0) + 1);
  assert.equal(counts.get("CCBSTRESS-001"), 2);
});
