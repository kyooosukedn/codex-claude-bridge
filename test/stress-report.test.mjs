// Verdict reporting, safe artifact cleanup, and the runStress driver.
//
// runStress orchestrates slash-then-prompt trials through injected deps so the
// 100-trial loop can be verified deterministically here (fakes) and driven live
// from bin/ccb-stress.mjs (real Claude). Report + cleanup are pure / fs-only
// and run on Windows and POSIX under `npm test`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeVerdict,
  formatFailureReport,
  formatReport,
  runStress,
  safeCleanupDir,
} from "../lib/stress-harness.mjs";

const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// runStress — deterministic fakes prove the trial loop wiring.
// ---------------------------------------------------------------------------

function fakeDeps({ drop = [], dup = [], reorder = false } = {}) {
  const ids = [];
  return {
    slash: async () => ({ exitCode: 0 }),
    send: async (_session, promptText) => {
      const match = promptText.match(/CCBSTRESS-\d+/);
      if (match) ids.push(match[0]);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async () => {
      let out = [...ids];
      if (reorder) out = [...out].reverse();
      out = out.filter((id) => !drop.includes(id));
      for (const id of dup) out.push(id);
      return out.join("\n");
    },
    sleep: async () => {},
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  };
}

test("runStress with a clean fake run reports zero loss/dup/reorder", async () => {
  const result = await runStress({
    config: { mode: "dry-run", trials: 100, session: "ccb-x", idPrefix: "CCBSTRESS", slashCommand: "/model default" },
    deps: fakeDeps(),
  });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.expectedCount, 100);
  assert.equal(result.verdict.matchedCount, 100);
  assert.equal(result.trialResults.length, 100);
});

test("runStress detects a dropped prompt", async () => {
  const result = await runStress({
    config: { mode: "dry-run", trials: 5, session: "ccb-x", idPrefix: "CCBSTRESS", slashCommand: "/x" },
    deps: fakeDeps({ drop: ["CCBSTRESS-003"] }),
  });
  assert.equal(result.verdict.ok, false);
  assert.deepEqual(result.verdict.lost, ["CCBSTRESS-003"]);
});

test("runStress detects reordered delivery", async () => {
  // Streaming-realistic reorder: token 001 is rendered late (only after 002
  // appears), so 002 is first-seen before 001. A reversed final scrollback no
  // longer models reorder under accumulated first-seen observation.
  const delivered = [];
  const deps = {
    slash: async () => ({ exitCode: 0 }),
    send: async (_session, promptText) => {
      const m = promptText.match(/CCBSTRESS-\d+/);
      if (m) delivered.push(m[0]);
      return { exitCode: 0, body: { status: "done" } };
    },
    capture: async () => {
      const view = delivered.filter((t) => t !== "CCBSTRESS-001");
      if (delivered.includes("CCBSTRESS-002")) view.push("CCBSTRESS-001");
      return view.join("\n");
    },
    sleep: async () => {},
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  };
  const result = await runStress({
    config: { mode: "dry-run", trials: 4, session: "ccb-x", idPrefix: "CCBSTRESS", slashCommand: "/x" },
    deps,
  });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.reordered, true);
});

test("runStress records delivery failures without throwing", async () => {
  const deps = fakeDeps();
  let sendCalls = 0;
  deps.send = async () => { sendCalls += 1; return { exitCode: 9 }; };
  const result = await runStress({
    config: { mode: "dry-run", trials: 3, session: "ccb-x", idPrefix: "CCBSTRESS", slashCommand: "/x" },
    deps,
  });
  // Fail-fast: first send fails, the session stops, so only one trial attempted.
  assert.equal(sendCalls, 1);
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.undelivered.length, 1);
  assert.ok(result.verdict.lost.includes("CCBSTRESS-002"));
});

// ---------------------------------------------------------------------------
// Report formatting — platform-aware, deterministic.
// ---------------------------------------------------------------------------

test("formatReport renders pass/fail, platform, counts, and artifacts path", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001"],
    observedIds: ["CCBSTRESS-001"],
  });
  const report = formatReport({
    config: { mode: "live", trials: 1, session: "ccb-x", idPrefix: "CCBSTRESS" },
    verdict,
    startedAt: new Date("2026-07-30T00:00:00.000Z"),
    endedAt: new Date("2026-07-30T00:01:00.000Z"),
    artifactsDir: path.join(os.tmpdir(), "ccb-stress-artifacts"),
  });
  assert.match(report, /PASS/);
  assert.match(report, new RegExp(`platform: ${process.platform}`));
  assert.match(report, /trials: 1/);
  assert.match(report, /lost 0/);
  assert.ok(report.includes(path.join(os.tmpdir(), "ccb-stress-artifacts")));
});

test("formatReport shows FAIL on a non-ok verdict", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002"],
    observedIds: ["CCBSTRESS-001"],
  });
  const report = formatReport({
    config: { mode: "live", trials: 2, session: "ccb-x", idPrefix: "CCBSTRESS" },
    verdict,
    startedAt: new Date("2026-07-30T00:00:00.000Z"),
    endedAt: new Date("2026-07-30T00:01:00.000Z"),
    artifactsDir: "/tmp/x",
  });
  assert.match(report, /FAIL/);
  assert.match(report, /lost 1/);
});

test("formatFailureReport lists lost, duplicate, and reordered ids", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001", "CCBSTRESS-002", "CCBSTRESS-003"],
    observedIds: ["CCBSTRESS-002", "CCBSTRESS-001", "CCBSTRESS-002"],
  });
  const text = formatFailureReport(verdict);
  assert.match(text, /CCBSTRESS-003/); // lost
  assert.match(text, /CCBSTRESS-002.*x2|x2.*CCBSTRESS-002/); // duplicate
  assert.match(text, /reorder/i);
});

test("formatFailureReport is terse when the verdict is ok", () => {
  const verdict = computeVerdict({
    expectedIds: ["CCBSTRESS-001"],
    observedIds: ["CCBSTRESS-001"],
  });
  const text = formatFailureReport(verdict);
  assert.equal(text.trim(), "");
});

// ---------------------------------------------------------------------------
// Safe artifact cleanup — refuses traversal, only removes under allowed roots.
// ---------------------------------------------------------------------------

test("safeCleanupDir removes a dir nested under an allowed root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "artifacts");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "x.json"), "{}");
  const result = await safeCleanupDir(target, { allowRoots: [root] });
  assert.equal(result.removed, true);
  await assert.rejects(fs.stat(target));
});

test("safeCleanupDir refuses a target outside every allowed root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-cleanup-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-cleanup-other-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const result = await safeCleanupDir(other, { allowRoots: [root] });
  assert.equal(result.removed, false);
  assert.match(result.reason, /outside|not allowed|refused/i);
  // untouched
  await fs.stat(other);
});

test("safeCleanupDir refuses a missing target without throwing", async () => {
  const result = await safeCleanupDir(path.join(os.tmpdir(), "ccb-nonexistent-zzz"), {
    allowRoots: [os.tmpdir()],
  });
  assert.equal(result.removed, false);
});
