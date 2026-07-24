// test/native-adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentsJson,
  findAgentByName,
  buildStartArgs,
  resolveClaudeExecutable,
} from "../lib/native/adapter.mjs";

test("parseAgentsJson parses a working agent", () => {
  const raw = JSON.stringify([
    { id: "a1", name: "spike-1", status: "working", cwd: "/repo" },
  ]);
  const agents = parseAgentsJson(raw);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "spike-1");
  assert.equal(agents[0].status, "working");
});

test("parseAgentsJson throws on invalid JSON", () => {
  assert.throws(() => parseAgentsJson("not json"), /JSON/);
});

test("parseAgentsJson throws on non-array", () => {
  assert.throws(() => parseAgentsJson('{"not": "an array"}'), /array/i);
});

test("findAgentByName returns matching agent", () => {
  const agents = [
    { name: "spike-1", status: "idle" },
    { name: "spike-2", status: "thinking" },
  ];
  const found = findAgentByName(agents, "spike-2");
  assert.equal(found?.status, "thinking");
});

test("findAgentByName returns null when not found", () => {
  const agents = [{ name: "spike-1" }];
  assert.equal(findAgentByName(agents, "nope"), null);
});

test("findAgentByName prefers newest active duplicate", () => {
  const agents = [
    { id: "old", name: "spike-1", state: "stopped", startedAt: 100 },
    { id: "new", name: "spike-1", state: "blocked", startedAt: 200 },
  ];
  assert.equal(findAgentByName(agents, "spike-1")?.id, "new");
});

test("findAgentByName returns newest duplicate when all are stopped", () => {
  const agents = [
    { id: "old", name: "spike-1", state: "stopped", startedAt: 100 },
    { id: "new", name: "spike-1", state: "stopped", startedAt: 200 },
  ];
  assert.equal(findAgentByName(agents, "spike-1")?.id, "new");
});

test("buildStartArgs constructs explicit development-channel launch", () => {
  const args = buildStartArgs({
    name: "spike-1",
    configPath: "C:/temp/spike/.mcp.json",
  });
  assert.deepEqual(args, [
    "--bg",
    "--name",
    "spike-1",
    "--mcp-config",
    "C:/temp/spike/.mcp.json",
    "--strict-mcp-config",
    "--dangerously-load-development-channels",
    "server:ccb-channel-server",
  ]);
});

test("buildStartArgs includes model and effort when provided", () => {
  const args = buildStartArgs({
    name: "spike-1",
    configPath: "C:/temp/spike/.mcp.json",
    model: "opus",
    effort: "high",
  });
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("opus"));
  assert.ok(args.includes("--effort"));
  assert.ok(args.includes("high"));
  assert.ok(!args.includes("--cwd"));
  assert.ok(!args.includes("--safe-permissions"));
});

test("buildStartArgs can start a native session without a channel", () => {
  assert.deepEqual(buildStartArgs({ name: "state-only" }), [
    "--bg",
    "--name",
    "state-only",
  ]);
});

test("resolveClaudeExecutable honors explicit override", () => {
  assert.equal(
    resolveClaudeExecutable({
      platform: "win32",
      env: { CCB_CLAUDE_PATH: "D:\\tools\\claude.exe" },
      exists: () => false,
    }),
    "D:\\tools\\claude.exe",
  );
});

test("resolveClaudeExecutable finds npm-installed native Windows binary", () => {
  const expected = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  assert.equal(
    resolveClaudeExecutable({
      platform: "win32",
      env: { PATH: "C:\\npm;D:\\bin" },
      exists: (candidate) => candidate === expected,
    }),
    expected,
  );
});

test("resolveClaudeExecutable uses PATH lookup on non-Windows platforms", () => {
  assert.equal(
    resolveClaudeExecutable({ platform: "linux", env: {}, exists: () => false }),
    "claude",
  );
});
