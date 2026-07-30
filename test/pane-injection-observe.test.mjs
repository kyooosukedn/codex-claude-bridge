// Regression coverage for observePaneInjection — the post-injection delivery
// check that gates whether a `send` is acknowledged as "injected".
//
// Root cause of CCB100J30B-027 (verdict slashOk=true sendOk=false): the
// observation decided delivery solely by a 12-line tail signature. A
// long/wrapped submitted prompt renders its spinner ABOVE the static footer
// that anchors the bottom 12 lines, so the tail stayed byte-identical to the
// idle baseline even though the pane was clearly "thinking". The classifier
// (which scans a 40-line window for the spinner) returned "thinking" on every
// poll, but that signal was discarded for the delivery decision — a false
// negative that aborted the 100-trial run at trial 27.
//
// These fixtures reproduce that exact rendering shape and pin the fix:
// observe = tail-change OR idle→active state transition.

import assert from "node:assert/strict";
import test from "node:test";

import { observePaneInjection } from "../bin/codex-claude-bridge.mjs";
import { isBaselineInjectable } from "../lib/readiness.mjs";

// The static bottom region of the pane: an empty `>` input prompt plus the
// Claude Code footer. This is byte-identical in the idle baseline AND in the
// post-injection pane (the prompt + spinner render ABOVE it). It is the last
// 12 lines of both, so paneSignature() is equal across them — defeating a
// tail-only delivery check, exactly as in the live failure.
const FOOTER = [
  ">",
  "  glm-5.2 │ work",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
];
const STABLE_TAIL = [
  "  prior assistant text line one",
  "  prior assistant text line two",
  "  prior assistant text line three",
  "  prior assistant text line four",
  "  prior assistant text line five",
  "  prior assistant text line six",
  "  prior assistant text line seven",
  "  prior assistant text line eight",
  ...FOOTER,
];

const idleBaseline = STABLE_TAIL.join("\n");
// Long/wrapped prompt: the submitted text + its spinner render above STABLE_TAIL.
// The spinner sits at line 13 from the bottom — inside classifyPane's 40-line
// scan (→ "thinking") but outside paneSignature's 12-line tail (→ unchanged).
const wrappedThinkingPane = [
  "CCB100J30B-027",
  "Acknowledge with a single OK. Do not repeat the code above.",
  "✢ Deliberating… (↓ 1.2k tokens)",
  ...STABLE_TAIL,
].join("\n");

// Deterministic clock so the polling loop terminates without real timers.
function fakeClock() {
  let ticks = 0;
  return () => ticks++ * 1000;
}

test("wrapped prompt with idle-equivalent tail is observed via thinking state", async () => {
  // Sanity: this is the exact false-negative shape — equal tail signatures but
  // the post-injection pane classifies as "thinking" (spinner in the scan window).
  assert.equal(
    paneSignatureExportStableCheck(idleBaseline),
    paneSignatureExportStableCheck(wrappedThinkingPane),
    "fixture sanity: tails must be equal to reproduce the false negative",
  );

  const result = await observePaneInjection({
    session: "alpha",
    baseline: idleBaseline,
    timeoutMs: 5000,
    capture: () => wrappedThinkingPane,
    now: fakeClock(),
    wait: async () => {},
  });

  assert.equal(result.observed, true);
  assert.equal(result.reason, "thinking");
  assert.equal(result.state, "thinking");
});

test("short prompt that re-renders the tail is still observed by signature", async () => {
  // Existing behavior must not regress: when the tail genuinely changes the
  // signature path confirms delivery regardless of state.
  const changedTail = STABLE_TAIL.slice();
  changedTail[0] = "  fresh assistant text that landed in the tail";
  const changedTailPane = changedTail.join("\n");

  const result = await observePaneInjection({
    session: "alpha",
    baseline: idleBaseline,
    timeoutMs: 5000,
    capture: () => changedTailPane,
    now: fakeClock(),
    wait: async () => {},
  });

  assert.equal(result.observed, true);
  assert.equal(result.reason, "pane-changed");
});

