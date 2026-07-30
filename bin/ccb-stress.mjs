#!/usr/bin/env node
// P1 stress / fault-injection harness — LIVE entrypoint.
//
// Opt-in only. `npm test` never invokes this script. Dry-run (the default)
// builds and prints a trial plan without touching Claude. Live mode requires
// BOTH --live and --yes, launches a real Claude session, and writes a
// machine-verifiable verdict + report to an artifacts directory.
//
// See docs/STRESS.md for prerequisites, exact commands, artifacts, limitations.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  awaitReady,
  buildMultiSessionPlan,
  buildTrials,
  createBoundedSleep,
  defaultSleep,
  formatReport,
  formatFailureReport,
  parseStressConfig,
  runMultiSessionIsolation,
  runStress,
  safeCleanupDir,
} from "../lib/stress-harness.mjs";
import { createTransport } from "../lib/transport.mjs";
import {
  executeCoordinatedSlash,
  executeSend,
} from "./codex-claude-bridge.mjs";

function defaultArtifactsRoot() {
  const home = process.env.CCB_HOME
    ? process.env.CCB_HOME
    : path.join(os.homedir(), ".codex-claude-bridge");
  return path.join(home, "stress");
}

function printHelp() {
  console.log(`ccb-stress — P1 slash-then-prompt stress harness

Usage:
  node bin/ccb-stress.mjs [--trials N] [--session NAME] [--slash CMD]
                          [--id-prefix PREFIX] [--capture-lines N] [--sleep-ms MS]
                          [--out-dir DIR] [--start] [--ready-timeout-ms MS]
                          [--cleanup] [--live --yes]
  node bin/ccb-stress.mjs --isolation [--sessions A,B,C] [--trials N] [--live --yes]

Modes:
  dry-run (default)  Build the trial plan and print it. Never launches Claude.
  live               Requires --live AND --yes. Runs N slash-then-prompt trials
                     against a real Claude session, then writes a verdict.

Live prerequisites: a started ccmux/tmux/claude session (use --start to create
one), 'ccb patch-ccmux-windows' applied on Windows, and a funded Claude account.

Artifacts: verdict.json + report.txt under --out-dir, or
<CCB_HOME|~/.codex-claude-bridge>/stress/<UTC timestamp>/.

Exit codes: 0 ok / dry-run, 1 failed verdict, 2 usage error.`);
}

function die(message) {
  console.error(`ccb-stress: ${message}`);
  process.exit(2);
}

