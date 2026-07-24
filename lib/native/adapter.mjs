// lib/native/adapter.mjs
// Dependency-free wrapper around native `claude` subcommands. Pure helpers
// are unit-tested; spawn wrappers are exercised by live smoke in Phase 3.

import { spawnSync } from "node:child_process";

const SHELL = process.platform === "win32";

/**
 * @param {string} raw
 * @returns {Array<{ id?: string, name?: string, state?: string, status?: string, waitingFor?: string, cwd?: string, model?: string, startedAt?: number }>}
 */
export function parseAgentsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    throw new Error(`agents JSON parse failed: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("agents JSON must be an array of agent objects");
  }
  return parsed;
}

/**
 * @param {Array<{ name?: string, state?: string, status?: string, startedAt?: number }>} agents
 * @param {string} name
 */
export function findAgentByName(agents, name) {
  const matches = agents.filter((agent) => agent.name === name);
  if (matches.length === 0) return null;

  const terminalStates = new Set(["stopped", "done", "failed"]);
  const active = matches.filter(
    (agent) =>
      !terminalStates.has(agent.state) &&
      !terminalStates.has(agent.status),
  );
  const candidates = active.length > 0 ? active : matches;
  return candidates.reduce((latest, candidate) =>
    (candidate.startedAt ?? 0) > (latest.startedAt ?? 0) ? candidate : latest,
  );
}

/**
 * @param {{ name: string, configPath?: string, model?: string, effort?: string }} opts
 * @returns {string[]}
 */
export function buildStartArgs({ name, configPath, model, effort }) {
  const args = ["--bg", "--name", name];
  if (configPath) {
    args.push(
      "--mcp-config",
      configPath,
      "--strict-mcp-config",
      "--dangerously-load-development-channels",
      "server:ccb-channel-server",
    );
  }
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Object, timeoutMs?: number }} [opts]
 * @returns {string}
 */
function runClaude(args, opts = {}) {
  const r = spawnSync("claude", args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs ?? 30000,
    shell: SHELL,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `claude ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return r.stdout ?? "";
}

/**
 * @returns {Array<{ id?: string, name?: string, state?: string, status?: string, waitingFor?: string, cwd?: string, model?: string, startedAt?: number }>}
 */
export function agentsJson() {
  return parseAgentsJson(runClaude(["agents", "--json", "--all"]));
}

/**
 * `cwd` is a child-process option, not a top-level Claude CLI flag.
 * @param {{ name: string, cwd: string, configPath?: string, model?: string, effort?: string }} opts
 * @returns {string}
 */
export function startBackground(opts) {
  return runClaude(buildStartArgs(opts), { cwd: opts.cwd });
}

/**
 * @param {string} id
 * @returns {string}
 */
export function respawn(id) {
  return runClaude(["respawn", id]);
}

/**
 * @param {string} id
 * @returns {string}
 */
export function stopAgent(id) {
  return runClaude(["stop", id]);
}

/**
 * @param {string} id
 * @returns {string}
 */
export function rmAgent(id) {
  return runClaude(["rm", id]);
}

/**
 * @param {string} id
 * @returns {string}
 */
export function logs(id) {
  return runClaude(["logs", id]);
}

/**
 * Attach is interactive. This wrapper inherits stdio for manual use.
 * @param {string} id
 * @param {{ cwd?: string, env?: Object }} [opts]
 */
export function attachInteractive(id, opts = {}) {
  const r = spawnSync("claude", ["attach", id], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: "inherit",
    shell: SHELL,
  });
  if (r.status !== 0) {
    throw new Error(`claude attach ${id} exited ${r.status}`);
  }
}
