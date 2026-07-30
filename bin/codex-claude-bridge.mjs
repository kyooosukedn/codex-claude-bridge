#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyPane,
  selectOption,
  stripAnsi as stripAnsiLib,
} from "../lib/pane.mjs";
import { buildSteerPayload, countLines } from "../lib/steer.mjs";
import {
  awaitIdleBaseline,
  awaitReadyState,
  isBaselineInjectable,
  paneSignature,
} from "../lib/readiness.mjs";
import { coordinateInjection } from "../lib/session-coordinator.mjs";
import { createTransport } from "../lib/transport.mjs";
import { createCommandJournal } from "../lib/command-journal.mjs";
import { confirmSlashDelivery } from "../lib/slash-confirm.mjs";

const DEFAULT_SESSION = "codex-claude";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_STARTUP_WAIT_MS = 12000;
const DEFAULT_READY_TIMEOUT_MS = 45000;
const DEFAULT_INSPECT_LINES = 120;
const DEFAULT_WATCH_INTERVAL_MS = 1500;
const DEFAULT_WATCH_TIMEOUT_MS = 600000;
// Readiness barrier after mode-changing inputs (slash). Bounds how long
// `ccb slash` waits for the pane to re-render into a fresh idle state before
// returning. See lib/readiness.mjs and docs/RELIABILITY.md.
const DEFAULT_MODE_READY_TIMEOUT_MS = 30000;
const DEFAULT_MODE_READY_INTERVAL_MS = 1000;
// `ccb slash` exit codes (readiness outcomes). Kept distinct from generic 1
// (uncaught error) and 2 (usage) so callers and CI can branch on delivery
// semantics. See docs/RELIABILITY.md "Readiness barrier after slash commands".
//   6 = delivered, but the barrier did NOT confirm a ready pane.
//   7 = waited mode: baseline capture failed, so NOTHING was delivered.
const SLASH_NOT_READY_EXIT = 6;
const SLASH_BASELINE_FAILED_EXIT = 7;
const MSYS_BIN = "C:\\msys64\\usr\\bin";
const BOOLEAN_FLAGS = new Set([
  "enter",
  "json",
  "no-wait",
  "remote-control",
  "safe-permissions",
]);

function stripAnsi(text) {
  return stripAnsiLib(text);
}

function dieUsage(message) {
  console.error(`ccb: ${message}`);
  process.exit(2);
}

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || raw === "" || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    dieUsage(
      `--${name} must be a positive integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function printHelp() {
  console.log(`codex-claude-bridge

Usage:
  ccb doctor [--json]
  ccb patch-ccmux-windows

  ccb start [--session NAME] [--cwd DIR] [--model MODEL] [--effort LEVEL] [--safe-permissions]
  ccb send [--session NAME] [--cwd DIR] [--timeout-ms MS] [--startup-wait-ms MS] "prompt"
  ccb type [--session NAME] [--enter] "raw message"
  ccb slash [--session NAME] [--idle-timeout-ms MS] [--ready-timeout-ms MS] [--no-wait] "command"
  ccb steer [--session NAME] "message"
  ccb commands [--session NAME] [--json]
  ccb command-status ID [--json]

  ccb inspect [--session NAME] [--lines N] [--json]
    Classify the live Claude Code pane state.
    States: idle | thinking | needs_input | permission_prompt | done | crashed | unknown

  ccb approve [--session NAME] [--lines N] [--json]
  ccb deny   [--session NAME] [--lines N] [--json]
    Inspect first; pick the semantically correct option (yes/allow/proceed or no/deny/cancel).
    Refuses with nonzero exit when there is no permission/input prompt.
    Falls back to y/n when the prompt has no numbered options.

  ccb watch [--session NAME] [--interval-ms MS] [--lines N] [--json] [--timeout-ms MS]
    Poll the pane and emit only state transitions (JSON Lines when --json).
    Stops on done/crashed, timeout, or Ctrl+C.

  ccb key [--session NAME] KEY [KEY...]
  ccb choose [--session NAME] NUMBER
  ccb enter [--session NAME]
  ccb escape [--session NAME]
  ccb interrupt [--session NAME]

  ccb capture [--session NAME] [--lines N]
  ccb wait-ready [--session NAME] [--timeout-ms MS]
  ccb status
  ccb sessions
  ccb jobs
  ccb attach [--session NAME]
  ccb kill [--session NAME]

Defaults:
  session: ${DEFAULT_SESSION}
  cwd: current directory
  inspect lines: ${DEFAULT_INSPECT_LINES}
  watch interval: ${DEFAULT_WATCH_INTERVAL_MS}ms, timeout: ${DEFAULT_WATCH_TIMEOUT_MS}ms

Notes:
  - inspect and watch only read the pane; safe to run against a live session.
  - approve/deny/choose send keystrokes; they can mutate the target session.
  - Use \`ccb choose N\` as a raw escape hatch when approve/deny cannot resolve an option.
`);
}

