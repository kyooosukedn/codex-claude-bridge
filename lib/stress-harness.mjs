// P1 stress / fault-injection harness — pure, machine-verifiable core.
//
// The live driver (bin/ccb-stress.mjs) launches real Claude sessions and is
// opt-in only. Everything that must be deterministic about a run lives here as
// pure functions so `npm test` can verify the P1 acceptance contract — zero
// lost / duplicate / reordered prompts — without launching Claude.
//
// Design notes:
// - Trial ids are zero-padded to the width of the trial count so lexicographic
//   order always equals chronological order. That makes "reordered" a plain
//   array comparison.
// - computeVerdict is the single source of truth for pass/fail. A run passes
//   the P1 gate only when lost, extra, and duplicates are all empty AND the
//   observed order matches the planned order.

import fs from "node:fs/promises";
import path from "node:path";

import { createTokenObserver } from "./token-observer.mjs";

const DEFAULT_TRIALS = 100;
const DEFAULT_SESSION = "ccb-stress";
const DEFAULT_ID_PREFIX = "CCBSTRESS";
const DEFAULT_SLASH_COMMAND = "/model default";
const DEFAULT_CAPTURE_LINES = 4000;

// id-prefix and session names are interpolated into RegExp and file paths, so
// they are restricted to the same safe component charset used by the journal
// and coordinator. This is strict validation, not escaping-with-trust.
const SAFE_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;

export function validateIdPrefix(prefix) {
  const text = String(prefix ?? "");
  if (!SAFE_COMPONENT_RE.test(text) || text === "." || text === "..") {
    throw new Error(`Invalid id-prefix: ${JSON.stringify(prefix)}`);
  }
  return text;
}

