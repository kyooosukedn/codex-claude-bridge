// Slash-delivery autocomplete confirmation (live-probe-driven fix).
//
// Claude Code v2.1.218 autocomplete: the first Enter after pasting a slash
// command only accepts the autocomplete suggestion, leaving the command staged
// in the active input. A guarded, bounded second Enter is required — but ONLY
// when the bottom active input still contains exactly the submitted command.
// Never double-Enter blindly.

import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmSlashDelivery,
  extractActiveInput,
  normalizeCommand,
} from "../lib/slash-confirm.mjs";
import { executeCoordinatedSlash } from "../bin/codex-claude-bridge.mjs";

// ---------------------------------------------------------------------------
// Pure text helpers — ANSI / NBSP / whitespace normalization.
// ---------------------------------------------------------------------------

test("normalizeCommand strips ANSI, NBSP, and collapses whitespace", () => {
  assert.equal(normalizeCommand("[1m /model default[0m"), "/model default");
  assert.equal(normalizeCommand("  /model   default  "), "/model default");
  assert.equal(normalizeCommand("/model  default"), "/model default");
});

test("extractActiveInput returns bottom prompt content", () => {
  assert.equal(extractActiveInput("scrollback\n> /model default"), "/model default");
  assert.equal(extractActiveInput("> /model default"), "/model default");
});

test("extractActiveInput returns null when there is no input prompt (thinking/idle)", () => {
  assert.equal(extractActiveInput("  ⠋ thinking\n"), null);
  assert.equal(extractActiveInput("done"), null);
});

test("extractActiveInput returns empty string for an empty prompt", () => {
  assert.equal(extractActiveInput("Set model glm-5.2\n> "), "");
});

test("extractActiveInput scans from the bottom, ignoring echoed command above", () => {
  // The command echoed in scrollback; the active (bottom) prompt is empty.
  assert.equal(extractActiveInput("> /model default\nSet model glm-5.2 (default)\n> "), "");
});

// ---------------------------------------------------------------------------
// confirmSlashDelivery — bounded, guarded, at most one confirmation Enter.
// ---------------------------------------------------------------------------

test("autocomplete-staged exact command sends exactly one confirmation Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "> /model default",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
  });
  assert.equal(r.confirmSent, true);
  assert.equal(enters, 1);
  assert.equal(r.reason, "autocomplete-staged");
});

test("command executed on first Enter (idle empty prompt) sends no Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "Set model glm-5.2 (default)\n> ",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
  assert.equal(r.reason, "executed");
});

test("thinking pane (no input prompt) sends no Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "  ⠋ thinking hard",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
});

test("different active input sends no Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "> /model sonnet",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
  assert.equal(r.reason, "different");
});

test("staged command with ANSI + NBSP still matches and confirms once", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "[36m>[0m  /model default",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
  });
  assert.equal(r.confirmSent, true);
  assert.equal(enters, 1);
});

test("delayed staged autocomplete is caught by bounded polling", async () => {
  // A settling autocomplete can render busy (no prompt) for a frame before
  // showing the staged command. Bounded polling must still catch it.
  const sequence = ["  ⠋ thinking", "  ⠋ thinking", "> /model default"];
  let i = 0;
  let enters = 0;
  const sleeps = [];
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => sequence[Math.min(i++, sequence.length - 1)],
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
    settleMs: 0,
    pollAttempts: 3,
    pollIntervalMs: 150,
  });
  assert.equal(r.confirmSent, true);
  assert.equal(enters, 1);
  assert.equal(r.attempts, 3);
  assert.equal(r.reason, "autocomplete-staged");
  // Two thinking polls paced by pollIntervalMs before the staged capture; never
  // a blind or double Enter.
  assert.deepEqual(sleeps, [150, 150]);
});

test("thinking pane polls up to the budget then gives up without Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "  ⠋ thinking",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
    pollAttempts: 3,
    pollIntervalMs: 150,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
  assert.equal(r.attempts, 3);
  assert.equal(r.reason, "thinking");
});

test("executed stops early at attempt 1 without Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "Set model glm-5.2 (default)\n> ",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
    pollAttempts: 3,
    pollIntervalMs: 150,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
  assert.equal(r.attempts, 1);
  assert.equal(r.reason, "executed");
});

