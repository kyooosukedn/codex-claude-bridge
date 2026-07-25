// Deterministic readiness-barrier tests for the V1 control path.
//
// Reproduces the P1 weakness — a prompt sent immediately after a
// mode-changing slash command is lost because the pane is mid-transition
// and not actually accepting input, yet the idle `>` marker lingers in
// scrollback so a naive "pane contains >" check reports ready on STALE
// output. These tests drive the barrier with scripted capture sequences
// and a fake clock — no live tmux/ccmux required. Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paneSignature,
  readyState,
  awaitReadyState,
} from "../lib/readiness.mjs";

// ---- scripted pane fixtures ------------------------------------------------

// Realistic idle pane. `tick` deliberately varies a tail line so two captures
// with different ticks have different signatures (the pane re-rendered);
// equal ticks mean the tail is unchanged (stale).
function idlePane({ tick = 1, eol = "\n" } = {}) {
  const L = [
    "",
    "  ⎿  SessionStart:startup says: ready",
    "",
    "● slash acknowledged",
    "",
    `✳ Baked for ${tick}s`,
    "",
    "── ccb-smoke ──",
    ">",
    "────",
    `  glm-5.2 │ work ░░░░░░░░░ ${tick}%`,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
  return L.join(eol);
}

// Thinking pane: active spinner footer means "not accepting a new prompt".
function thinkingPane({ tick = 1, eol = "\n" } = {}) {
  const L = [
    "",
    `✢ Running checks and smoke… (1${tick}m 0s · ↓ 3${tick}.0k tokens)`,
    "── ccb-smoke ──",
    ">",
    "────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
  return L.join(eol);
}

// A mode-changing slash (e.g. /model) can land in an input menu. That is NOT
// "ready for a fresh prompt" — the bridge must report the state honestly.
function menuPane({ eol = "\n" } = {}) {
  const L = [
    "",
    "? Which model?",
    "",
    "  ❯ 1. glm-5.2",
    "    2. claude-sonnet-5",
    "── ccb-smoke ──",
    ">",
    "────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
  return L.join(eol);
}

// Returns an async read() that yields captures in order, then throws if the
// barrier over-polls (keeps tests bounded and surfaces infinite loops).
function scriptedRead(panes) {
  let i = 0;
  return async () => {
    if (i >= panes.length) {
      throw new Error(`scriptedRead exhausted after ${panes.length} captures`);
    }
    return panes[i++];
  };
}

// Deterministic clock: only sleep() advances time, so waitedMs is predictable.
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

// ---- the reproduction: naive readiness is fooled by stale `>` ------------

test("repro: naive `includes('>')` reports ready on stale post-slash pane (the bug)", () => {
  const baseline = idlePane({ tick: 1 });
  // Pane has not re-rendered since the slash — `>` is stale scrollback.
  const stalePostSlash = idlePane({ tick: 1 });
  assert.equal(baseline, stalePostSlash, "fixture sanity: same capture");
  // The old waitReady() heuristic would return ready here — that is the bug.
  const naiveReady = stalePostSlash.includes(">");
  assert.equal(naiveReady, true, "naive check is fooled by stale >");
});

test("repro: awaitReadyState does NOT report ready while pane tail is unchanged (stale >)", async () => {
  const baseline = idlePane({ tick: 1 });
  const clock = fakeClock();
  // First poll returns a byte-identical capture — pane has not re-rendered.
  const read = scriptedRead([idlePane({ tick: 1 }), idlePane({ tick: 2 })]);
  const r = await awaitReadyState({
    read,
    baseline,
    timeoutMs: 5000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(r.ready, true, "eventually ready once the pane re-renders");
  assert.equal(r.reason, "fresh-ready");
  assert.ok(
    r.attempts >= 2,
    `must poll at least twice (skip stale first poll), got ${r.attempts}`,
  );
});

// ---- stale-output defeat ---------------------------------------------------

test("stale output: pane never changes -> timeout, not ready, reason timeout-stale", async () => {
  const baseline = idlePane({ tick: 7 });
  const clock = fakeClock();
  // Generator that always returns the same stale capture.
  let calls = 0;
  const read = async () => {
    calls++;
    return idlePane({ tick: 7 });
  };
  const r = await awaitReadyState({
    read,
    baseline,
    timeoutMs: 2500,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "timeout-stale");
  assert.ok(r.attempts >= 1);
  assert.ok(calls >= 1);
});

// ---- delayed TUI readiness, parametrized per platform ---------------------

for (const eol of ["\n", "\r\n"]) {
  const platform = eol === "\r\n" ? "windows" : "linux";

  test(`delayed TUI readiness (${platform}): unchanged x2 then fresh idle -> ready in 3 attempts`, async () => {
    const baseline = idlePane({ tick: 1, eol });
    const clock = fakeClock();
    const read = scriptedRead([
      idlePane({ tick: 1, eol }), // stale: pane not re-rendered yet
      idlePane({ tick: 1, eol }), // still stale (delayed TUI)
      idlePane({ tick: 2, eol }), // fresh re-render -> idle
    ]);
    const r = await awaitReadyState({
      read,
      baseline,
      timeoutMs: 30000,
      intervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(r.ready, true);
    assert.equal(r.reason, "fresh-ready");
    assert.equal(r.state, "idle");
    assert.equal(r.attempts, 3);
  });

  test(`delayed TUI readiness (${platform}): changed-but-thinking -> poll -> fresh idle`, async () => {
    const baseline = idlePane({ tick: 1, eol });
    const clock = fakeClock();
    const read = scriptedRead([
      thinkingPane({ tick: 2, eol }), // re-rendered, but busy
      idlePane({ tick: 3, eol }), // settled -> idle
    ]);
    const r = await awaitReadyState({
      read,
      baseline,
      timeoutMs: 30000,
      intervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(r.ready, true);
    assert.equal(r.attempts, 2);
  });
}

// ---- honest state reporting -----------------------------------------------

test("does not infer success: slash that lands in a menu reports needs_input, not ready", async () => {
  const baseline = idlePane({ tick: 1 });
  const clock = fakeClock();
  const read = async () => menuPane(); // persistent menu, never idle
  const r = await awaitReadyState({
    read,
    baseline,
    timeoutMs: 1500,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "timeout-not-ready");
  assert.equal(r.state, "needs_input", "observed state surfaced, not guessed");
});

test("capture error: reports ready=false with reason capture-error and no throw", async () => {
  const baseline = idlePane({ tick: 1 });
  const clock = fakeClock();
  const read = async () => {
    throw new Error("ccmux capture blew up");
  };
  const r = await awaitReadyState({
    read,
    baseline,
    timeoutMs: 5000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "capture-error");
  assert.equal(r.state, "unknown");
  assert.match(r.evidence.captureError, /ccmux capture blew up/);
});

// ---- pure helper contracts ------------------------------------------------

test("readyState: idle -> ready; thinking/needs_input -> not ready (honest)", () => {
  assert.deepEqual(readyState(idlePane({ tick: 1 })), {
    ready: true,
    state: "idle",
    evidence: readyState(idlePane({ tick: 1 })).evidence,
  });
  const th = readyState(thinkingPane({ tick: 2 }));
  assert.equal(th.ready, false);
  assert.equal(th.state, "thinking");
  const menu = readyState(menuPane());
  assert.equal(menu.ready, false);
  assert.equal(menu.state, "needs_input");
});

test("paneSignature: identical tails match; differing tick differs; ANSI-tolerant; CRLF==LF", () => {
  const a = idlePane({ tick: 1 });
  const b = idlePane({ tick: 1 });
  assert.equal(paneSignature(a), paneSignature(b), "same capture -> same sig");
  assert.notEqual(
    paneSignature(idlePane({ tick: 1 })),
    paneSignature(idlePane({ tick: 2 })),
    "re-rendered tail -> different sig",
  );
  const ansi = "\x1B[38;5;211m" + idlePane({ tick: 1 }) + "\x1B[0m";
  assert.equal(
    paneSignature(ansi),
    paneSignature(idlePane({ tick: 1 })),
    "ANSI must not perturb the signature",
  );
  assert.equal(
    paneSignature(idlePane({ tick: 1, eol: "\r\n" })),
    paneSignature(idlePane({ tick: 1, eol: "\n" })),
    "CRLF vs LF tails must produce the same signature",
  );
});