function parse(argv) {
  const args = [...argv];
  let command = args.shift() || "help";
  if (command === "-h" || command === "--help") command = "help";

  const opts = { _: [] };
  while (args.length) {
    const item = args.shift();
    if (!item.startsWith("--")) {
      opts._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (BOOLEAN_FLAGS.has(key) || !args.length || args[0].startsWith("--")) opts[key] = true;
    else opts[key] = args.shift();
  }
  return { command, opts };
}

function envWithTmux() {
  const env = { ...process.env };
  if (process.platform === "win32" && existsSync(path.join(MSYS_BIN, "tmux.exe"))) {
    const currentPath = String(env.Path || env.PATH || "");
    const parts = currentPath.split(";");
    if (!parts.some((p) => p.toLowerCase() === MSYS_BIN.toLowerCase())) {
      env.Path = `${MSYS_BIN};${currentPath}`;
    }
  }
  return env;
}

const transport = createTransport({ env: envWithTmux() });
const commandJournal = createCommandJournal();

function run(command, args = [], options = {}) {
  return transport.run(command, args, options);
}

function must(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const msg = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(msg || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout || "";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandOk(command, args = ["--version"]) {
  try {
    const result = run(command, args);
    return {
      ok: result.status === 0,
      command,
      output: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "",
    };
  } catch (error) {
    return { ok: false, command, output: error.message };
  }
}

function safeName(value) {
  const cleaned = String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "default";
}

function tmuxSessionName(session) {
  return `ccmux-${safeName(session)}`;
}

function msysPathForShell(value) {
  const text = String(value);
  const match = text.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) return text;
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function ccmuxStatus() {
  return JSON.parse(must("ccmux", ["status"]));
}

function sessionInfo(name) {
  const status = ccmuxStatus();
  return status.sessions?.find((s) => s.name === name) || null;
}

function sessionAlive(name) {
  try {
    return Boolean(sessionInfo(name)?.alive);
  } catch {
    return false;
  }
}

function startSession({ session, cwd, opts }) {
  const args = ["start", "--name", session, "--cwd", cwd, "--no-agents-md"];
  if (opts.model) args.push("--model", String(opts.model));
  if (opts.effort) args.push("--effort", String(opts.effort));
  if (opts["remote-control"]) args.push("--remote-control");
  if (opts["safe-permissions"]) args.push("--safe-permissions");
  return must("ccmux", args);
}

function ensureSession({ session, cwd, opts, startupWaitMs }) {
  if (!sessionAlive(session)) {
    startSession({ session, cwd, opts });
    sleep(startupWaitMs);
  }
}

function captureSession(session, lines = 120) {
  return must("ccmux", ["capture", "--session", session, "--lines", String(lines)]);
}

function waitReady(session, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = captureSession(session, 80);
    const clean = stripAnsi(last);
    if (
      clean.includes(">") ||
      clean.includes("Press up edit queued messages") ||
      clean.includes("bypass permissions on")
    ) {
      return { ready: true, session, waitedMs: Date.now() - start };
    }
    sleep(1000);
  }
  return { ready: false, session, waitedMs: Date.now() - start, tail: last };
}

// Drives the pure awaitReadyState barrier against a live session. Used by
// `ccb slash` to confirm the pane has re-rendered into a fresh idle state after
// a mode-changing input, defeating the stale `>` false-positive. A capture that
// throws is caught inside awaitReadyState (reason "capture-error"), so a dying
// session surfaces as readiness=false rather than crashing the command.
async function modeReadyBarrier(session, baseline, timeoutMs, intervalMs) {
  return awaitReadyState({
    read: async () => captureSession(session, 80),
    baseline,
    timeoutMs,
    intervalMs,
  });
}

// Real subprocess deps for executeSlash. `captureBaseline` is intentionally the
// THROWING captureSession (not a swallowing wrapper): in waited mode a failed
// baseline must fail closed BEFORE delivery, so the caller never injects into a
// pane it cannot reason about. Tests inject fakes (see test/slash-handler.test.mjs).
function defaultSlashDeps() {
  return {
    captureBaseline: (session) => captureSession(session, 80),
    enterText,
    modeReadyBarrier,
    now: () => Date.now(),
  };
}

// Orchestration for `ccb slash`. Pure with respect to the injected deps; returns
// { body, exitCode } so main() can always print telemetry and then branch on the
// exit code. Behaviors (see docs/RELIABILITY.md):
//   - injectedAt is set ONLY after enterText succeeds (truthful telemetry).
//   - Waited mode acquires the baseline FAIL-CLOSED: a capture failure aborts
//     before delivery (no enterText) -> exit SLASH_BASELINE_FAILED_EXIT (7).
//   - A waited barrier that does not confirm ready -> exit SLASH_NOT_READY_EXIT
//     (6); telemetry is still emitted. Only ready:true or --no-wait may exit 0.
//   - --no-wait skips baseline and barrier entirely (no capture before delivery).
export async function executeSlash({ session, text, opts, deps = defaultSlashDeps() }) {
  const now = deps.now || (() => Date.now());
  const commandId = randomUUID();
  const noWait = opts["no-wait"] === true;

  if (noWait) {
    const delivered = deps.enterText(session, text, true);
    return {
      body: {
        ...delivered,
        command: text,
        commandId,
        injectedAt: new Date(now()).toISOString(),
        readiness: { waited: false, ready: null, reason: "skipped" },
      },
      exitCode: 0,
    };
  }

  // Validate BEFORE any side effect so a bad --ready-timeout-ms does not deliver.
  const readyTimeoutMs = parsePositiveInt(
    opts["ready-timeout-ms"],
    DEFAULT_MODE_READY_TIMEOUT_MS,
    "ready-timeout-ms",
  );

  // Fail-closed baseline: capture must succeed before we inject anything,
  // otherwise the barrier would run without stale-protection on the first poll.
  let baseline;
  try {
    baseline = await deps.captureBaseline(session);
  } catch (e) {
    return {
      body: {
        session,
        command: text,
        commandId,
        readiness: {
          waited: true,
          ready: false,
          state: "unknown",
          reason: "baseline-capture-failed",
          evidence: { captureError: e?.message ?? String(e) },
        },
      },
      exitCode: SLASH_BASELINE_FAILED_EXIT,
    };
  }

  const delivered = deps.enterText(session, text, true);
  const injectedAt = new Date(now()).toISOString();

  const barrier = await deps.modeReadyBarrier(
    session,
    baseline,
    readyTimeoutMs,
    DEFAULT_MODE_READY_INTERVAL_MS,
  );
  const readiness = {
    waited: true,
    ready: barrier.ready,
    state: barrier.state,
    readyAt: barrier.ready ? new Date(now()).toISOString() : null,
    waitedMs: barrier.waitedMs,
    attempts: barrier.attempts,
    reason: barrier.reason,
    evidence: barrier.evidence,
  };
  return {
    body: { ...delivered, command: text, commandId, injectedAt, readiness },
    exitCode: barrier.ready ? 0 : SLASH_NOT_READY_EXIT,
  };
}

function parseCcmuxJob(stdout, session) {
  let job;
  try {
    job = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("ccmux send returned malformed JSON");
  }
  if (
    !job ||
    typeof job.id !== "string" ||
    !job.id ||
    job.session !== session ||
    job.status !== "sent" ||
    Number.isNaN(Date.parse(job.sentAt))
  ) {
    throw new Error("ccmux send returned invalid job acknowledgment");
  }
  return job;
}

function parseCcmuxTerminal(stdout, jobId, session) {
  let terminal;
  try {
    terminal = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("ccmux wait returned malformed JSON");
  }
  if (
    !terminal ||
    terminal.id !== jobId ||
    terminal.session !== session ||
    !["sent", "done", "timeout"].includes(terminal.status)
  ) {
    throw new Error("ccmux wait returned invalid terminal state");
  }
  return terminal;
}

// Active processing states that prove a submitted prompt was accepted and is
// being worked on. Used by observePaneInjection as a delivery signal. The pane
// classifier finds the spinner within a 40-line window (SPINNER_SCAN_LINES),
// but the tail signature only sees the bottom 12 lines — so a long/wrapped
// prompt, whose spinner sits above a static footer, can leave the tail
// byte-identical to the idle baseline and defeat the signature check. Watching
// for a transition into one of these states closes that gap.
const INJECTION_OBSERVED_STATES = new Set([
  "thinking",
  "needs_input",
  "permission_prompt",
]);

// Confirms a prompt reached the pane by watching for a re-render of the tail OR
// a transition from a quiescent baseline into an active processing state.
//
// The tail check alone is a FALSE NEGATIVE on long/wrapped prompts: the
// submitted text and its spinner render ABOVE the static footer that anchors the
// bottom 12 lines, so paneSignature() stays equal to the idle baseline even
// though the pane is clearly "thinking" (the manual `inspect` proof for
// CCB100J30B-027). The state-transition path uses exactly that evidence.
//
// At-most-once is preserved: the transition signal is gated on a QUIESCENT
// (idle) baseline, so a stale or already-busy pane can never confirm delivery
// this way — only a genuine idle→active transition counts, never arbitrary pane
// change. The signature path is unchanged, and an unobserved injection is still
// ack="uncertain", safeToRetry=false: only the observed/uncertain boundary
// moves, never the retry policy.
export async function observePaneInjection({
  session,
  baseline,
  timeoutMs = 5000,
  intervalMs = 100,
  capture = captureSession,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const start = now();
  const baselineSig = paneSignature(baseline);
  // Reuse the canonical pre-injection quiescent rule (idle, or a done marker
  // resting on a truly idle empty prompt + footer with no spinner) so a
  // quiescent done baseline can also use the idle→active delivery proof.
  const baselineQuiescent = isBaselineInjectable(baseline).injectable;
  do {
    const pane = capture(session, 80);
    const state = classifyPane(pane).state;
    if (paneSignature(pane) !== baselineSig) {
      return { observed: true, reason: state === "thinking" ? "thinking" : "pane-changed", state };
    }
    // Wrapped/long prompts can keep the bottom 12 lines byte-identical to an
    // idle baseline while the spinner (delivery proof) renders higher in the
    // pane, within the classifier's 40-line scan window. A transition from a
    // quiescent baseline into an active state is direct, specific evidence the
    // injection landed — not arbitrary change.
    if (baselineQuiescent && INJECTION_OBSERVED_STATES.has(state)) {
      return {
        observed: true,
        reason: state === "thinking" ? "thinking" : "state-transition",
        state,
      };
    }
    if (now() - start >= timeoutMs) break;
    await wait(intervalMs);
  } while (true);
  return { observed: false, reason: "injection-not-observed" };
}

function defaultCommandDeps() {
  return {
    coordinateInjection,
    capture: (session) => captureSession(session, 80),
    send: (session, prompt) => must("ccmux", ["send", "--session", session, prompt]),
    waitJob: (jobId, timeoutMs, settleMs) =>
      must("ccmux", [
        "wait",
        jobId,
        "--timeout-ms",
        String(timeoutMs),
        "--settle-ms",
        String(settleMs),
      ]),
    observe: observePaneInjection,
    enterText,
    sendEnter: (session) => key(session, ["Enter"]),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    steerMessage,
    modeReadyBarrier,
    now: () => new Date(),
    journal: commandJournal,
  };
}

function coordinatorFailureExit(ack) {
  if (ack === "busy") return 8;
  if (ack === "not-injected") return SLASH_BASELINE_FAILED_EXIT;
  return 9;
}

export async function executeSend({
  session,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  settleMs = 3000,
  deps = defaultCommandDeps(),
}) {
  const commandId = randomUUID();
  const coordinated = await deps.coordinateInjection({
    session,
    commandId,
    commandClass: "prompt",
    pid: process.pid,
    maxPreWriteAttempts: 1,
    now: deps.now,
    captureBaseline: () => deps.capture(session),
    inject: () => parseCcmuxJob(deps.send(session, prompt), session),
    observeInjection: ({ baseline, payload }) =>
      deps.observe({ session, baseline, payload }),
    journal: deps.journal,
  });

  if (coordinated.ack !== "injected") {
    return { body: coordinated, exitCode: coordinatorFailureExit(coordinated.ack) };
  }

  let terminal;
  try {
    terminal = parseCcmuxTerminal(
      deps.waitJob(coordinated.payload.id, timeoutMs, settleMs),
      coordinated.payload.id,
      session,
    );
  } catch (error) {
    return {
      body: {
        terminal: {
          status: "unknown",
          reason: "wait-error",
          error: error.message,
        },
        coordinator: coordinated,
      },
      exitCode: 9,
    };
  }
  return {
    body: { ...terminal, coordinator: coordinated },
    exitCode: terminal?.status === "timeout" ? 5 : 0,
  };
}

export async function executeCoordinatedSlash({
  session,
  text,
  opts,
  deps = defaultCommandDeps(),
}) {
  const commandId = randomUUID();
  const noWait = opts["no-wait"] === true;
  const readyTimeoutMs = noWait
    ? 0
    : parsePositiveInt(
        opts["ready-timeout-ms"],
        DEFAULT_MODE_READY_TIMEOUT_MS,
        "ready-timeout-ms",
      );
  // Pre-injection idle baseline budget. Defaults to the post-injection barrier
  // budget so long stop hooks (which keep the pane "thinking" past ccmux's
  // terminal "done") are tolerated with one knob. Live stress passes this from
  // --ready-timeout-ms via the harness; isolation inherits the same config.
  const idleTimeoutMs = noWait
    ? 0
    : parsePositiveInt(
        opts["idle-timeout-ms"],
        readyTimeoutMs,
        "idle-timeout-ms",
      );

  // Closure-local record of the last pre-injection baseline gate result. The
  // gate runs INSIDE captureBaseline (under the per-session lock), so when the
  // coordinator returns "not-injected" we can distinguish "pane stayed busy"
  // (baseline-not-idle) from "ccmux capture itself failed"
  // (baseline-capture-failed) without changing coordinator return semantics.
  let baselineGate = null;
  const coordinated = await deps.coordinateInjection({
    session,
    commandId,
    commandClass: "mode-changing",
    pid: process.pid,
    maxPreWriteAttempts: 1,
    now: deps.now,
    captureBaseline: async () => {
      if (noWait) return "";
      // Confirmed-injectable baseline before any transport write. A mode-
      // changing slash must never be typed into a thinking / needs_input /
      // permission / unknown pane. The poll happens under the lock so two
      // same-session slashes still serialize. On timeout we throw, which the
      // coordinator treats as a pre-write baseline failure: no enterText, lock
      // released, journal records not-injected, safeToRetry true.
      const gate = await awaitIdleBaseline({
        read: () => deps.capture(session),
        timeoutMs: idleTimeoutMs,
        intervalMs: DEFAULT_MODE_READY_INTERVAL_MS,
        now: deps.now,
        sleep: deps.sleep,
      });
      baselineGate = gate;
      if (!gate.idle) {
        const err = new Error(
          `pre-injection idle baseline not reached (reason=${gate.reason}, state=${gate.state})`,
        );
        err.ccbBaselineNotIdle = true;
        throw err;
      }
      return gate.tail;
    },
    inject: async ({ baseline }) => {
      const delivered = deps.enterText(session, text, true);
      const injectedAt = deps.now().toISOString();
      if (noWait) {
        return {
          ...delivered,
          command: text,
          commandId,
          injectedAt,
          readiness: {
            waited: false,
            ready: null,
            reason: "skipped",
            // Conservative: never send a confirmation Enter without observing
            // the pane. no-wait callers opt out of delivery confirmation.
            confirmation: { confirmSent: false, reason: "no-wait", attempts: 0 },
          },
          exitCode: 0,
        };
      }
      // Bounded, guarded confirmation for Claude Code slash autocomplete: the
      // first Enter after pasting a slash only accepts the suggestion, leaving
      // the command staged. Send ONE additional Enter ONLY when the bottom
      // active input still contains exactly the submitted command. Never
      // double-Enter blindly. Skipped when sendEnter is unavailable so the
      // baseline lock/journal/readiness semantics are preserved unchanged.
      const useConfirm = typeof deps.sendEnter === "function";
      const confirmation = useConfirm
        ? await confirmSlashDelivery({
            text,
            capture: () => deps.capture(session),
            sendEnter: () => deps.sendEnter(session),
            now: deps.now,
            sleep: deps.sleep,
          })
        : { confirmSent: false, reason: "sendEnter-unavailable", attempts: 0 };
      const barrier = await deps.modeReadyBarrier(
        session,
        baseline,
        readyTimeoutMs,
        DEFAULT_MODE_READY_INTERVAL_MS,
      );
      return {
        ...delivered,
        command: text,
        commandId,
        injectedAt,
        readiness: {
          waited: true,
          ready: barrier.ready,
          state: barrier.state,
          readyAt: barrier.ready ? deps.now().toISOString() : null,
          reason: barrier.reason,
          waitedMs: barrier.waitedMs,
          attempts: barrier.attempts,
          evidence: barrier.evidence,
          confirmation,
        },
        exitCode: barrier.ready ? 0 : SLASH_NOT_READY_EXIT,
      };
    },
    observeInjection: ({ payload }) => ({
      observed: true,
      reason: payload.readiness?.reason || "transport-returned",
    }),
    journal: deps.journal,
  });
  if (coordinated.ack !== "injected") {
    if (coordinated.ack === "not-injected") {
      // Pre-injection idle timeout: the pane never reached an injectable state.
      // No enterText was issued. Distinguish from a raw capture failure so
      // reports can tell "busy pane" apart from "ccmux capture broken".
      if (baselineGate && !baselineGate.idle) {
        return {
          body: {
            command: text,
            commandId,
            preInjection: baselineGate,
            readiness: {
              waited: true,
              ready: false,
              state: baselineGate.state,
              phase: "pre-injection",
              reason:
                baselineGate.reason === "capture-error"
                  ? "baseline-capture-failed"
                  : "baseline-not-idle",
              waitedMs: baselineGate.waitedMs,
              attempts: baselineGate.attempts,
              evidence: baselineGate.evidence,
            },
            coordinator: coordinated,
          },
          exitCode: SLASH_BASELINE_FAILED_EXIT,
        };
      }
      return {
        body: {
          command: text,
          commandId,
          readiness: {
            waited: true,
            ready: false,
            phase: "pre-injection",
            reason: "baseline-capture-failed",
            evidence: { captureError: coordinated.error },
          },
          coordinator: coordinated,
        },
        exitCode: SLASH_BASELINE_FAILED_EXIT,
      };
    }
    return {
      body: coordinated,
      exitCode: coordinatorFailureExit(coordinated.ack),
    };
  }
  return {
    body: { ...coordinated.payload, coordinator: coordinated },
    exitCode: coordinated.payload.exitCode,
  };
}

export async function executeSteer({
  session,
  message,
  deps = defaultCommandDeps(),
}) {
  const coordinated = await deps.coordinateInjection({
    session,
    commandId: randomUUID(),
    commandClass: "steer",
    pid: process.pid,
    maxPreWriteAttempts: 1,
    now: deps.now,
    captureBaseline: () => deps.capture(session),
    inject: () => deps.steerMessage(session, message),
    observeInjection: () => ({ observed: true, reason: "transport-returned" }),
    journal: deps.journal,
  });
  return {
    body: coordinated,
    exitCode:
      coordinated.ack === "injected"
        ? 0
        : coordinatorFailureExit(coordinated.ack),
  };
}

export async function executeType({
  session,
  text,
  enter = false,
  deps = defaultCommandDeps(),
}) {
  const coordinated = await deps.coordinateInjection({
    session,
    commandId: randomUUID(),
    commandClass: "raw-input",
    pid: process.pid,
    maxPreWriteAttempts: 1,
    now: deps.now,
    captureBaseline: () => deps.capture(session),
    inject: () => deps.enterText(session, text, enter),
    observeInjection: () => ({ observed: true, reason: "transport-returned" }),
    journal: deps.journal,
  });
  return {
    body: coordinated,
    exitCode:
      coordinated.ack === "injected"
        ? 0
        : coordinatorFailureExit(coordinated.ack),
  };
}

function inspectSession(session, lines, json) {
  const raw = captureSession(session, lines);
  const result = classifyPane(raw, {
    tailLines: Math.min(lines, 200),
    excerptLines: 24,
  });
  const summary = {
    session,
    state: result.state,
    prompt: result.prompt,
    options: result.options,
    spinner: result.spinner,
    doneMarker: result.doneMarker,
    excerpt: result.excerpt,
    evidence: result.evidence,
  };
  if (json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
    return summary;
  }
  const out = [`session: ${summary.session}`, `state:   ${summary.state}`];
  if (summary.prompt) out.push(`prompt:  ${summary.prompt}`);
  if (summary.options && summary.options.length) {
    out.push("options:");
    for (const opt of summary.options) {
      const sel = opt.selected ? ">" : " ";
      const num = opt.number ? `${opt.number}.` : " ";
      out.push(`  ${sel} ${num} ${opt.label}`);
    }
  }
  if (summary.spinner) {
    out.push(`spinner: ${summary.spinner.label} (${summary.spinner.detail})`);
  }
  if (summary.doneMarker) out.push(`done:    ${summary.doneMarker}`);
  out.push("", "-- excerpt --", summary.excerpt);
  console.log(out.join("\n"));
  return summary;
}

// Resolves approve/deny against the live pane. Returns { ok, code, payload, result }.
// Refuses with nonzero exit code when there is no permission/input prompt.
// Numbered menus: send `<number>` Enter.
// Unnumbered cursor menus: navigate from the single selected option via Up/Down,
//   then Enter. Refuses when no selection, ambiguous selection, or no label match.
function resolvePromptAction(session, lines, intent) {
  const raw = captureSession(session, lines);
  const result = classifyPane(raw, {
    tailLines: Math.min(lines, 200),
    excerptLines: 24,
  });
  const isPromptState =
    result.state === "permission_prompt" || result.state === "needs_input";
  if (!isPromptState) {
    return {
      ok: false,
      code: 2,
      result,
      payload: {
        error: "no prompt",
        session,
        state: result.state,
        hint: "ccb.approve/deny only act on permission_prompt or needs_input states",
      },
    };
  }

  // Inline y/n style prompt with no numbered options.
  if (!result.options || result.options.length === 0) {
    const answer = intent === "deny" ? "n" : "y";
    key(session, [answer, "Enter"]);
    return {
      ok: true,
      code: 0,
      result,
      payload: {
        session,
        intent,
        via: "inline-yn",
        answer,
        prompt: result.prompt,
      },
    };
  }

  const pick = selectOption(result.options, intent);
  if (!pick) {
    return {
      ok: false,
      code: 3,
      result,
      payload: {
        error: "no matching option",
        session,
        state: result.state,
        intent,
        options: result.options,
        prompt: result.prompt,
        hint: "Use `ccb choose N` to select an option position directly",
      },
    };
  }

  // Numbered menu: send the number verbatim.
  if (pick.number !== null) {
    key(session, [String(pick.number), "Enter"]);
    return {
      ok: true,
      code: 0,
      result,
      payload: {
        session,
        intent,
        prompt: result.prompt,
        via: pick.via,
        number: pick.number,
        label: pick.label,
      },
    };
  }

  // Unnumbered cursor menu: must have exactly one selected option to navigate from.
  if (pick.selectionState !== "single") {
    return {
      ok: false,
      code: 3,
      result,
      payload: {
        error:
          pick.selectionState === "ambiguous"
            ? "ambiguous selection"
            : "no selection cursor",
        session,
        state: result.state,
        intent,
        options: result.options,
        prompt: result.prompt,
        hint: "Cannot navigate an unnumbered menu without a single visible cursor; use `ccb choose N` if positions are known",
      },
    };
  }

  const moves = [];
  if (pick.moves.direction === "up") {
    for (let i = 0; i < pick.moves.count; i++) moves.push("Up");
  } else if (pick.moves.direction === "down") {
    for (let i = 0; i < pick.moves.count; i++) moves.push("Down");
  }
  moves.push("Enter");
  key(session, moves);

  return {
    ok: true,
    code: 0,
    result,
    payload: {
      session,
      intent,
      prompt: result.prompt,
      via: pick.moves.count === 0 ? "cursor-confirm" : `cursor-${pick.moves.direction}`,
      moves: pick.moves,
      targetLabel: pick.label,
      targetIndex: pick.targetIndex,
      selectedIndex: pick.selectedIndex,
    },
  };
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll the pane and emit only state transitions. Exits 0 on done/crashed,
// 5 on timeout, 4 on capture error. Ctrl+C exits 0 with a "stopped" event.
async function watchSession(session, opts) {
  const intervalMs = opts["interval-ms"];
  const timeoutMs = opts["timeout-ms"];
  const lines = opts.lines;
  const json = Boolean(opts.json);
  const start = Date.now();
  let lastSig = "";
  let lastState = "";
  let stopped = false;

  const finalize = (event) => {
    if (json) {
      process.stdout.write(
        JSON.stringify({
          event,
          session,
          watchedMs: Date.now() - start,
        }) + "\n",
      );
    } else {
      console.log(`\n[${event}]`);
    }
  };

  const onSignal = () => {
    if (stopped) return;
    stopped = true;
    finalize("stopped");
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (!stopped) {
    let raw;
    try {
      raw = captureSession(session, lines);
    } catch (e) {
      if (json) {
        process.stdout.write(
          JSON.stringify({
            event: "error",
            session,
            error: e.message,
          }) + "\n",
        );
      } else {
        console.error(`capture error: ${e.message}`);
      }
      process.exit(4);
    }
    const result = classifyPane(raw, {
      tailLines: Math.min(lines, 200),
      excerptLines: 12,
    });
    const sig = [
      result.state,
      result.prompt || "",
      (result.options || [])
        .map((o) => `${o.number}:${o.label}:` + (o.selected ? "1" : "0"))
        .join("|"),
      result.doneMarker || "",
    ].join("::");
    if (sig !== lastSig) {
      if (json) {
        process.stdout.write(
          JSON.stringify({
            event: "transition",
            session,
            ts: new Date().toISOString(),
            from: lastState,
            to: result.state,
            prompt: result.prompt,
            options: result.options,
            spinner: result.spinner,
            doneMarker: result.doneMarker,
            excerpt: result.excerpt,
          }) + "\n",
        );
      } else {
        const stamp = new Date().toISOString().split("T")[1].split(".")[0];
        const meta = [
          result.prompt ? `prompt=${result.prompt}` : "",
          result.doneMarker ? result.doneMarker : "",
          result.spinner ? `${result.spinner.label} (${result.spinner.detail})` : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.log(
          `[${stamp}] ${lastState || "-"} -> ${result.state}${meta ? " | " + meta : ""}`,
        );
      }
      lastSig = sig;
      lastState = result.state;
    }
    if (result.state === "done" || result.state === "crashed") {
      finalize(result.state);
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      finalize("timeout");
      process.exit(5);
    }
    await sleepAsync(intervalMs);
  }
}

function tmux(args, options = {}) {
  return must("tmux", args, options);
}

function key(session, keys) {
  const target = tmuxSessionName(session);
  tmux(["send-keys", "-t", target, ...keys]);
  return { session, tmuxSession: target, keys };
}

function enterText(session, text, enter = true) {
  const target = tmuxSessionName(session);
  tmux(["load-buffer", "-"], { input: text });
  tmux(["paste-buffer", "-p", "-t", target]);
  if (enter) tmux(["send-keys", "-t", target, "Enter"]);
  return { session, tmuxSession: target, entered: enter, bytes: Buffer.byteLength(text) };
}

// Multiline-safe steer: load payload into a tmux buffer, paste with bracket
// mode AND -r (no LF→CR conversion) so embedded newlines survive end-to-end.
// Without -r tmux replaces each LF with CR, which a downstream input box may
// interpret as separate Enter presses — truncating the paste to its first line.
function steerMessage(session, message) {
  const target = tmuxSessionName(session);
  const fullMessage = buildSteerPayload(message);
  const buffer = `ccb-steer-${randomUUID()}`;
  try {
    tmux(["load-buffer", "-b", buffer, "-"], { input: fullMessage });
    tmux(["paste-buffer", "-dpr", "-b", buffer, "-t", target]);
    tmux(["send-keys", "-t", target, "Enter"]);
  } finally {
    try {
      tmux(["delete-buffer", "-b", buffer]);
    } catch {
      // -d should already remove it; ignore if gone.
    }
  }
  return {
    session,
    tmuxSession: target,
    bytes: Buffer.byteLength(fullMessage),
    lines: countLines(fullMessage),
  };
}

function findGlobalCcmuxCore() {
  const npmRoot = run("npm", ["root", "-g"]);
  if (npmRoot.status !== 0) return null;
  const core = path.join(npmRoot.stdout.trim(), "claude-code-tmux", "src", "core.mjs");
  return existsSync(core) ? core : null;
}

function patchCcmuxWindows() {
  if (process.platform !== "win32") {
    return { changed: false, message: "Windows patch not needed on this platform." };
  }

  const file = findGlobalCcmuxCore();
  if (!file) {
    throw new Error("Could not find global claude-code-tmux/src/core.mjs. Run: pi install npm:claude-code-tmux");
  }

  let src = readFileSync(file, "utf8");
  const original = src;

  if (!src.includes("msysPathForShell")) {
    src = src.replace(
      /export function shellQuote\(value\) \{\r?\n\s*return `'[^`]+`;\r?\n\}/,
      `export function shellQuote(value) {
  if (process.platform === "win32") {
    return "\\"" + String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + "\\"";
  }
  return '\\'' + String(value).replace(/'/g, '\\'"\\'"\\'') + '\\'';
}

export function msysPathForShell(value) {
  const text = String(value);
  const match = text.match(/^([a-zA-Z]):[\\\\/](.*)$/);
  if (!match) return text;
  return "/" + match[1].toLowerCase() + "/" + match[2].replace(/\\\\/g, "/");
}`,
    );
  }

  src = src.replace(
    /tmux\(\["pipe-pane", "-o", "-t", tmuxSession, `cat >> \$\{shellQuote\(logPath\)\}`\]\);/g,
    'tmux(["pipe-pane", "-o", "-t", tmuxSession, `cat >> ${shellQuote(msysPathForShell(logPath))}`]);',
  );

  src = src.replace(
    /tmux\(\["load-buffer", "-b", bufferName, job\.promptPath\]\);/g,
    'tmux(["load-buffer", "-b", bufferName, msysPathForShell(job.promptPath)]);',
  );

  // steerSession uses load-buffer with its own promptPath; same Windows path bug.
  // Leave an idempotent marker so re-running patchCcmuxWindows is a no-op.
  src = src.replace(
    /tmux\(\["load-buffer", "-b", id, promptPath\]\);/g,
    'tmux(["load-buffer", "-b", id, msysPathForShell(promptPath)]); // ccb-patched',
  );

  if (!src.includes('if (process.platform === "win32") break;')) {
    src = src.replace(
      /tmux\(\["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job\.tmuxSession\]\);\r?\n\s*sleepSync\(pasteDelayMs\);/g,
      'tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job.tmuxSession]);\n    sleepSync(pasteDelayMs);\n    if (process.platform === "win32") break;',
    );
  }

  const encodedWindowsCommand = `const command = argv.map(shellQuote).join(" ");
if (process.platform === "win32") {
    const cwdPrefix = options.cwd ? \`Set-Location -LiteralPath \${shellQuote(options.cwd)}; \` : "";
    const authPrefix = "Get-ChildItem Env:ANTHROPIC* | Remove-Item -ErrorAction SilentlyContinue; ";
    const script = \`\${authPrefix}\${cwdPrefix}& \${command}\`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return \`powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand \${encoded}\`;
  }
return command;`;
  src = src.replace(
    /const command = argv\.map\(shellQuote\)\.join\(" "\);\r?\n\s*return process\.platform === "win32" \? `& \$\{command\}` : command;/g,
    encodedWindowsCommand,
  );
  src = src.replace(
    /const command = argv\.map\(shellQuote\)\.join\(" "\);\r?\n\s*if \(process\.platform === "win32"\) \{[\s\S]*?const authPrefix = "Get-ChildItem Env:ANTHROPIC\* \| Remove-Item -ErrorAction SilentlyContinue; ";\r?\n\s*return `\$\{authPrefix\}\$\{cwdPrefix\}& \$\{command\}`;\r?\n\s*\}\r?\n\s*return command;/g,
    encodedWindowsCommand,
  );

  if (src !== original) writeFileSync(file, src);
  return { changed: src !== original, file };
}

function doctor(json = false) {
  const checks = {
    node: commandOk("node", ["--version"]),
    npm: commandOk("npm", ["--version"]),
    pi: commandOk("pi", ["--version"]),
    claude: commandOk("claude", ["--version"]),
    ccmux: commandOk("ccmux", ["--help"]),
    tmux: commandOk("tmux", ["-V"]),
    platform: { ok: true, command: "platform", output: `${process.platform} ${os.release()}` },
  };
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  for (const [name, check] of Object.entries(checks)) {
    console.log(`${check.ok ? "ok " : "bad"} ${name}: ${check.output}`);
  }
}

function printCommandRecords(records, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  if (!records.length) {
    console.log("No journaled commands.");
    return;
  }
  for (const record of records) {
    console.log(
      [
        record.commandId,
        record.session,
        record.commandClass,
        record.currentState,
        record.ack || "-",
        record.updatedAt,
      ].join("\t"),
    );
  }
}

async function main() {
  const { command, opts } = parse(process.argv.slice(2));
  const session = safeName(opts.session || opts.name || DEFAULT_SESSION);
  const cwd = path.resolve(String(opts.cwd || process.cwd()));

  if (command === "help") return printHelp();
  if (command === "doctor") return doctor(Boolean(opts.json));
  if (command === "commands") {
    const requestedSession = opts.session ? session : undefined;
    await commandJournal.reconcile({ session: requestedSession });
    const records = await commandJournal.listCommands({
      session: requestedSession,
    });
    printCommandRecords(records, Boolean(opts.json));
    return;
  }
  if (command === "command-status") {
    const commandId = opts._[0];
    if (!commandId) throw new Error("command-status requires command ID");
    await commandJournal.reconcile();
    const records = await commandJournal.listCommands();
    const record = records.find((item) => item.commandId === commandId);
    if (!record) {
      process.exitCode = 4;
      throw new Error(`Unknown command ID: ${commandId}`);
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    else printCommandRecords([record], false);
    return;
  }
  if (command === "patch-ccmux-windows") {
    console.log(JSON.stringify(patchCcmuxWindows(), null, 2));
    return;
  }
  if (command === "status") {
    process.stdout.write(must("ccmux", ["status"]));
    return;
  }
  if (command === "sessions") {
    console.log(JSON.stringify(ccmuxStatus().sessions || [], null, 2));
    return;
  }
  if (command === "jobs") {
    process.stdout.write(must("ccmux", ["jobs"]));
    return;
  }
  if (command === "start") {
    process.stdout.write(startSession({ session, cwd, opts }));
    return;
  }
  if (command === "send") {
    const prompt = opts._.join(" ").trim();
    if (!prompt) throw new Error("send requires prompt");
    const timeoutMs = parsePositiveInt(
      opts["timeout-ms"],
      DEFAULT_TIMEOUT_MS,
      "timeout-ms",
    );
    const settleMs = parsePositiveInt(opts["settle-ms"], 3000, "settle-ms");
    await commandJournal.reconcile({ session });
    ensureSession({
      session,
      cwd,
      opts,
      startupWaitMs: Number(opts["startup-wait-ms"] || DEFAULT_STARTUP_WAIT_MS),
    });
    const { body, exitCode } = await executeSend({
      session,
      prompt,
      timeoutMs,
      settleMs,
    });
    console.log(JSON.stringify(body, null, 2));
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
  if (command === "type") {
    const text = opts._.join(" ");
    if (!text) throw new Error("type requires text");
    await commandJournal.reconcile({ session });
    const { body, exitCode } = await executeType({
      session,
      text,
      enter: Boolean(opts.enter),
    });
    console.log(JSON.stringify(body, null, 2));
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
  if (command === "slash") {
    const slash = opts._.join(" ").trim();
    if (!slash) throw new Error("slash requires command");
    const text = slash.startsWith("/") ? slash : `/${slash}`;
    // Orchestration (fail-closed baseline, delivery, readiness barrier, truthful
    // injectedAt, and exit codes) lives in executeSlash so it is unit-testable.
    // main() always prints the telemetry body, then propagates a nonzero exit
    // code so a sequential caller cannot proceed into a known non-ready pane.
    await commandJournal.reconcile({ session });
    const { body, exitCode } = await executeCoordinatedSlash({ session, text, opts });
    console.log(JSON.stringify(body, null, 2));
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
  if (command === "steer") {
    const message = opts._.join(" ").trim();
    if (!message) throw new Error("steer requires message");
    await commandJournal.reconcile({ session });
    const { body, exitCode } = await executeSteer({ session, message });
    console.log(JSON.stringify(body, null, 2));
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
  if (command === "key") {
    if (!opts._.length) throw new Error("key requires one or more tmux key names");
    console.log(JSON.stringify(key(session, opts._), null, 2));
    return;
  }
  if (command === "choose") {
    const choice = opts._[0];
    if (!choice) throw new Error("choose requires number");
    console.log(JSON.stringify(key(session, [String(choice), "Enter"]), null, 2));
    return;
  }
  if (command === "enter") {
    console.log(JSON.stringify(key(session, ["Enter"]), null, 2));
    return;
  }
  if (command === "escape") {
    console.log(JSON.stringify(key(session, ["Escape"]), null, 2));
    return;
  }
  if (command === "interrupt") {
    console.log(JSON.stringify(key(session, ["C-c"]), null, 2));
    return;
  }
  if (command === "capture") {
    process.stdout.write(captureSession(session, opts.lines || 120));
    return;
  }
  if (command === "wait-ready") {
    console.log(JSON.stringify(waitReady(session, Number(opts["timeout-ms"] || DEFAULT_READY_TIMEOUT_MS)), null, 2));
    return;
  }
  if (command === "inspect") {
    const lines = parsePositiveInt(opts.lines, DEFAULT_INSPECT_LINES, "lines");
    inspectSession(session, lines, Boolean(opts.json));
    return;
  }
  if (command === "approve" || command === "deny") {
    const lines = parsePositiveInt(opts.lines, DEFAULT_INSPECT_LINES, "lines");
    const outcome = resolvePromptAction(session, lines, command);
    if (opts.json || !outcome.ok) {
      process.stdout.write(JSON.stringify(outcome.payload, null, 2) + "\n");
    } else {
      const pick = outcome.payload;
      const target =
        pick.number !== undefined
          ? `option ${pick.number} (${pick.label})`
          : pick.targetLabel
            ? `cursor -> ${pick.targetLabel}`
            : pick.answer
              ? pick.answer.toUpperCase()
              : "?";
      console.log(`${command}: ${pick.via} -> ${target}`);
    }
    process.exit(outcome.code);
    return;
  }
  if (command === "watch") {
    await watchSession(session, {
      "interval-ms": parsePositiveInt(
        opts["interval-ms"],
        DEFAULT_WATCH_INTERVAL_MS,
        "interval-ms",
      ),
      "timeout-ms": parsePositiveInt(
        opts["timeout-ms"],
        DEFAULT_WATCH_TIMEOUT_MS,
        "timeout-ms",
      ),
      lines: parsePositiveInt(opts.lines, DEFAULT_INSPECT_LINES, "lines"),
      json: Boolean(opts.json),
    });
    return;
  }
  if (command === "attach") {
    run("ccmux", ["attach", "--session", session], { stdio: "inherit" });
    return;
  }
  if (command === "kill") {
    process.stdout.write(must("ccmux", ["kill", "--session", session]));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

// Run main() only when executed directly, not when imported (e.g. by tests).
// Resolve both paths through symlinks/junctions because npm link invokes this
// file through its global package junction while import.meta.url uses the real
// repository path.
let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule =
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    // A missing/unresolvable argv path cannot be this module's entry point.
  }
}
if (isMainModule) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