test("different active input stops early at attempt 1 without Enter", async () => {
  let enters = 0;
  const r = await confirmSlashDelivery({
    text: "/model default",
    capture: async () => "> /model sonnet",
    sendEnter: async () => { enters += 1; },
    now: () => 0,
    sleep: async () => {},
    settleMs: 0,
    pollAttempts: 3,
    pollIntervalMs: 150,
  });
  assert.equal(r.confirmSent, false);
  assert.equal(enters, 0);
  assert.equal(r.attempts, 1);
  assert.equal(r.reason, "different");
});

// ---------------------------------------------------------------------------
// executeCoordinatedSlash integration — confirmation wired into the slash path.
// ---------------------------------------------------------------------------

async function passthroughCoordinator({ captureBaseline, inject }) {
  const baseline = await captureBaseline();
  const payload = await inject({ baseline });
  return {
    ack: "injected",
    payload,
    commandId: payload.commandId,
    commandClass: "mode-changing",
    attempts: 1,
    states: ["queued", "injecting", "acknowledged", "released"],
  };
}

// A pane the classifier reads as idle (empty `>` prompt + footer), used as the
// pre-injection baseline. The production slash path now refuses to inject until
// the pane reaches this state, so integration tests must serve an idle baseline
// on the first capture and the post-injection pane on later captures.
const IDLE_PANE = [
  "● bridge package works",
  "",
  "✻ Baked for 28s",
  "",
  "─────────────────────────────────────────────────────────────────── x ──",
  ">",
  "────────────────────────────────────────────────────────────────────────────────",
  "  glm-5.2 │ work ░░░░░░░░░░ 6%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
].join("\n");

// First capture returns the idle baseline (passes the pre-injection gate);
// every later capture returns postPane (what the confirmation step observes).
function slashDeps({ postPane, barrierReady = true, stagedEnters = [] }) {
  let calls = 0;
  return {
    coordinateInjection: passthroughCoordinator,
    capture: async () => {
      calls += 1;
      return calls === 1 ? IDLE_PANE : postPane;
    },
    enterText: (session, t) => ({ session, entered: true, bytes: t.length }),
    sendEnter: (session) => { stagedEnters.push(session); return { session }; },
    modeReadyBarrier: async () => ({
      ready: barrierReady,
      state: barrierReady ? "idle" : "unknown",
      reason: barrierReady ? "fresh-ready" : "timeout-not-ready",
      waitedMs: 1,
      attempts: 1,
      evidence: {},
    }),
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    sleep: async () => {},
  };
}

test("slash path: autocomplete-staged -> one confirmation Enter, exit 0", async () => {
  const enters = [];
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: {},
    deps: slashDeps({ postPane: "> /model default", stagedEnters: enters }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(enters.length, 1);
  assert.equal(result.body.readiness.confirmation.confirmSent, true);
});

test("slash path: command executes on first Enter -> zero confirmation, exit 0", async () => {
  const enters = [];
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: {},
    deps: slashDeps({
      postPane: "Set model glm-5.2 (default)\n> ",
      stagedEnters: enters,
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(enters.length, 0);
  assert.equal(result.body.readiness.confirmation.confirmSent, false);
});

test("slash path: different active input -> zero confirmation", async () => {
  const enters = [];
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: {},
    deps: slashDeps({ postPane: "> /model sonnet", stagedEnters: enters }),
  });
  assert.equal(enters.length, 0);
  assert.equal(result.body.readiness.confirmation.confirmSent, false);
});

test("slash path: confirmation sent but barrier not ready -> exit 6", async () => {
  const enters = [];
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: {},
    deps: slashDeps({
      postPane: "> /model default",
      barrierReady: false,
      stagedEnters: enters,
    }),
  });
  assert.equal(enters.length, 1);
  assert.equal(result.exitCode, 6);
  assert.equal(result.body.readiness.ready, false);
  assert.equal(result.body.readiness.confirmation.confirmSent, true);
});

test("slash path: no-wait skips confirmation (conservative)", async () => {
  const enters = [];
  const result = await executeCoordinatedSlash({
    session: "x",
    text: "/model default",
    opts: { "no-wait": true },
    deps: slashDeps({ postPane: "> /model default", stagedEnters: enters }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(enters.length, 0);
  assert.equal(result.body.readiness.waited, false);
});
