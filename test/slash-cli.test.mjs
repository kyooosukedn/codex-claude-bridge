// Subprocess-level CLI regression coverage for `ccb slash` (P1 slice 1 rework).
//
// Spawns the REAL binary and asserts on process exit codes + stdout JSON + the
// fail-fast side-effect ordering. `ccmux` is PATH-stubbable cross-platform (it
// is not shadowed by the MSYS tmux prepend), so these tests run on Windows and
// Linux. Paths that require stubbing `tmux` (enterText) are covered by the
// handler-level suite (test/slash-handler.test.mjs) since MSYS shadows a
// PATH-stubbed tmux on Windows.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/codex-claude-bridge.mjs", import.meta.url));
const IS_WIN = process.platform === "win32";

// Build a temp bin dir containing a `ccmux` stub that fails `capture` (exit 1)
// and logs every invocation to CCB_STUB_LOG. Returns { dir, logPath, env }.
function makeCcmuxStub({ captureFails = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccb-cli-"));
  const logPath = join(dir, "ccmux-calls.log");
  const stubScript = join(dir, "ccmux-stub.mjs");
  writeFileSync(
    stubScript,
    `import { appendFileSync } from "node:fs";\n` +
      `const args = process.argv.slice(2);\n` +
      `const log = process.env.CCB_STUB_LOG;\n` +
      `if (log && args[0]) appendFileSync(log, args.join(" ") + "\\n");\n` +
      `if (args[0] === "capture" && ${JSON.stringify(captureFails)}) process.exit(1);\n` +
      `process.exit(0);\n`,
  );
  if (IS_WIN) {
    const packageRoot = join(dir, "node_modules", "claude-code-tmux");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ bin: { ccmux: "ccmux-stub.mjs" } }),
    );
    writeFileSync(
      join(packageRoot, "ccmux-stub.mjs"),
      readFileSync(stubScript, "utf8"),
    );
    writeFileSync(
      join(dir, "ccmux.cmd"),
      "@echo off\r\nnode \"%~dp0ccmux-stub.mjs\" %*\r\n",
    );
  } else {
    const shim = join(dir, "ccmux");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec node "${stubScript}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  const pathVar = IS_WIN ? "Path" : "PATH";
  const origPath = process.env[pathVar] || process.env.PATH || "";
  const env = {
    CCB_STUB_LOG: logPath,
    CCB_HOME: join(dir, "ccb-home"),
    [pathVar]: `${dir}${IS_WIN ? ";" : ":"}${origPath}`,
    PATH: `${dir}${IS_WIN ? ";" : ":"}${origPath}`,
  };
  return { dir, logPath, env };
}

function runCcb(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function readLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

test("cli: invalid --ready-timeout-ms exits 2 BEFORE any ccmux side effect", () => {
  const { logPath, env } = makeCcmuxStub();
  const r = runCcb(["slash", "--ready-timeout-ms", "abc", "/help"], env);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /ready-timeout-ms must be a positive integer/);
  assert.equal(readLog(logPath), "", "no ccmux call may happen before flag validation");
});

test("cli: invalid send --timeout-ms exits 2 before session startup", () => {
  const { logPath, env } = makeCcmuxStub();
  const r = runCcb(["send", "--timeout-ms", "NaN", "work"], env);

  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /--timeout-ms .*positive integer/);
  assert.equal(readLog(logPath), "", "no ccmux call may happen before flag validation");
});

test("cli: invalid send --settle-ms exits 2 before session startup", () => {
  const { logPath, env } = makeCcmuxStub();
  const r = runCcb(["send", "--settle-ms", "0", "work"], env);

  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /--settle-ms .*positive integer/);
  assert.equal(readLog(logPath), "", "no ccmux call may happen before flag validation");
});

test("cli: missing slash text exits 1", () => {
  const r = runCcb(["slash"]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.match(r.stderr, /slash requires command/);
});

test("cli: zero --ready-timeout-ms exits 2 before delivery", () => {
  const { logPath, env } = makeCcmuxStub();
  const r = runCcb(["slash", "--ready-timeout-ms", "0", "/help"], env);
  assert.equal(r.status, 2);
  assert.equal(readLog(logPath), "", "no ccmux call before flag validation");
});

test("cli: baseline capture failure -> exit 7, telemetry, NO injection, capture attempted", () => {
  const { logPath, env } = makeCcmuxStub({ captureFails: true });
  const r = runCcb(["slash", "/x"], env);
  assert.equal(r.status, 7, `expected exit 7, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.readiness.ready, false);
  assert.equal(body.readiness.reason, "baseline-capture-failed");
  assert.equal(body.injectedAt, undefined, "nothing injected -> no injectedAt");
  assert.equal(body.command, "/x");
  // Baseline capture WAS attempted (fail-closed: we tried, it failed, we stopped).
  assert.match(readLog(logPath), /\bcapture\b/);
});

test("cli: --help still exits 0 (wiring not broken)", () => {
  const r = runCcb(["--help"]);
  assert.equal(r.status, 0);
});
