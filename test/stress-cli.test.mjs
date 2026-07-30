// Subprocess coverage for the opt-in live harness entrypoint.
//
// Dry-run (the default) must build a plan and exit 0 without launching Claude.
// Live mode must be gated behind --live --yes and reject bad usage with exit 2.
// These spawn the real script so the argv surface and opt-in gate are honest.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { createLiveDeps } from "../bin/ccb-stress.mjs";

const SCRIPT = path.resolve("bin/ccb-stress.mjs");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("dry-run prints the plan and exits 0 without launching Claude", () => {
  const result = run(["--trials", "5", "--session", "ccb-dry"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 trials/);
  assert.match(result.stdout, /session=ccb-dry/);
  assert.match(result.stdout, /--live --yes/);
});

test("bare invocation defaults to dry-run and never claims live mode", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /launching|live run/i);
});

test("live mode without --yes exits 2 and explains the gate", () => {
  const result = run(["--trials", "3", "--session", "ccb-x", "--live"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--yes|confirm/i);
});

test("bad trial count exits 2", () => {
  const result = run(["--trials", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /trials|positive/i);
});

test("isolation dry-run prints a 3-session plan without launching Claude", () => {
  const result = run([
    "--isolation",
    "--sessions",
    "iso-a,iso-b,iso-c",
    "--trials",
    "3",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolation/i);
  assert.match(result.stdout, /3 sessions/);
  for (const s of ["iso-a", "iso-b", "iso-c"]) {
    assert.match(result.stdout, new RegExp(s));
  }
});

test("isolation live mode is gated behind --live --yes", () => {
  const result = run(["--isolation", "--sessions", "a,b,c", "--live"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--yes|confirm/i);
});

test("an unsafe id-prefix is rejected at the CLI surface", () => {
  const result = run(["--id-prefix", "bad|prefix"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /id-prefix|invalid/i);
});

test("createLiveDeps wires a between-trials sleep so --sleep-ms pauses", () => {
  // Regression: createLiveDeps used to return no sleep, so --sleep-ms was
  // silently ignored in live mode (the harness driver only pauses when
  // deps.sleep exists). The live driver must now provide one.
  const deps = createLiveDeps({}, { readyTimeoutMs: 1000 });
  assert.equal(typeof deps.sleep, "function");
});
