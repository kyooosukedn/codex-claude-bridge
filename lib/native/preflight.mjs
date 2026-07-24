// lib/native/preflight.mjs
// Version checks and feature gate for R0/R1. Does NOT assume any package manager.
// Records the result to ~/.pi/ccb-broker/preflight.json so the operator's
// upgrade can be tracked across runs.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

/** @type {readonly [number, number, number]} */
const TARGET_CLAUDE = [2, 1, 212];
const TARGET_NODE_MAJOR = 22;
const TARGET_NODE_MINOR = 13;
const PREFLIGHT_LOG = path.join(
  process.env.CCB_HOME || path.join(os.homedir(), ".pi", "ccb-broker"),
  "preflight.json",
);

/**
 * @param {string} raw
 * @returns {readonly [number, number, number] | null}
 */
export function parseClaudeVersion(raw) {
  const m = String(raw).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * @param {readonly [number, number, number]} a
 * @param {readonly [number, number, number]} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * @returns {readonly [number, number]}
 */
export function nodeVersionTuple() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return [major, minor];
}

/**
 * @returns {string | null}
 */
export function claudeVersionRaw() {
  try {
    const r = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 10000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * @param {{ claudeRaw: string | null, nodeRaw: string }} input
 * @returns {{ claude: { raw: string | null, parsed: readonly [number,number,number] | null, target: string, ok: boolean }, node: { raw: string, parsed: readonly [number,number], target: string, ok: boolean }, blockers: string[], allOk: boolean }}
 */
export function evaluateVersions({ claudeRaw, nodeRaw }) {
  const claudeParsed = claudeRaw ? parseClaudeVersion(claudeRaw) : null;
  const nodeParsed = (/** @returns {readonly [number, number]} */ () => {
    const [maj, min] = String(nodeRaw).split(".").map(Number);
    return [maj || 0, min || 0];
  })();
  const claudeOk = claudeParsed ? compareVersions(claudeParsed, TARGET_CLAUDE) >= 0 : false;
  const nodeOk =
    nodeParsed[0] > TARGET_NODE_MAJOR ||
    (nodeParsed[0] === TARGET_NODE_MAJOR && nodeParsed[1] >= TARGET_NODE_MINOR);

  /** @type {string[]} */
  const blockers = [];
  if (!claudeOk) {
    blockers.push(
      `Claude ${claudeParsed ? claudeParsed.join(".") : "(unparseable)"} is below target ` +
        `${TARGET_CLAUDE.join(".")} (structured waitingFor requires >= ${TARGET_CLAUDE.join(".")}). ` +
        `Upgrade Claude using your normal installation method, then re-run preflight.`,
    );
  }
  if (!nodeOk) {
    blockers.push(
      `Node ${nodeParsed.join(".")} is below target ${TARGET_NODE_MAJOR}.${TARGET_NODE_MINOR} ` +
        `(node:sqlite stable requires >= ${TARGET_NODE_MAJOR}.${TARGET_NODE_MINOR} in later phases). ` +
        `Upgrade Node using your normal installation method, then re-run preflight.`,
    );
  }

  return {
    claude: {
      raw: claudeRaw,
      parsed: claudeParsed,
      target: TARGET_CLAUDE.join("."),
      ok: claudeOk,
    },
    node: {
      raw: nodeRaw,
      parsed: nodeParsed,
      target: `${TARGET_NODE_MAJOR}.${TARGET_NODE_MINOR}`,
      ok: nodeOk,
    },
    blockers,
    allOk: claudeOk && nodeOk,
  };
}

/**
 * @param {{ blockers: string[], allOk: boolean }} result
 * @returns {string}
 */
export function formatBlockers(result) {
  if (result.allOk) return "All version requirements met.";
  return result.blockers.join("\n");
}

/**
 * @param {ReturnType<typeof evaluateVersions>} evaluated
 * @returns {Object}
 */
export function recordPreflight(evaluated) {
  mkdirSync(path.dirname(PREFLIGHT_LOG), { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    ...evaluated,
  };
  writeFileSync(PREFLIGHT_LOG, JSON.stringify(entry, null, 2));
  return entry;
}

/**
 * @returns {Object | null}
 */
export function readLastPreflight() {
  if (!existsSync(PREFLIGHT_LOG)) return null;
  try {
    return JSON.parse(readFileSync(PREFLIGHT_LOG, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Run the full preflight: probe versions, evaluate, record, return.
 * @returns {ReturnType<typeof evaluateVersions>}
 */
export function preflight() {
  const evaluated = evaluateVersions({
    claudeRaw: claudeVersionRaw(),
    nodeRaw: process.versions.node,
  });
  recordPreflight(evaluated);
  return evaluated;
}

// CLI entry point: `node lib/native/preflight.mjs [--json]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = process.argv.includes("--json");
  const result = preflight();
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.allOk) {
      console.log(`ok  Claude ${result.claude.parsed?.join(".")} >= ${result.claude.target}`);
      console.log(`ok  Node ${result.node.parsed.join(".")} >= ${result.node.target}`);
    } else {
      console.error(formatBlockers(result));
      process.exit(1);
    }
  }
}