// Real live deps: reuse the production injection path (pre-injection idle
// baseline gate + autocomplete confirmation + readiness barrier + per-session
// serialization) for every trial, and capture the pane to extract tokens.
// readyTimeoutMs configures BOTH the pre-injection idle wait and the post-
// injection readiness barrier, so long stop hooks (which keep the pane
// "thinking" past ccmux's terminal "done") are tolerated via one knob.
export function createLiveDeps(transport, { readyTimeoutMs } = {}) {
  const capture = async (session, lines) => {
    const budget = Number.isInteger(lines) && lines > 0 ? lines : 4000;
    const result = transport.run("ccmux", [
      "capture",
      "--session",
      session,
      "--lines",
      String(budget),
    ]);
    if (result.status !== 0) {
      throw new Error(`ccmux capture failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return result.stdout || "";
  };
  const slashOpts = Number.isInteger(readyTimeoutMs) && readyTimeoutMs > 0
    ? { "ready-timeout-ms": String(readyTimeoutMs) }
    : {};
  return {
    slash: async (session, text) => executeCoordinatedSlash({ session, text, opts: slashOpts }),
    send: async (session, prompt) => executeSend({ session, prompt }),
    capture,
    now: () => new Date(),
    // Pause between trials when --sleep-ms is set. Only a positive duration
    // pauses, so the default (0) stays a true no-op and the fast zero-default
    // run is unchanged.
    sleep: createBoundedSleep(defaultSleep),
  };
}

async function ensureSession(transport, session, { readyTimeoutMs }) {
  const status = transport.run("ccmux", ["status"]);
  if (status.status !== 0) {
    throw new Error(`ccmux status failed: ${(status.stderr || "").trim()}`);
  }
  const alive = JSON.parse(status.stdout || "{}").sessions?.some(
    (s) => s.name === session && s.alive,
  );
  if (!alive) {
    console.error(`ccb-stress: starting session ${session} (--start)`);
    const started = transport.run("ccmux", [
      "start",
      "--name",
      session,
      "--no-agents-md",
    ]);
    if (started.status !== 0) {
      throw new Error(`ccmux start failed: ${(started.stderr || started.stdout || "").trim()}`);
    }
  }

  // Bounded readiness wait: trial 1 must not race a session that is still
  // booting. Abort loudly if the pane never confirms an input prompt.
  const readiness = await awaitReady({
    capture: async () => {
      const r = transport.run("ccmux", ["capture", "--session", session, "--lines", "80"]);
      return r.status === 0 ? r.stdout || "" : "";
    },
    timeoutMs: readyTimeoutMs,
    intervalMs: 1000,
  });
  if (!readiness.ready) {
    throw new Error(
      `session ${session} did not confirm readiness within ${readyTimeoutMs}ms (tail: ${readiness.tail.slice(-120)})`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  let config;
  try {
    config = parseStressConfig(argv);
  } catch (error) {
    die(error.message);
  }

  const trials = buildTrials({
    count: config.trials,
    idPrefix: config.idPrefix,
    slashCommand: config.slashCommand,
  });

  if (config.mode === "dry-run") {
    if (config.isolation) {
      const plan = buildMultiSessionPlan({
        sessions: config.sessions,
        trialsPerSession: config.trials,
        idPrefix: config.idPrefix,
      });
      console.log(
        `ccb-stress dry-run (isolation): ${plan.sessions.length} sessions x ${config.trials} trials`,
      );
      for (const entry of plan.sessions) {
        console.log(`  ${entry.session}: ${entry.trials[0].id} .. ${entry.trials[entry.trials.length - 1].id}`);
      }
      console.log("Add --live --yes to run against real Claude sessions.");
      return;
    }
    console.log(`ccb-stress dry-run: ${trials.length} trials, session=${config.session}, slash=${config.slashCommand}`);
    console.log(`first: ${trials[0].id}  last: ${trials[trials.length - 1].id}`);
    console.log("Add --live --yes to run against a real Claude session.");
    return;
  }

  // --- live mode ---
  const transport = createTransport();
  const artifactsDir = config.outDir
    ? path.resolve(config.outDir)
    : path.join(defaultArtifactsRoot(), new Date().toISOString().replace(/[:.]/g, "-"));

  if (config.cleanup) {
    const root = config.outDir ? path.dirname(artifactsDir) : defaultArtifactsRoot();
    await safeCleanupDir(artifactsDir, { allowRoots: [root] });
  }

  if (config.isolation) {
    process.exitCode = await runIsolationLive({ config, transport, artifactsDir });
    return;
  }

  if (config.start) {
    await ensureSession(transport, config.session, { readyTimeoutMs: config.readyTimeoutMs });
  }

  let result;
  try {
    result = await runStress({
      config,
      deps: createLiveDeps(transport, { readyTimeoutMs: config.readyTimeoutMs }),
    });
  } catch (error) {
    console.error(`ccb-stress: live run failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  const report = formatReport({
    config,
    verdict: result.verdict,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    artifactsDir,
  });
  await fs.writeFile(
    path.join(artifactsDir, "verdict.json"),
    `${JSON.stringify(
      {
        config,
        verdict: result.verdict,
        observation: result.observation ?? result.verdict.observation ?? null,
        deliveryFailures: result.deliveryFailures.length,
        observedCount: result.observedIds.length,
        startedAt: new Date(result.startedAt).toISOString(),
        endedAt: new Date(result.endedAt).toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(path.join(artifactsDir, "report.txt"), `${report}\n`);

  console.log(report);
  console.log(`\nartifacts: ${artifactsDir}`);
  process.exitCode = result.verdict.ok ? 0 : 1;
}

// Live 3-session isolation: concurrently drive every named session, then verify
// no foreign token appears in any pane. npm test never reaches this path.
async function runIsolationLive({ config, transport, artifactsDir }) {
  const plan = buildMultiSessionPlan({
    sessions: config.sessions,
    trialsPerSession: config.trialsPerSession,
    idPrefix: config.idPrefix,
  });
  if (config.start) {
    for (const session of config.sessions) {
      await ensureSession(transport, session, { readyTimeoutMs: config.readyTimeoutMs });
    }
  }
  const deps = createLiveDeps(transport, { readyTimeoutMs: config.readyTimeoutMs });
  let result;
  try {
    result = await runMultiSessionIsolation({
      plan,
      deps,
      captureLines: config.captureLines,
      sleepMs: config.sleepMs ?? 0,
    });
  } catch (error) {
    console.error(`ccb-stress: isolation run failed: ${error.message}`);
    return 1;
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  const lines = [
    `ISOLATION ${result.ok ? "PASS" : "FAIL"}`,
    `platform: ${process.platform}`,
    `sessions: ${config.sessions.join(", ")}`,
    `trialsPerSession: ${config.trialsPerSession}`,
  ];
  for (const entry of result.perSession) {
    const v = entry.verdict;
    lines.push(
      `  ${entry.session}: ok=${v.ok} lost=${v.lost.length} extra=${v.extra.length} dup=${v.duplicates.length} reordered=${v.reordered} undelivered=${(v.undelivered ?? []).length}`,
    );
    const detail = formatFailureReport(v);
    if (detail) lines.push(detail);
  }
  const report = lines.join("\n");
  await fs.writeFile(
    path.join(artifactsDir, "verdict.json"),
    `${JSON.stringify({ config, perSession: result.perSession, ok: result.ok }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(artifactsDir, "report.txt"), `${report}\n`);
  console.log(report);
  console.log(`\nartifacts: ${artifactsDir}`);
  return result.ok ? 0 : 1;
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
