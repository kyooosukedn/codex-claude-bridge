// Pure readiness-barrier logic for the V1 control path. No I/O — capture,
// sleep, and the clock are injected, so the barrier is fully testable without
// a live tmux/ccmux session.
//
// Problem this closes: a mode-changing slash command followed immediately by a
// prompt can lose the prompt, because the pane is mid-transition and not yet
// accepting input. Worse, the idle `>` marker lingers in scrollback, so a naive
// "pane contains >" check reports ready on STALE output. awaitReadyState()
// requires the pane tail to CHANGE from a pre-delivery baseline AND then settle
// into a ready state, so a stale capture can never satisfy the barrier.
//
// Imported by bin/codex-claude-bridge.mjs and tests.

import { classifyPane, stripAnsi } from "./pane.mjs";

// A capture is "ready" only when the pane is accepting a fresh prompt input,
// i.e. the empty idle `>` prompt. Other live states (thinking, a slash-opened
// menu, permission prompt) are reported honestly rather than guessed as ready.
const READY_STATES = new Set(["idle"]);

// Pre-injection baseline rule. A mode-changing slash may be injected only when
// the pane is quiescent:
//   - state "idle" (empty `>` prompt + footer, no spinner); OR
//   - state "done" ONLY when the canonical classifier evidence proves an empty
//     active prompt + footer AND there is no spinner/busy signal. A bare done
//     marker is marker-complete, not proof of quiescence (stop hooks can outlive
//     the marker), so done + spinner/busy/queued-message is non-injectable. A
//     stale done marker resting on a clearly idle empty prompt stays usable.
// Thinking / needs_input / permission_prompt / unknown / crashed never qualify.
// Decided from classifyPane result fields/evidence — no ad-hoc text matching.
// See "Pre-injection idle baseline" in RELIABILITY.md.
function baselineInjectableFromClassify(classified) {
  if (classified.state === "idle") return true;
  if (classified.state === "done") {
    const ev = classified.evidence || {};
    const idleProof = ev.footer === true && ev.emptyPrompt === true;
    const busy = ev.spinnerActive === true;
    return idleProof && !busy;
  }
  return false;
}

const DEFAULT_TAIL_LINES = 12;
const DEFAULT_INTERVAL_MS = 1000;

// Stable fingerprint of the bottom of a pane capture. Two captures whose tails
// have not visibly re-rendered produce equal signatures — treat as stale.
// ANSI is stripped and CRLF/LF are normalized so the signature is stable across
// Windows (MSYS) and Linux renders.
export function paneSignature(text, { tailLines = DEFAULT_TAIL_LINES } = {}) {
  const stripped = stripAnsi(String(text ?? ""));
  const lines = stripped.split(/\r?\n/);
  return lines.slice(-tailLines).join("\n").replace(/\s+$/g, "");
}

// Observed ready state for a capture, routed through the canonical classifier
// so readiness stays consistent with inspect/watch. Returns { ready, state, evidence }.
export function readyState(text) {
  const result = classifyPane(text);
  return {
    ready: READY_STATES.has(result.state),
    state: result.state,
    evidence: result.evidence || {},
  };
}

// Poll read() until the pane tail has changed from baseline AND settled into a
// ready state, or until timeoutMs elapses. Injectable for tests.
//
// Returns {
//   ready, state, evidence, waitedMs, attempts, reason, tail
// }
// reason ∈ "fresh-ready" | "timeout-stale" | "timeout-not-ready" | "capture-error"
//   - "fresh-ready": tail changed from baseline and classified ready.
//   - "timeout-stale": timed out before the tail ever changed (stale `>` trap).
//   - "timeout-not-ready": tail changed but never settled into a ready state
//     (e.g. a slash opened a menu). Observed state is surfaced honestly.
//   - "capture-error": a read() threw; barrier aborts without propagating.
export async function awaitReadyState({
  read,
  baseline,
  timeoutMs,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tailLines = DEFAULT_TAIL_LINES,
}) {
  const start = now();
  const baselineSig = paneSignature(baseline, { tailLines });
  let attempts = 0;
  let lastText = "";

  for (;;) {
    attempts += 1;
    let text;
    try {
      text = await read();
    } catch (e) {
      return {
        ready: false,
        state: "unknown",
        evidence: { captureError: e?.message ?? String(e) },
        waitedMs: now() - start,
        attempts,
        reason: "capture-error",
        tail: lastText,
      };
    }
    lastText = text;
    const { ready, state, evidence } = readyState(text);
    const changed = paneSignature(text, { tailLines }) !== baselineSig;
    if (changed && ready) {
      return {
        ready: true,
        state,
        evidence,
        waitedMs: now() - start,
        attempts,
        reason: "fresh-ready",
        tail: text,
      };
    }
    if (now() - start >= timeoutMs) {
      return {
        ready: false,
        state,
        evidence,
        waitedMs: now() - start,
        attempts,
        reason: changed ? "timeout-not-ready" : "timeout-stale",
        tail: text,
      };
    }
    await sleep(intervalMs);
  }
}

// Injectable, classifier-driven pre-injection baseline gate. Polls read() until
// the pane is in a state safe to receive a new mode-changing input (idle, or
// done = quiescent completion marker), or until timeoutMs. Unlike
// awaitReadyState this does NOT require the tail to change from a baseline — it
// answers only "is the pane safe to inject into right now?" Thinking /
// needs_input / permission_prompt / unknown / crashed never qualify, so a slash
// can never be typed into a busy pane. No ad-hoc `>` heuristic: every poll goes
// through the canonical classifyPane via readyState.
//
// Returns {
//   idle, injectable, state, evidence, waitedMs, attempts, reason, tail
// }
// reason ∈ "idle" | "timeout-busy" | "capture-error"
//   - "idle":         an injectable state (idle/done) was reached.
//   - "timeout-busy": the pane stayed non-injectable until the budget elapsed.
//   - "capture-error": a read() threw; the gate aborts without propagating.
export function isBaselineInjectable(text) {
  const classified = readyState(text);
  return {
    injectable: baselineInjectableFromClassify(classified),
    state: classified.state,
    evidence: classified.evidence,
  };
}

export async function awaitIdleBaseline({
  read,
  timeoutMs,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const start = now();
  let attempts = 0;
  let lastText = "";
  let lastState = "unknown";
  let lastEvidence = {};

  for (;;) {
    attempts += 1;
    let text;
    try {
      text = await read();
    } catch (e) {
      return {
        idle: false,
        injectable: false,
        state: lastState,
        evidence: { captureError: e?.message ?? String(e) },
        waitedMs: now() - start,
        attempts,
        reason: "capture-error",
        tail: lastText,
      };
    }
    lastText = text;
    const classified = readyState(text);
    lastState = classified.state;
    lastEvidence = classified.evidence;
    if (baselineInjectableFromClassify(classified)) {
      return {
        idle: true,
        injectable: true,
        state: classified.state,
        evidence: classified.evidence,
        waitedMs: now() - start,
        attempts,
        reason: "idle",
        tail: text,
      };
    }
    if (now() - start >= timeoutMs) {
      return {
        idle: false,
        injectable: false,
        state: classified.state,
        evidence: classified.evidence,
        waitedMs: now() - start,
        attempts,
        reason: "timeout-busy",
        tail: text,
      };
    }
    await sleep(intervalMs);
  }
}