function validateComponent(value, label) {
  const text = String(value ?? "");
  if (!SAFE_COMPONENT_RE.test(text) || text === "." || text === "..") {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return text;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Build a between-trials sleep that pauses ONLY for a positive duration. A
// zero/undefined budget is a true no-op so the fast zero-default stress run is
// unchanged, while --sleep-ms N actually pauses for N ms. Used by the live
// driver so config.sleepMs is honored end to end.
export const createBoundedSleep =
  (sleepImpl = defaultSleep) =>
  async (ms) => {
    if (Number.isFinite(ms) && ms > 0) await sleepImpl(ms);
  };

// Heuristic readiness predicate for --start: the pane shows an input prompt or
// a known idle footer. The per-trial readiness barrier (lib/readiness.mjs) is
// the real gate; this only guards "session is up before trial 1".
export function defaultIsReady(text) {
  // Version-agnostic: match the "edit queued messages" hint without the
  // leading "Press up" (its wording has changed across Claude Code versions).
  return /(^|\n|…|\.)>\s|edit queued messages|bypass permissions on/i.test(String(text ?? ""));
}

export function extractTokens(text, { pattern }) {
  if (text == null) return [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const ids = [];
  let match;
  while ((match = re.exec(String(text))) !== null) {
    ids.push(match[1] ?? match[0]);
  }
  return ids;
}

export function buildTrials({
  count = DEFAULT_TRIALS,
  idPrefix = DEFAULT_ID_PREFIX,
  slashCommand = DEFAULT_SLASH_COMMAND,
} = {}) {
  validateIdPrefix(idPrefix);
  const width = Math.max(3, String(count).length);
  const trials = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `${idPrefix}-${String(index).padStart(width, "0")}`;
    // The token appears EXACTLY ONCE (as the user's prompt). Claude is told not
    // to repeat it, so a second occurrence in the pane is real evidence of a
    // double injection — not a model echo. A model that echoes the token
    // anyway yields a conservative false failure (documented in STRESS.md).
    const promptText = `${id}\nAcknowledge with a single OK. Do not repeat the code above.`;
    trials.push({
      index,
      id,
      slashText: slashCommand,
      promptText,
    });
  }
  return trials;
}

export function tokenPattern(idPrefix = DEFAULT_ID_PREFIX) {
  validateIdPrefix(idPrefix);
  return new RegExp(`${escapeRegExp(idPrefix)}-\\d+`, "g");
}

export function computeVerdict({ expectedIds, observedIds }) {
  const expected = [...(expectedIds ?? [])];
  const observed = [...(observedIds ?? [])];
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);

  const counts = new Map();
  for (const id of observed) counts.set(id, (counts.get(id) ?? 0) + 1);

  const lost = expected.filter((id) => !observedSet.has(id)).sort();
  const extra = [...observedSet].filter((id) => !expectedSet.has(id)).sort();
  const duplicateDetails = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => ({ id, count: n }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const duplicates = duplicateDetails.map((d) => d.id);

  // Reorder check: compare the first-occurrence order of the expected ids that
  // were actually observed against the planned order of those same ids.
  const seen = new Set();
  const observedOrder = [];
  for (const id of observed) {
    if (expectedSet.has(id) && !seen.has(id)) {
      seen.add(id);
      observedOrder.push(id);
    }
  }
  const expectedOrderObserved = expected.filter((id) => observedSet.has(id));
  const reordered =
    JSON.stringify(observedOrder) !== JSON.stringify(expectedOrderObserved);

  const matchedCount = expected.filter((id) => observedSet.has(id)).length;
  const ok =
    lost.length === 0 &&
    extra.length === 0 &&
    duplicates.length === 0 &&
    !reordered;

  return {
    ok,
    expectedCount: expected.length,
    observedCount: observed.length,
    matchedCount,
    lost,
    extra,
    duplicates,
    duplicateDetails,
    reordered,
  };
}

// A run passes only when BOTH token integrity (computeVerdict) AND delivery
// integrity hold: every slash/send exited 0 and every send reached a terminal
// "done" status. A run with all tokens present but a failed/timeout send still
// fails — observed tokens are not proof of clean delivery.
export function sendTerminalStatus(sendRes) {
  const body = sendRes?.body;
  if (!body) return null;
  if (typeof body.status === "string") return body.status;
  if (body.terminal && typeof body.terminal.status === "string") {
    return body.terminal.status;
  }
  return null;
}

// Classify WHERE a slash failed so reports can distinguish a pre-injection idle
// timeout (pane never became injectable; nothing was typed) from a post-
// injection readiness timeout (the slash was delivered but the pane did not
// settle). Derived from the production slash result's readiness telemetry.
function slashFailurePhase(slash) {
  const reason = slash?.body?.readiness?.reason;
  const phase = slash?.body?.readiness?.phase;
  if (phase === "pre-injection") return "pre-injection";
  if (reason === "baseline-not-idle" || reason === "baseline-capture-failed") {
    return "pre-injection";
  }
  if (slash?.exitCode === 6) return "post-injection";
  return "unknown";
}

export function computeRunVerdict({ tokenVerdict, trialResults }) {
  const undelivered = [];
  for (const trial of trialResults ?? []) {
    // Fail closed: only an explicit numeric exitCode === 0 counts as success.
    // A missing/malformed slash or send is NOT coerced to 0. A send is done
    // only when its terminal status is explicitly "done".
    const slashOk = trial.slash?.exitCode === 0;
    const sendOk = trial.send?.exitCode === 0;
    const skipped = trial.send?.skipped === true;
    const status = sendTerminalStatus(trial.send);
    const done = !skipped && status === "done";
    if (!(slashOk && sendOk && done)) {
      const slashReason = trial.slash?.body?.readiness?.reason ?? null;
      const slashPhase = slashOk ? null : slashFailurePhase(trial.slash);
      undelivered.push({
        id: trial.id,
        slashOk,
        sendOk,
        status,
        skipped,
        slashExit: trial.slash?.exitCode ?? null,
        slashReason,
        slashPhase,
      });
    }
  }
  const deliveryOk = undelivered.length === 0;
  return {
    ...tokenVerdict,
    deliveryOk,
    undelivered,
    ok: tokenVerdict.ok && deliveryOk,
  };
}

// Bounded readiness wait used after --start so trial 1 never races a session
// that is still booting. Pure orchestration over injected deps so it is
// deterministic in tests (fake clock) and live in bin/ccb-stress.mjs.
export async function awaitReady({
  capture,
  isReady = defaultIsReady,
  timeoutMs,
  intervalMs = 1000,
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  const start = now();
  let attempts = 0;
  let tail = "";
  while (now() - start < timeoutMs) {
    attempts += 1;
    tail = await capture();
    if (isReady(tail)) {
      return { ready: true, attempts, waitedMs: now() - start, tail };
    }
    await sleep(intervalMs);
  }
  return { ready: false, attempts, waitedMs: now() - start, tail };
}

// Opt-in multi-session isolation plan. Each session gets a session-scoped id
// prefix so a foreign token in a pane is detectable as "extra" by computeVerdict.
export function buildMultiSessionPlan({
  sessions,
  trialsPerSession = 3,
  idPrefix = DEFAULT_ID_PREFIX,
}) {
  validateIdPrefix(idPrefix);
  if (!Array.isArray(sessions) || sessions.length < 2) {
    throw new Error("isolation requires at least 2 sessions");
  }
  const per = sessions.map((session) => {
    const safe = validateComponent(session, "session");
    const trials = buildTrials({
      count: trialsPerSession,
      idPrefix: `${idPrefix}-${safe}`,
    });
    return { session: safe, trials };
  });
  const globalPattern = new RegExp(
    `${escapeRegExp(idPrefix)}-[A-Za-z0-9._-]+-\\d+`,
    "g",
  );
  return { sessions: per, globalPattern };
}

// Drive every session concurrently, then verify each pane contains only that
// session's own tokens AND every trial was cleanly delivered. deps are fake in
// tests, real in bin/ccb-stress.mjs. captureLines is always a positive int so
// no undefined ever reaches the live capture. Each session fails fast and
// independently; one failing session never cancels the others. Observation is
// STREAMING per pane (baseline + after each trial/failure + final) using the
// global pattern, so a transient foreign token fails even if later evicted
// from scrollback.
export async function runMultiSessionIsolation({
  plan,
  deps,
  captureLines = DEFAULT_CAPTURE_LINES,
  sleepMs = 0,
}) {
  const budget = Number.isInteger(captureLines) && captureLines > 0 ? captureLines : DEFAULT_CAPTURE_LINES;
  const perSession = await Promise.all(
    plan.sessions.map(async ({ session, trials }) => {
      const observer = createTokenObserver({ pattern: plan.globalPattern });
      const trialResults = [];
      const observe = async (phase) => {
        let text;
        try {
          text = await deps.capture(session, budget);
        } catch (error) {
          observer.ingestError(error, { phase });
          return;
        }
        observer.ingestText(text, { phase });
      };

      await observe("baseline");
      for (const trial of trials) {
        const slash = await deps.slash(session, trial.slashText);
        if (slash?.exitCode !== 0) {
          trialResults.push({ id: trial.id, slash, send: { skipped: true } });
          await observe(`after-slash-fail:${trial.id}`);
          break;
        }
        const send = await deps.send(session, trial.promptText);
        trialResults.push({ id: trial.id, slash, send });
        await observe(`after-trial:${trial.id}`);
        if (send?.exitCode !== 0 || sendTerminalStatus(send) !== "done") break;
        // Thread the explicit sleep budget through (default 0 = no pause); the
        // live driver's sleep no-ops on undefined, so calling deps.sleep() with
        // no argument would leave --sleep-ms inert in isolation.
        if (deps.sleep) await deps.sleep(sleepMs);
      }
      await observe("final");

      const observedIds = observer.effectiveObserved();
      const tokenVerdict = computeVerdict({
        expectedIds: trials.map((t) => t.id),
        observedIds,
      });
      const verdict = computeRunVerdict({ tokenVerdict, trialResults });
      const observation = observer.summary();
      verdict.observation = observation;
      if (observation.captureErrors > 0) {
        verdict.observationError = true;
        verdict.ok = false;
      }
      return { session, observedIds, trialResults, verdict };
    }),
  );
  const ok = perSession.every((entry) => entry.verdict.ok);
  return { perSession, ok };
}

// Parse harness argv into a validated config. Defaults to dry-run so a bare
// invocation never launches Claude. Live mode requires BOTH --live and --yes.
export function parseStressConfig(argv = []) {
  const opts = { _: [] };
  const args = [...argv];
  while (args.length) {
    const item = args.shift();
    if (!item.startsWith("--")) {
      opts._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (!args.length || args[0].startsWith("--")) opts[key] = true;
    else opts[key] = args.shift();
  }

  const trials = parsePositiveInt(opts.trials, DEFAULT_TRIALS, "trials");
  const session = typeof opts.session === "string" ? opts.session : DEFAULT_SESSION;
  const live = opts.live === true;
  const confirmed = opts.yes === true;
  const isolation = opts.isolation === true;

  // Parse --sessions up front so isolation mode is known before the live-mode
  // --session requirement: live isolation targets named sessions and must NOT
  // require a single --session.
  let sessions = null;
  if (typeof opts.sessions === "string" && opts.sessions.trim()) {
    sessions = opts.sessions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => validateComponent(s, "session"));
    if (sessions.length < 2) throw new Error("--sessions needs at least 2 named sessions");
  }
  if (isolation && !sessions) {
    sessions = [`${session}-1`, `${session}-2`, `${session}-3`];
  }

  if (live && !confirmed) {
    throw new Error(
      "live mode launches real Claude sessions and costs money; pass --yes to confirm",
    );
  }
  const mode = live ? "live" : "dry-run";
  if (mode === "live" && !isolation && !opts.session) {
    throw new Error("live mode requires --session NAME (or --isolation --sessions ...)");
  }

  const idPrefix = typeof opts["id-prefix"] === "string" ? validateIdPrefix(opts["id-prefix"]) : DEFAULT_ID_PREFIX;
  const slashCommand =
    typeof opts.slash === "string" ? opts.slash : DEFAULT_SLASH_COMMAND;
  const captureLines = parsePositiveInt(opts["capture-lines"], DEFAULT_CAPTURE_LINES, "capture-lines");
  const sleepMs = parseNonNegativeInt(opts["sleep-ms"], 0, "sleep-ms");
  const outDir = typeof opts["out-dir"] === "string" ? opts["out-dir"] : null;
  const start = opts.start === true;
  const cleanup = opts.cleanup === true;
  const readyTimeoutMs = parsePositiveInt(opts["ready-timeout-ms"], 60000, "ready-timeout-ms");

  const isolationMode = isolation;

  return {
    mode,
    trials,
    session,
    idPrefix,
    slashCommand,
    captureLines,
    sleepMs,
    outDir,
    start,
    cleanup,
    isolation: isolationMode,
    sessions,
    trialsPerSession: trials,
    readyTimeoutMs,
  };
}

function parsePositiveInt(raw, fallback, label) {
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${label} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseNonNegativeInt(raw, fallback, label) {
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${label} must be a non-negative integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

// Drive N slash-then-prompt trials through injected deps. Pure orchestration:
// deps.capture / deps.slash / deps.send are fake in tests and real in
// bin/ccb-stress.mjs. Observation is STREAMING: a baseline capture before
// trial 1 (to detect stale same-prefix tokens), a capture after every
// attempted send / slash failure, and a final snapshot are accumulated by a
// token observer. The verdict is computed from accumulated evidence, not a
// single final scrollback — so `tmux history-limit 2000` cannot cause spurious
// "lost" tokens. captureLines is always a positive int passed to every capture.
export async function runStress({ config, deps }) {
  const trials = buildTrials({
    count: config.trials,
    idPrefix: config.idPrefix,
    slashCommand: config.slashCommand,
  });
  const startedAt = deps.now ? deps.now() : new Date();
  const trialResults = [];
  const captureLines = Number.isInteger(config.captureLines)
    ? config.captureLines
    : DEFAULT_CAPTURE_LINES;
  const observer = createTokenObserver({ pattern: tokenPattern(config.idPrefix) });

  // One observation step. Capture errors are recorded (fail closed) rather than
  // thrown, so the verdict artifact stays machine-verifiable.
  const observe = async (phase) => {
    let text;
    try {
      text = await deps.capture(config.session, captureLines);
    } catch (error) {
      observer.ingestError(error, { phase });
      return;
    }
    observer.ingestText(text, { phase });
  };

  // Baseline before trial 1: stale same-prefix tokens surface as extra/
  // duplicate/reorder instead of being trusted or ignored.
  await observe("baseline");

  // Fail-fast per session: if slash is not explicit success, record a skipped
  // send and stop (no injection into a not-ready/unknown pane). If send is not
  // explicit exit 0 + terminal done, stop. Remaining trials are never attempted
  // and therefore appear as lost tokens in the verdict.
  for (const trial of trials) {
    const slashRes = await deps.slash(config.session, trial.slashText);
    if (slashRes?.exitCode !== 0) {
      trialResults.push({ id: trial.id, slash: slashRes, send: { skipped: true } });
      await observe(`after-slash-fail:${trial.id}`);
      break;
    }
    const sendRes = await deps.send(config.session, trial.promptText);
    trialResults.push({ id: trial.id, slash: slashRes, send: sendRes });
    await observe(`after-send:${trial.id}`);
    if (sendRes?.exitCode !== 0 || sendTerminalStatus(sendRes) !== "done") break;
    if (deps.sleep) await deps.sleep(config.sleepMs ?? 0);
  }

  await observe("final");

  const observedIds = observer.effectiveObserved();
  const tokenVerdict = computeVerdict({
    expectedIds: trials.map((t) => t.id),
    observedIds,
  });
  const verdict = computeRunVerdict({ tokenVerdict, trialResults });
  const observation = observer.summary();
  verdict.observation = observation;
  // Fail closed on any capture error: never silently drop an observation.
  if (observation.captureErrors > 0) {
    verdict.observationError = true;
    verdict.ok = false;
  }
  const endedAt = deps.now ? deps.now() : new Date();

  return {
    config,
    trials,
    trialResults,
    deliveryFailures: verdict.undelivered,
    observedIds,
    verdict,
    observation,
    startedAt,
    endedAt,
  };
}

export function formatReport({
  config,
  verdict,
  startedAt,
  endedAt,
  artifactsDir,
}) {
  const headline = verdict.ok ? "PASS" : "FAIL";
  const undeliveredCount = (verdict.undelivered ?? []).length;
  const lines = [
    `STRESS ${headline}`,
    `platform: ${process.platform}`,
    `mode: ${config.mode}`,
    `session: ${config.session}`,
    `trials: ${config.trials}`,
    `verdict: ok=${verdict.ok} expected=${verdict.expectedCount} observed=${verdict.observedCount} matched=${verdict.matchedCount}`,
    `lost ${verdict.lost.length} | duplicate ${verdict.duplicates.length} | extra ${verdict.extra.length} | reordered ${verdict.reordered} | undelivered ${undeliveredCount}`,
    `startedAt: ${new Date(startedAt).toISOString()}`,
    `endedAt: ${new Date(endedAt).toISOString()}`,
  ];
  const obs = verdict.observation;
  if (obs) {
    lines.push(
      `observation: ${obs.mode} snapshots=${obs.snapshots} distinct=${obs.distinctTokens} maxConcurrent=${obs.maxConcurrent} captureErrors=${obs.captureErrors}`,
    );
  }
  if (artifactsDir) lines.push(`artifacts: ${artifactsDir}`);
  const failures = formatFailureReport(verdict);
  if (failures) lines.push("", failures);
  return lines.join("\n");
}

export function formatFailureReport(verdict) {
  if (verdict.ok) return "";
  const sections = [];
  const lost = verdict.lost ?? [];
  const extra = verdict.extra ?? [];
  const duplicates = verdict.duplicates ?? [];
  const duplicateDetails = verdict.duplicateDetails ?? [];
  const undelivered = verdict.undelivered ?? [];
  if (lost.length) {
    sections.push(`lost (${lost.length}):\n  ${lost.join("\n  ")}`);
  }
  if (duplicateDetails.length) {
    const detail = duplicateDetails.map((d) => `${d.id} x${d.count}`).join("\n  ");
    sections.push(`duplicate (${duplicateDetails.length}):\n  ${detail}`);
  } else if (duplicates.length) {
    sections.push(`duplicate (${duplicates.length}):\n  ${duplicates.join("\n  ")}`);
  }
  if (extra.length) {
    sections.push(`extra (${extra.length}):\n  ${extra.join("\n  ")}`);
  }
  if (verdict.reordered) sections.push("reorder: observed order does not match planned order");
  if (undelivered.length) {
    const detail = undelivered
      .map((u) => {
        const parts = [
          `slashOk=${u.slashOk}`,
          `sendOk=${u.sendOk}`,
          `status=${u.status}`,
        ];
        if (u.skipped) parts.push("skipped=true");
        if (u.slashExit !== null && u.slashExit !== undefined) {
          parts.push(`slashExit=${u.slashExit}`);
        }
        if (u.slashPhase) parts.push(`slashPhase=${u.slashPhase}`);
        if (u.slashReason) parts.push(`slashReason=${u.slashReason}`);
        return `${u.id} (${parts.join(" ")})`;
      })
      .join("\n  ");
    sections.push(`undelivered (${undelivered.length}):\n  ${detail}`);
  }
  return sections.join("\n");
}

// Remove an artifacts directory only when it resolves inside an allowed root.
// Refuses traversal and absolute paths outside the roots so a bad config can
// never delete unrelated files. Missing target is a no-op, not an error.
export async function safeCleanupDir(target, { allowRoots = [] }) {
  if (!target) return { removed: false, reason: "no-target" };
  const resolved = path.resolve(target);
  const allowed = allowRoots.map((r) => path.resolve(r));
  const inside = allowed.some((root) => {
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!inside) return { removed: false, reason: "outside allowed roots" };
  try {
    await fs.stat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "missing" };
    return { removed: false, reason: error.message };
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, reason: error.message };
  }
  return { removed: true, reason: "removed" };
}
