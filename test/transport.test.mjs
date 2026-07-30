import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createTransport,
  resolveTransportCommand,
} from "../lib/transport.mjs";

const PAYLOAD = 'hello & echo PWNED | whoami ; $(touch /tmp/pwned) "quoted"';

test("Windows ccmux resolves through node and preserves prompt as one argv item", () => {
  const calls = [];
  const packageJson =
    "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\claude-code-tmux\\package.json";
  const entry =
    "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\claude-code-tmux\\bin\\ccmux.mjs";
  const transport = createTransport({
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    env: {
      Path: "C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Windows\\System32",
    },
    existsSync: (candidate) =>
      candidate === packageJson ||
      candidate === "C:\\Users\\test\\AppData\\Roaming\\npm\\ccmux.cmd",
    readFileSync: (candidate) => {
      assert.equal(candidate, packageJson);
      return JSON.stringify({ bin: { ccmux: "bin/ccmux.mjs" } });
    },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  transport.run("ccmux", ["send", "--session", "alpha", PAYLOAD]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(calls[0].args, [
    entry,
    "send",
    "--session",
    "alpha",
    PAYLOAD,
  ]);
  assert.equal(calls[0].args.at(-1), PAYLOAD);
  assert.equal(calls[0].options.shell, false);
});

test("Windows tmux resolves the real executable instead of a shell shim", () => {
  const resolved = resolveTransportCommand("tmux", {
    platform: "win32",
    env: { Path: "C:\\msys64\\usr\\bin;C:\\Windows" },
    existsSync: (candidate) =>
      candidate.toLowerCase() ===
      "c:\\msys64\\usr\\bin\\tmux.exe",
    readFileSync: () => {
      throw new Error("unexpected package read");
    },
    execPath: process.execPath,
    pathApi: path.win32,
  });

  assert.deepEqual(resolved, {
    command: "C:\\msys64\\usr\\bin\\tmux.exe",
    prefixArgs: [],
  });
});

test("Windows Claude JS bins resolve through node", () => {
  const packageJson =
    "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json";
  const resolved = resolveTransportCommand("claude", {
    platform: "win32",
    env: { Path: "C:\\npm" },
    existsSync: (candidate) => candidate === packageJson,
    readFileSync: () =>
      JSON.stringify({ bin: { claude: "bin/claude.js" } }),
    execPath: "C:\\node\\node.exe",
    pathApi: path.win32,
  });

  assert.deepEqual(resolved, {
    command: "C:\\node\\node.exe",
    prefixArgs: [
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js",
    ],
  });
});

test("POSIX commands are invoked directly without a shell", () => {
  const calls = [];
  const transport = createTransport({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  transport.run("ccmux", ["send", PAYLOAD]);

  assert.deepEqual(calls[0].args, ["send", PAYLOAD]);
  assert.equal(calls[0].command, "ccmux");
  assert.equal(calls[0].options.shell, false);
});

test("transport forwards stdin payloads without putting them in argv", () => {
  const calls = [];
  const transport = createTransport({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  transport.run("tmux", ["load-buffer", "-"], { input: PAYLOAD });

  assert.deepEqual(calls[0].args, ["load-buffer", "-"]);
  assert.equal(calls[0].options.input, PAYLOAD);
  assert.equal(calls[0].options.shell, false);
});
