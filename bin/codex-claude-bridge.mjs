#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SESSION = "codex-claude";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_STARTUP_WAIT_MS = 12000;
const DEFAULT_READY_TIMEOUT_MS = 45000;
const MSYS_BIN = "C:\\msys64\\usr\\bin";
const BOOLEAN_FLAGS = new Set([
  "enter",
  "json",
  "remote-control",
  "safe-permissions",
]);

function printHelp() {
  console.log(`codex-claude-bridge

Usage:
  ccb doctor [--json]
  ccb patch-ccmux-windows

  ccb start [--session NAME] [--cwd DIR] [--model MODEL] [--effort LEVEL] [--safe-permissions]
  ccb send [--session NAME] [--cwd DIR] [--timeout-ms MS] [--startup-wait-ms MS] "prompt"
  ccb type [--session NAME] [--enter] "raw message"
  ccb slash [--session NAME] "command"
  ccb steer [--session NAME] "message"

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

function run(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: envWithTmux(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio || "pipe",
  });
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
  const result = run(command, args);
  return {
    ok: result.status === 0,
    command,
    output: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "",
  };
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

function stripAnsi(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
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
  const tmpDir = path.join(os.tmpdir(), "codex-claude-bridge");
  mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${randomUUID()}.txt`);
  writeFileSync(file, text);
  try {
    tmux(["load-buffer", msysPathForShell(file)]);
    tmux(["paste-buffer", "-p", "-t", target]);
    if (enter) tmux(["send-keys", "-t", target, "Enter"]);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // Best effort cleanup.
    }
  }
  return { session, tmuxSession: target, entered: enter, bytes: Buffer.byteLength(text) };
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

  if (!src.includes('if (process.platform === "win32") break;')) {
    src = src.replace(
      /tmux\(\["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job\.tmuxSession\]\);\r?\n\s*sleepSync\(pasteDelayMs\);/g,
      'tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job.tmuxSession]);\n    sleepSync(pasteDelayMs);\n    if (process.platform === "win32") break;',
    );
  }

  src = src.replace(
    /const command = argv\.map\(shellQuote\)\.join\(" "\);\r?\n\s*return process\.platform === "win32" \? `& \$\{command\}` : command;/g,
    `const command = argv.map(shellQuote).join(" ");
  if (process.platform === "win32") {
    const cwdPrefix = options.cwd ? \`Set-Location -LiteralPath \${shellQuote(options.cwd)}; \` : "";
    const authPrefix = "Get-ChildItem Env:ANTHROPIC* | Remove-Item -ErrorAction SilentlyContinue; ";
    return \`\${authPrefix}\${cwdPrefix}& \${command}\`;
  }
  return command;`,
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

async function main() {
  const { command, opts } = parse(process.argv.slice(2));
  const session = safeName(opts.session || opts.name || DEFAULT_SESSION);
  const cwd = path.resolve(String(opts.cwd || process.cwd()));

  if (command === "help") return printHelp();
  if (command === "doctor") return doctor(Boolean(opts.json));
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
    ensureSession({
      session,
      cwd,
      opts,
      startupWaitMs: Number(opts["startup-wait-ms"] || DEFAULT_STARTUP_WAIT_MS),
    });
    const timeout = String(opts["timeout-ms"] || DEFAULT_TIMEOUT_MS);
    const args = ["send", "--session", session, "--wait", "--timeout-ms", timeout];
    if (opts["settle-ms"]) args.push("--settle-ms", String(opts["settle-ms"]));
    args.push(prompt);
    process.stdout.write(must("ccmux", args));
    return;
  }
  if (command === "type") {
    const text = opts._.join(" ");
    if (!text) throw new Error("type requires text");
    console.log(JSON.stringify(enterText(session, text, Boolean(opts.enter)), null, 2));
    return;
  }
  if (command === "slash") {
    const slash = opts._.join(" ").trim();
    if (!slash) throw new Error("slash requires command");
    const text = slash.startsWith("/") ? slash : `/${slash}`;
    console.log(JSON.stringify(enterText(session, text, true), null, 2));
    return;
  }
  if (command === "steer") {
    const message = opts._.join(" ").trim();
    if (!message) throw new Error("steer requires message");
    process.stdout.write(must("ccmux", ["steer", "--session", session, message]));
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

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
