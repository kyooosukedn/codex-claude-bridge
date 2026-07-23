#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SESSION = "codex-claude";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_STARTUP_WAIT_MS = 12000;
const MSYS_BIN = "C:\\msys64\\usr\\bin";

function printHelp() {
  console.log(`codex-claude-bridge

Usage:
  ccb doctor [--json]
  ccb patch-ccmux-windows
  ccb start [--session NAME] [--cwd DIR]
  ccb send [--session NAME] [--cwd DIR] [--timeout-ms MS] [--startup-wait-ms MS] "prompt"
  ccb steer [--session NAME] "message"
  ccb capture [--session NAME] [--lines N]
  ccb status
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
    if (!args.length || args[0].startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = args.shift();
    }
  }
  return { command, opts };
}

function envWithTmux() {
  const env = { ...process.env };
  if (process.platform === "win32" && existsSync(path.join(MSYS_BIN, "tmux.exe"))) {
    const parts = String(env.Path || env.PATH || "").split(";");
    if (!parts.some((p) => p.toLowerCase() === MSYS_BIN.toLowerCase())) {
      env.Path = `${MSYS_BIN};${env.Path || env.PATH || ""}`;
    }
  }
  return env;
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: envWithTmux(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio || "pipe",
  });
  return result;
}

function must(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const msg = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(msg || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout || "";
}

function commandOk(command, args = ["--version"]) {
  const result = run(command, args);
  return {
    ok: result.status === 0,
    command,
    output: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "",
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ccmuxStatus() {
  const text = must("ccmux", ["status"]);
  return JSON.parse(text);
}

function sessionAlive(name) {
  try {
    const status = ccmuxStatus();
    return Boolean(status.sessions?.find((s) => s.name === name && s.alive));
  } catch {
    return false;
  }
}

function startSession({ session, cwd }) {
  const args = ["start", "--name", session, "--cwd", cwd, "--no-agents-md"];
  return must("ccmux", args);
}

function ensureSession({ session, cwd, startupWaitMs }) {
  if (!sessionAlive(session)) {
    startSession({ session, cwd });
    sleep(startupWaitMs);
  }
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

  if (src !== original) {
    writeFileSync(file, src);
  }

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
  const session = String(opts.session || opts.name || DEFAULT_SESSION);
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
  if (command === "start") {
    process.stdout.write(startSession({ session, cwd }));
    return;
  }
  if (command === "send") {
    const prompt = opts._.join(" ").trim();
    if (!prompt) throw new Error("send requires prompt");
    ensureSession({
      session,
      cwd,
      startupWaitMs: Number(opts["startup-wait-ms"] || DEFAULT_STARTUP_WAIT_MS),
    });
    const timeout = String(opts["timeout-ms"] || DEFAULT_TIMEOUT_MS);
    const args = ["send", "--session", session, "--wait", "--timeout-ms", timeout];
    if (opts["settle-ms"]) args.push("--settle-ms", String(opts["settle-ms"]));
    args.push(prompt);
    process.stdout.write(must("ccmux", args));
    return;
  }
  if (command === "steer") {
    const message = opts._.join(" ").trim();
    if (!message) throw new Error("steer requires message");
    process.stdout.write(must("ccmux", ["steer", "--session", session, message]));
    return;
  }
  if (command === "capture") {
    const lines = String(opts.lines || 120);
    process.stdout.write(must("ccmux", ["capture", "--session", session, "--lines", lines]));
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
