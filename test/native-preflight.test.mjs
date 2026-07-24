// test/native-preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  parseClaudeVersion,
  compareVersions,
  nodeVersionTuple,
  evaluateVersions,
  formatBlockers,
  preflight,
} from "../lib/native/preflight.mjs";

test("parseClaudeVersion extracts triple from '2.1.150 (Claude Code)'", () => {
  assert.deepEqual(parseClaudeVersion("2.1.150 (Claude Code)"), [2, 1, 150]);
});

test("parseClaudeVersion extracts triple from bare '2.1.212'", () => {
  assert.deepEqual(parseClaudeVersion("2.1.212"), [2, 1, 212]);
});

test("parseClaudeVersion returns null for unparseable input", () => {
  assert.equal(parseClaudeVersion("not a version"), null);
});

test("compareVersions: equal returns 0", () => {
  assert.equal(compareVersions([2, 1, 212], [2, 1, 212]), 0);
});

test("compareVersions: lower returns -1", () => {
  assert.equal(compareVersions([2, 1, 150], [2, 1, 212]), -1);
});

test("compareVersions: higher returns 1", () => {
  assert.equal(compareVersions([2, 2, 0], [2, 1, 212]), 1);
});

test("nodeVersionTuple returns [major, minor]", () => {
  const [major] = nodeVersionTuple();
  assert.ok(typeof major === "number");
  assert.ok(major >= 20);
});

test("evaluateVersions: both below target produces two blockers", () => {
  const result = evaluateVersions({
    claudeRaw: "2.1.150 (Claude Code)",
    nodeRaw: "22.12.0",
  });
  assert.equal(result.allOk, false);
  assert.equal(result.blockers.length, 2);
  assert.ok(result.blockers[0].includes("Claude"));
  assert.ok(result.blockers[1].includes("Node"));
});

test("evaluateVersions: both at target produces zero blockers", () => {
  const result = evaluateVersions({
    claudeRaw: "2.1.212 (Claude Code)",
    nodeRaw: "22.13.0",
  });
  assert.equal(result.allOk, true);
  assert.equal(result.blockers.length, 0);
});

test("formatBlockers: does not mention npm, apt, brew, or scoop", () => {
  const result = evaluateVersions({
    claudeRaw: "2.1.100",
    nodeRaw: "22.10.0",
  });
  const text = formatBlockers(result);
  assert.ok(!/npm install|apt install|brew install|scoop install/i.test(text),
    `blocker text must not assume a package manager; got: ${text}`);
});

test("module can be imported when process.argv[1] is absent", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./lib/native/preflight.mjs')"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("preflight returns its verdict when recording fails", () => {
  const result = preflight({
    claudeRaw: "2.1.218 (Claude Code)",
    nodeRaw: "22.23.1",
    record: () => {
      throw new Error("read-only preflight directory");
    },
  });
  assert.equal(result.allOk, true);
  assert.equal(result.recordError, "read-only preflight directory");
});