test("already-active baseline is not confirmed (at-most-once preserved)", async () => {
  // Safety invariant: a transition signal requires a QUIESCENT baseline. If the
  // pane was already busy when we captured the baseline, "still thinking" must
  // NOT count as delivery proof — otherwise a queued/lost prompt could be
  // falsely acknowledged and never retried.
  const result = await observePaneInjection({
    session: "alpha",
    baseline: wrappedThinkingPane,
    timeoutMs: 500,
    capture: () => wrappedThinkingPane,
    now: fakeClock(),
    wait: async () => {},
  });

  assert.equal(result.observed, false);
  assert.equal(result.reason, "injection-not-observed");
});

test("unchanged idle pane times out as not-observed", async () => {
  // True negative: nothing changed and the pane never went active — must stay
  // uncertain (safeToRetry=false), never silently acknowledged.
  const result = await observePaneInjection({
    session: "alpha",
    baseline: idleBaseline,
    timeoutMs: 500,
    capture: () => idleBaseline,
    now: fakeClock(),
    wait: async () => {},
  });

  assert.equal(result.observed, false);
  assert.equal(result.reason, "injection-not-observed");
});

// Quiescent "done" baseline: a CCMUX_DONE marker resting on a truly idle empty
// prompt + footer, with NO spinner. The canonical pre-injection rule accepts
// this as injectable (idle or done+footer+emptyPrompt+no-spinner).
const QUIESCENT_DONE = [
  "  prior assistant text line one",
  "  prior assistant text line two",
  "CCMUX_DONE: deadbeef-1234-5678-9abc-def0",
  ">",
  "  glm-5.2 │ work",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
].join("\n");

// Busy "done" baseline: done marker present but a spinner is still active (e.g.
// stop hooks outliving the marker). NOT injectable — must never use the
// idle→active delivery proof.
const BUSY_DONE = [
  "  prior assistant text line one",
  "✢ Running stop hook… (↓ 100 tokens)",
  "CCMUX_DONE: deadbeef-1234-5678-9abc-def0",
  ">",
  "  glm-5.2 │ work",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
].join("\n");

// Post-injection thinking pane: spinner present, no done marker in the tail.
const DONE_THEN_THINKING = [
  "CCB100J30C-027",
  "Acknowledge with a single OK. Do not repeat the code above.",
  "✢ Deliberating… (↓ 1.2k tokens)",
  ">",
  "  glm-5.2 │ work",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
].join("\n");

test("canonical rule accepts quiescent done and rejects busy done", () => {
  assert.equal(isBaselineInjectable(QUIESCENT_DONE).injectable, true);
  assert.equal(isBaselineInjectable(QUIESCENT_DONE).state, "done");
  assert.equal(isBaselineInjectable(BUSY_DONE).injectable, false);
  assert.equal(isBaselineInjectable(BUSY_DONE).state, "done");
});

test("quiescent done baseline can use idle→active delivery proof", async () => {
  // The done marker scrolls out of the tail when the pane goes thinking, so the
  // tail re-renders here; the point is that a done baseline is no longer falsely
  // excluded from the state-transition delivery path.
  const result = await observePaneInjection({
    session: "alpha",
    baseline: QUIESCENT_DONE,
    timeoutMs: 5000,
    capture: () => DONE_THEN_THINKING,
    now: fakeClock(),
    wait: async () => {},
  });
  assert.equal(result.observed, true);
  assert.equal(result.reason, "thinking");
});

test("busy done baseline does not confirm delivery (at-most-once preserved)", async () => {
  // A done+spinner baseline is not quiescent. When the pane has not moved on
  // (same busy-done tail), delivery must NOT be confirmed — the active spinner
  // could belong to the previous turn, not a fresh injection.
  const result = await observePaneInjection({
    session: "alpha",
    baseline: BUSY_DONE,
    timeoutMs: 500,
    capture: () => BUSY_DONE,
    now: fakeClock(),
    wait: async () => {},
  });
  assert.equal(result.observed, false);
  assert.equal(result.reason, "injection-not-observed");
});

// Local helper mirroring lib/readiness.paneSignature's tail logic so this test
// stays self-contained (we only need it for fixture-sanity assertions above).
function paneSignatureExportStableCheck(text) {
  return String(text)
    .split(/\r?\n/)
    .slice(-12)
    .join("\n")
    .replace(/\s+$/g, "");
}
