# R0/R1 Native Channel Spike — Implementation Plan

**Spec:** [`docs/superpowers/specs/2026-07-23-native-control-plane-design.md`](../specs/2026-07-23-native-control-plane-design.md)
**Status:** Executed 2026-07-24. R1 complete; R0 is NO-GO on current GLM/API-billing authentication; R2+ blocked pending eligible Anthropic-authenticated rerun.
**Date:** 2026-07-24
**Scope:** R0 (channel feasibility spike, go/no-go) and R1 (native adapter + version preflight) from the approved spec. Nothing beyond.
**Current host:** Windows, Claude `2.1.218`, portable Node `22.23.1`.
**Target host:** latest stable Claude (`>= 2.1.212` for structured `waitingFor`), Node `>= 22.13` (for stable `node:sqlite` in later phases; R0/R1 itself only needs the system Node to run `node:test`).

## Scope

In scope (R0 + R1 from the spec):

- Environment and version upgrade gate (preflight). Reports exact blockers; does **not** assume package-manager commands.
- Pure native Claude adapter in `lib/native/` for version probing, capability probing, and `claude agents --json --all` parsing.
- Minimal custom `ccb-channel-server` spike under `spike/native-channel/`, using `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3`.
- Local authenticated probe-control endpoint for driving experiments and collecting forwarded notifications.
- Generated temporary MCP config/settings (no modification of the operator's project or global Claude config).
- Live experiments: consent flow, injection/reply, permission relay (approve + deny), native state / `waitingFor` mapping, logs/attach/stop/respawn conversation integrity.
- Evidence report and go/no-go decision.
- Spec update with observed behavior.

Out of scope (R2+):

- Broker daemon, Codex-facing MCP server, hook receiver, state machine, SQLite store, mutation queue, migration tooling, CLI transport flags.

## Directory layout

```
lib/native/
  preflight.mjs              # version checks, feature detection, upgrade blocker reporting
  adapter.mjs                # native CLI adapter: version, agents JSON, spawn/attach/stop/respawn/logs/rm
  state-map.mjs              # pure: native agent state -> broker state mapping
  types.mjs                  # shared JSDoc types

test/
  native-preflight.test.mjs  # node:test, dependency-free
  native-adapter.test.mjs    # node:test, dependency-free
  native-state-map.test.mjs  # node:test, dependency-free

spike/native-channel/
  package.json               # isolated: @modelcontextprotocol/sdk@1.29.0, zod@4.4.3
  .gitignore                 # node_modules/, tmp/, evidence/*.raw.json
  src/
    ccb-channel-server.mjs   # MCP stdio server spawned by Claude
    probe-control.mjs        # authenticated loopback HTTP endpoint
    probe-client.mjs         # client lib used by experiment scripts
    temp-config.mjs          # generates temp MCP settings
  experiments/
    run-01-consent.mjs
    run-02-injection.mjs
    run-03-permission.mjs
    run-04-state-map.mjs
    run-05-respawn.mjs
  evidence/
    01-consent-flow.md       # filled in during experiment
    02-injection-reply.md
    03-permission-relay.md
    04-native-state-mapping.md
    05-respawn-integrity.md
    go-no-go.md
  tmp/                       # generated configs (gitignored)

docs/superpowers/
  specs/2026-07-23-native-control-plane-design.md   # spec (already exists; updated in Phase 5)
  plans/2026-07-23-r0-r1-native-channel-spike.md    # this plan
```

## Success criteria (go/no-go)

R0 passes (go) if **all** of the following are observed and recorded:

1. A `claude --bg --name` session can be started with a temp MCP config that registers `ccb-channel-server`.
2. Channel consent (if any) is at most one interactive step per session and persists for the session lifetime. If consent is required every turn, or cannot be granted in `--bg` mode at all, it is a no-go.
3. `notifications/claude/channel` delivers an injected message into the session and the session's reply is forwarded back via the channel server's `reply` tool.
4. `notifications/claude/channel/permission_request` arrives at the probe-control endpoint with enough context to identify the request, and a verdict sent back via `notifications/claude/channel/permission` (with `request_id` + `allow`/`deny`) is honored by Claude for both approve and deny paths.
5. `claude agents --json --all` returns structured `status` and `waitingFor` fields that map cleanly to the broker states defined in the spec.
6. `claude respawn <id>` restores the session with conversation context intact (verified by a follow-up prompt that references the pre-respawn turn).

R0 fails (no-go) if **any** of the above cannot be achieved. On no-go, stop. Do not proceed to broker work (R2+). Write the no-go rationale into `evidence/go-no-go.md` and update the spec's remaining-uncertainty section.

R1 passes if:

7. `lib/native/adapter.mjs`, `lib/native/preflight.mjs`, and `lib/native/state-map.mjs` are implemented with `node:test` coverage for version parsing, agents JSON parsing, and state mapping.
8. `npm test` (V1 suite) still reports 44/44 with zero modifications to V1 files (`bin/codex-claude-bridge.mjs`, `lib/pane.mjs`, `lib/steer.mjs`, `test/pane.test.mjs`, `test/fixtures.mjs`).
9. A separate `npm run test:native` script runs the new native tests without affecting V1's `npm test`.

## Phase 0 — Preflight gate (environment and version)

Goal: detect whether the host meets R0/R1 requirements, report the exact blocker if not, and record the operator's upgrade. Do **not** assume `npm`, `apt`, `brew`, `scoop`, or any other package manager.

### Step 0.1 — Create `lib/native/types.mjs`

- [ ] Create `lib/native/types.mjs` with shared JSDoc type definitions used across the native modules.

```js
// lib/native/types.mjs
// Shared JSDoc types for lib/native/. No runtime exports; type-only.

/**
 * @typedef {readonly [number, number, number]} VersionTuple
 */

/**
 * @typedef {Object} PreflightResult
 * @property {string} timestamp
 * @property {string} platform
 * @property {{ raw: string, parsed: VersionTuple | null, target: string, ok: boolean }} claude
 * @property {{ raw: string, parsed: readonly [number, number], target: string, ok: boolean }} node
 * @property {string[]} blockers
 * @property {boolean} allOk
 */

/**
 * @typedef {Object} NativeAgent
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [state]
 * @property {string} [status]
 * @property {string} [waitingFor]
 * @property {string} [cwd]
 * @property {string} [model]
 * @property {number} [startedAt]
 */

/**
 * @typedef {"starting" | "consent_pending" | "ready" | "idle" | "thinking" | "needs_input" | "permission_prompt" | "done" | "crashed" | "stopped" | "waking" | "killed" | "unknown"} BrokerState
 */

/**
 * Subset of {@link BrokerState} that can be derived directly from a native
 * agent poll. Broker-only states (starting, consent_pending, ready, waking,
 * killed) are never returned by mapNativeState.
 * @typedef {"idle" | "thinking" | "needs_input" | "permission_prompt" | "done" | "crashed" | "stopped" | "unknown"} NativeMappableState
 */
```

### Step 0.2 — Write preflight tests (TDD red)

- [ ] Create `test/native-preflight.test.mjs`. These tests will fail until the implementation exists.

```js
// test/native-preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeVersion,
  compareVersions,
  nodeVersionTuple,
  evaluateVersions,
  formatBlockers,
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
```

- [ ] Run the tests and observe failure (module does not exist yet).

```bash
node --test test/native-preflight.test.mjs
```

Expected output (before implementation): `Error: Cannot find module '...\lib\native\preflight.mjs'` and 0 pass.

### Step 0.3 — Implement `lib/native/preflight.mjs` (TDD green)

- [ ] Create `lib/native/preflight.mjs`.

```js
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
```

- [ ] Re-run the tests and observe all pass.

```bash
node --test test/native-preflight.test.mjs
```

Expected output: `# pass 10`, `# fail 0`. The ten tests cover three `parseClaudeVersion` cases, three `compareVersions` cases, one `nodeVersionTuple` case, two `evaluateVersions` cases, and one `formatBlockers` case.

### Step 0.4 — Operator upgrade gate

- [ ] Run preflight on the current host. It will report blockers because Claude is `2.1.150` and Node is `22.12.0`.

```bash
node lib/native/preflight.mjs
```

Expected output on the current host:

```
Claude 2.1.150 is below target 2.1.212 (structured waitingFor requires >= 2.1.212). Upgrade Claude using your normal installation method, then re-run preflight.
Node 22.12.0 is below target 22.13 (node:sqlite stable requires >= 22.13 in later phases). Upgrade Node using your normal installation method, then re-run preflight.
```

- [ ] Operator upgrades Claude and Node using their normal installation method (not scripted by this plan).
- [ ] Re-run preflight until `allOk` is true. The recorded `~/.pi/ccb-broker/preflight.json` tracks the upgrade history.

```bash
node lib/native/preflight.mjs --json
```

Expected output after upgrade: JSON with `"allOk": true` and an empty `blockers` array.

**Commit:**

```bash
git add lib/native/types.mjs lib/native/preflight.mjs test/native-preflight.test.mjs
git commit -m "Add native preflight: version gate without package-manager assumptions

Checks Claude >= 2.1.212 (structured waitingFor) and Node >= 22.13
(stable node:sqlite in later phases). Reports exact blockers and records
to ~/.pi/ccb-broker/preflight.json. Does not assume npm, apt, brew, or scoop."
```

## Phase 1 — Native adapter core (`lib/native/`)

Goal: a dependency-free adapter that wraps native `claude` subcommands and provides pure parsing and state-mapping functions. No SDK dependency here; the SDK lives in the isolated spike.

### Step 1.1 — Write state-map tests (TDD red)

- [ ] Create `test/native-state-map.test.mjs`.

```js
// test/native-state-map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapNativeState } from "../lib/native/state-map.mjs";

test("idle -> idle", () => {
  assert.equal(mapNativeState({ status: "idle" }), "idle");
});

test("working -> thinking", () => {
  assert.equal(mapNativeState({ status: "working" }), "thinking");
});

test("done -> done", () => {
  assert.equal(mapNativeState({ status: "done" }), "done");
});

test("failed -> crashed", () => {
  assert.equal(mapNativeState({ status: "failed" }), "crashed");
});

test("stopped -> stopped", () => {
  assert.equal(mapNativeState({ status: "stopped" }), "stopped");
});

test("blocked + waitingFor permission -> permission_prompt", () => {
  assert.equal(
    mapNativeState({ status: "blocked", waitingFor: "permission" }),
    "permission_prompt",
  );
});

test("blocked + waitingFor input -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "input" }), "needs_input");
});

test("blocked + waitingFor sandbox -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "sandbox" }), "needs_input");
});

test("blocked + waitingFor dialog -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "dialog" }), "needs_input");
});

test("blocked + unknown waitingFor -> unknown", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "something_new" }), "unknown");
});

test("lifecycle state takes precedence over secondary status", () => {
  assert.equal(mapNativeState({ state: "blocked", status: "idle" }), "unknown");
});

test("lifecycle blocked plus waitingFor permission maps to permission_prompt", () => {
  assert.equal(
    mapNativeState({ state: "blocked", status: "idle", waitingFor: "permission" }),
    "permission_prompt",
  );
});

test("lifecycle stopped maps to stopped", () => {
  assert.equal(mapNativeState({ state: "stopped" }), "stopped");
});

test("null agent -> unknown", () => {
  assert.equal(mapNativeState(null), "unknown");
});

test("unknown status -> unknown", () => {
  assert.equal(mapNativeState({ status: "invented" }), "unknown");
});
```

- [ ] Run and observe failure (module does not exist).

```bash
node --test test/native-state-map.test.mjs
```

Expected: `Error: Cannot find module` and 0 pass.

### Step 1.2 — Implement `lib/native/state-map.mjs` (TDD green)

- [ ] Create `lib/native/state-map.mjs`.

```js
// lib/native/state-map.mjs
// Pure function: maps a native agent object (from `claude agents --json --all`)
// to a broker state string. See spec section "State machine and precedence".

/**
 * @param {{ state?: string, status?: string, waitingFor?: string } | null} agent
 * @returns {"idle" | "thinking" | "needs_input" | "permission_prompt" | "done" | "crashed" | "stopped" | "unknown"}
 * Subset of BrokerState defined in types.mjs; excludes broker-only states
 * (starting, consent_pending, ready, waking, killed).
 */
export function mapNativeState(agent) {
  if (!agent) return "unknown";
  const lifecycleStates = new Set(["blocked", "stopped", "done", "failed"]);
  const nativeState = lifecycleStates.has(agent.state)
    ? agent.state
    : agent.status ?? agent.state;

  switch (nativeState) {
    case "idle":
      return "idle";
    case "working":
      return "thinking";
    case "done":
      return "done";
    case "failed":
      return "crashed";
    case "stopped":
      return "stopped";
    case "blocked":
      if (agent.waitingFor === "permission") return "permission_prompt";
      if (agent.waitingFor === "input" || agent.waitingFor === "sandbox" || agent.waitingFor === "dialog") {
        return "needs_input";
      }
      return "unknown";
    default:
      return "unknown";
  }
}
```

- [ ] Re-run and observe pass.

```bash
node --test test/native-state-map.test.mjs
```

Expected: `# pass 12`, `# fail 0`. The twelve tests cover `idle`, `working`, `done`, `failed`, `stopped`, four `blocked` sub-cases (permission, input, sandbox, dialog), unknown `blocked`, null agent, and unknown status.

### Step 1.3 — Write adapter tests (TDD red)

- [ ] Create `test/native-adapter.test.mjs`. These tests exercise pure parsing helpers without spawning `claude`; the spawn wrapper is tested via smoke in Phase 3.

```js
// test/native-adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentsJson, findAgentByName, buildStartArgs } from "../lib/native/adapter.mjs";

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
```

- [ ] Run and observe failure.

```bash
node --test test/native-adapter.test.mjs
```

Expected: `Cannot find module` and 0 pass.

### Step 1.4 — Implement `lib/native/adapter.mjs` (TDD green)

- [ ] Create `lib/native/adapter.mjs`.

```js
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
```

- [ ] Re-run and observe pass.

```bash
node --test test/native-adapter.test.mjs
```

Expected: `# pass 8`, `# fail 0`.

### Step 1.5 — Wire native tests into a separate npm script

- [ ] Read `package.json` (V1's test script must remain unchanged).

- [ ] Add a `test:native` script alongside V1's `test`. Do **not** modify the existing `test` or `check` scripts. Only add the `test:native` key to `scripts`:

```json
"test:native": "node --test test/native-preflight.test.mjs test/native-adapter.test.mjs test/native-state-map.test.mjs"
```

- [ ] Verify V1's `npm test` is unchanged.

```bash
npm test
```

Expected: `# tests 44`, `# pass 44`, `# fail 0`.

- [ ] Verify the new native test script passes.

```bash
npm run test:native
```

Expected: `# pass 30` (10 preflight + 8 adapter + 12 state-map), `# fail 0`.

**Commit:**

```bash
git add lib/native/state-map.mjs lib/native/adapter.mjs test/native-state-map.test.mjs test/native-adapter.test.mjs package.json
git commit -m "Add native adapter core: agents JSON parsing, state mapping, spawn wrappers

lib/native/state-map.mjs maps native agent status+waitingFor to broker
states per spec. lib/native/adapter.mjs wraps claude --bg/agents/respawn/
stop/rm/logs/attach. Pure helpers are unit-tested; spawn wrappers are
exercised by Phase 3 smoke. V1 npm test script unchanged (44 tests)."
```

## Phase 2 — Spike scaffolding (`spike/native-channel/`)

Goal: isolated package with its own dependencies, minimal MCP channel server, authenticated probe-control endpoint, and temp config generator. Does not touch V1.

### Step 2.1 — Create isolated package

- [ ] Create `spike/native-channel/package.json`.

```json
{
  "name": "ccb-native-channel-spike",
  "version": "0.0.1-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "channel-server": "node src/ccb-channel-server.mjs",
    "probe-control": "node src/probe-control.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "zod": "4.4.3"
  }
}
```

- [ ] Create `spike/native-channel/.gitignore`.

```
node_modules/
tmp/
evidence/*.raw.json
```

- [ ] Install dependencies inside the spike directory (does not affect root project).

```bash
cd spike/native-channel && npm install && cd ..
```

Expected: `node_modules/` created under `spike/native-channel/`; root `package.json` has no new dependencies.

### Step 2.2 — Implement the probe-control endpoint

- [ ] Create `spike/native-channel/src/probe-control.mjs`. This is an authenticated loopback HTTP server that collects forwarded notifications and exposes control commands for experiment scripts.

```js
// spike/native-channel/src/probe-control.mjs
// Authenticated loopback HTTP endpoint. Collects notifications forwarded by
// ccb-channel-server and exposes control commands for experiment scripts.
// Token is printed on stdout as JSON on startup.

import http from "node:http";
import crypto from "node:crypto";

const token = process.env.CCB_PROBE_TOKEN || crypto.randomUUID();
const events = [];
const outbound = [];
let nextOutboundId = 1;

function sendJson(res, status, value) {
  res.writeHead(status);
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    sendJson(res, 200, { events });
    return;
  }

  // Channel server -> experiment observer.
  if (req.method === "POST" && req.url === "/notify") {
    try {
      const parsed = await readJson(req);
      events.push({
        received_at: new Date().toISOString(),
        method: parsed.method,
        params: parsed.params,
      });
      sendJson(res, 202, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Experiment controller -> channel server. Items are FIFO and single-use.
  if (req.method === "POST" && req.url === "/outbound") {
    try {
      const parsed = await readJson(req);
      if (typeof parsed.method !== "string" || !parsed.params) {
        sendJson(res, 400, { error: "method and params required" });
        return;
      }
      const item = {
        id: nextOutboundId++,
        queued_at: new Date().toISOString(),
        method: parsed.method,
        params: parsed.params,
      };
      outbound.push(item);
      sendJson(res, 202, { ok: true, queued: item.id });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Atomic drain prevents a message or verdict from being emitted repeatedly.
  if (req.method === "GET" && req.url === "/outbound") {
    const items = outbound.splice(0, outbound.length);
    sendJson(res, 200, { items });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ probePort: port, token }) + "\n");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
```

### Step 2.3 — Implement the channel server

- [ ] Create `spike/native-channel/src/ccb-channel-server.mjs`. This is the MCP stdio server spawned by Claude. It connects to the probe-control endpoint and forwards notifications + replies.

```js
// spike/native-channel/src/ccb-channel-server.mjs
// MCP stdio server spawned by Claude when the custom development channel
// is active. Maintains an authenticated loopback connection to probe-control.
// Receives permission requests from Claude and emits queued channel messages
// and permission verdicts. Provides a reply tool for two-way smoke tests.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PROBE_URL = process.env.CCB_PROBE_URL;
const PROBE_TOKEN = process.env.CCB_PROBE_TOKEN;

if (!PROBE_URL || !PROBE_TOKEN) {
  console.error("[ccb-channel-server] CCB_PROBE_URL and CCB_PROBE_TOKEN must be set");
  process.exit(1);
}

const ReplySchema = z.object({
  reply: z.string().min(1),
});

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string().optional(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }).passthrough(),
});

async function postToProbe(method, params) {
  try {
    const response = await fetch(`${PROBE_URL}/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PROBE_TOKEN}`,
      },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) {
      throw new Error(`probe returned HTTP ${response.status}`);
    }
  } catch (e) {
    console.error(`[ccb-channel-server] probe post failed: ${e.message}`);
  }
}

async function drainOutbound() {
  try {
    const r = await fetch(`${PROBE_URL}/outbound`, {
      headers: { authorization: `Bearer ${PROBE_TOKEN}` },
    });
    if (!r.ok) throw new Error(`probe returned HTTP ${r.status}`);
    const data = await r.json();
    return data.items || [];
  } catch (error) {
    console.error(`[ccb-channel-server] outbound drain failed: ${error.message}`);
    return [];
  }
}

const server = new Server(
  { name: "ccb-channel-server", version: "0.0.1-spike" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      "Messages arrive as channel events. Respond through the reply tool when the message asks for a reply.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Forward a reply or response from the Claude session back to the ccb probe-control endpoint.",
      inputSchema: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "reply") {
    const parsed = ReplySchema.parse(args);
    await postToProbe("ccb/channel/reply", { text: parsed.reply });
    return { content: [{ type: "text", text: "ok" }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

// Permission requests flow from Claude Code into the channel server.
// Register before connect so no request can arrive before the handler exists.
server.setNotificationHandler(PermissionRequestSchema, async (notification) => {
  await postToProbe("notifications/claude/channel/permission_request", notification.params);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[ccb-channel-server] connected over stdio");

// Signal to probe-control that the channel server is alive. Experiments wait
// for this event before sending prompts, so connection detection does not
// depend on Claude emitting a notification first.
await postToProbe("ccb/channel/connected", {
  pid: process.pid,
  timestamp: new Date().toISOString(),
});

// Drain controller messages and verdicts once, then emit them in FIFO order.
let stopping = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pumpOutbound() {
  while (!stopping) {
    const items = await drainOutbound();
    for (const item of items) {
      await server.notification({
        method: item.method,
        params: item.params,
      });
      await postToProbe("ccb/channel/emitted", {
        outbound_id: item.id,
        method: item.method,
        request_id: item.params?.request_id,
      });
    }
    await delay(250);
  }
}

void pumpOutbound().catch((error) => {
  console.error(`[ccb-channel-server] outbound pump failed: ${error.message}`);
  process.exitCode = 1;
});

process.on("SIGTERM", () => {
  stopping = true;
  void transport.close().finally(() => process.exit(process.exitCode || 0));
});
```

The channel declares both required experimental capabilities. Claude Code sends `notifications/claude/channel/permission_request` into the registered zod handler. The controller queues outbound `notifications/claude/channel` messages and `notifications/claude/channel/permission` verdicts; the channel drains them once and emits them with `server.notification(...)` in FIFO order.

### Step 2.4 — Implement the temp config generator

- [ ] Create `spike/native-channel/src/temp-config.mjs`. Generates a temp session directory containing a `.mcp.json` file that registers the channel server. The adapter passes it explicitly through `--mcp-config` and isolates discovery with `--strict-mcp-config`. Does **not** touch the operator's project or global config.

```js
// spike/native-channel/src/temp-config.mjs
// Generates a temporary session directory under spike/native-channel/tmp/
// containing a .mcp.json that registers ccb-channel-server. Experiments pass
// configPath explicitly to startBackground. The operator's project and global
// Claude config are never modified.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const SPIKE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TMP_DIR = path.join(SPIKE_ROOT, "tmp");

/**
 * @param {{ probeUrl: string, probeToken: string }} opts
 * @returns {{ sessionCwd: string, configPath: string, mcpConfig: Object }}
 */
export function generateTempConfig({ probeUrl, probeToken }) {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const channelServerPath = path.join(SPIKE_ROOT, "src", "ccb-channel-server.mjs");
  const mcpConfig = {
    mcpServers: {
      "ccb-channel-server": {
        command: process.execPath,
        args: [channelServerPath.replace(/\\/g, "/")],
        env: {
          CCB_PROBE_URL: probeUrl,
          CCB_PROBE_TOKEN: probeToken,
        },
      },
    },
  };
  const sessionCwd = path.join(TMP_DIR, `session-${Date.now()}`);
  mkdirSync(sessionCwd, { recursive: true });
  const configPath = path.join(sessionCwd, ".mcp.json");
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return { sessionCwd, configPath, mcpConfig };
}

// CLI entry: `node src/temp-config.mjs <probeUrl> <probeToken>`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [probeUrl, probeToken] = process.argv.slice(2);
  if (!probeUrl || !probeToken) {
    console.error("Usage: temp-config.mjs <probeUrl> <probeToken>");
    process.exit(1);
  }
  const { sessionCwd } = generateTempConfig({ probeUrl, probeToken });
  process.stdout.write(sessionCwd + "\n");
}
```

### Step 2.5 — Implement the probe client

- [ ] Create `spike/native-channel/src/probe-client.mjs`. Thin client used by experiment scripts to interact with the probe-control endpoint.

```js
// spike/native-channel/src/probe-client.mjs
// Client for the probe-control endpoint. Used by experiment scripts.

/**
 * @param {{ probePort: number, token: string }} opts
 */
export function makeProbeClient({ probePort, token }) {
  const base = `http://127.0.0.1:${probePort}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  return {
    async getEvents() {
      const r = await fetch(`${base}/events`, { headers });
      return r.json();
    },
    async notify(method, params) {
      const r = await fetch(`${base}/outbound`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params }),
      });
      return r.json();
    },
    async sendMessage(content, meta = {}) {
      return this.notify("notifications/claude/channel", { content, meta });
    },
    async sendVerdict(requestId, behavior) {
      if (behavior !== "allow" && behavior !== "deny") {
        throw new Error("behavior must be allow or deny");
      }
      return this.notify("notifications/claude/channel/permission", {
        request_id: requestId,
        behavior,
      });
    },
  };
}
```

**Commit:**

```bash
git add spike/native-channel/package.json spike/native-channel/.gitignore spike/native-channel/src/
git commit -m "Add isolated native-channel spike scaffolding

spike/native-channel/ has its own package.json with
@modelcontextprotocol/sdk@1.29.0 and zod@4.4.3. Includes:
- ccb-channel-server.mjs (MCP stdio server spawned by Claude)
- probe-control.mjs (authenticated loopback endpoint)
- temp-config.mjs (generates temp MCP config; no user config changes)
- probe-client.mjs (client for experiment scripts)"
```

## Phase 3 — R0 live experiments

Goal: discover actual channel behavior and record evidence. Each experiment is a `.mjs` script under `spike/native-channel/experiments/` that starts a probe-control endpoint, starts a Claude session with a temp config, runs the procedure, records observations to `evidence/`, and cleans up.

> **Preflight:** Phase 3 experiments require the operator to have completed Phase 0 (Claude `>= 2.1.212`, Node `>= 22.13`). Run `node lib/native/preflight.mjs` and confirm `allOk` before starting any experiment.

> **Sequencing:** run experiments in order (01 → 05). If experiment 01 finds that consent blocks `--bg` entirely, stop and record a no-go — experiments 02–05 cannot proceed without a connected channel. If experiment 02 finds that injection does not deliver, stop — experiments 03–05 depend on injection working.

### Step 3.1 — Experiment 01: consent flow

- [ ] Create `spike/native-channel/experiments/run-01-consent.mjs`.

```js
// spike/native-channel/experiments/run-01-consent.mjs
// Goal: discover whether `claude --bg --name` accepts the custom development
// channel without interactive consent, or whether consent must be granted
// interactively via `claude attach` then /background.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTempConfig } from "../src/temp-config.mjs";
import { makeProbeClient } from "../src/probe-client.mjs";
import { startBackground, agentsJson, findAgentByName, stopAgent } from "../../../lib/native/adapter.mjs";
import { mapNativeState } from "../../../lib/native/state-map.mjs";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = path.join(SPIKE_ROOT, "evidence");
mkdirSync(EVIDENCE_DIR, { recursive: true });

const SESSION_NAME = "spike-consent-01";

async function main() {
  // 1. Start probe-control.
  const probeChild = spawn(process.execPath, [path.join(SPIKE_ROOT, "src", "probe-control.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const probeInfo = await new Promise((resolve) => {
    let buf = "";
    probeChild.stdout.on("data", (c) => {
      buf += c;
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {}
    });
  });
  const { probePort, token } = probeInfo;
  const probeUrl = `http://127.0.0.1:${probePort}`;
  console.error(`[experiment-01] probe-control on ${probeUrl}`);

  // 2. Generate temp MCP config in a temp session directory.
  const { sessionCwd, configPath } = generateTempConfig({ probeUrl, probeToken: token });
  console.error(`[experiment-01] session cwd: ${sessionCwd}`);
  console.error(`[experiment-01] mcp config: ${configPath}`);

  // 3. Start Claude background session with the temp session cwd.
  const observations = {
    experiment: "01-consent-flow",
    timestamp: new Date().toISOString(),
    session_name: SESSION_NAME,
    session_cwd: sessionCwd,
    mcp_config_path: configPath,
    probe_url: probeUrl,
    steps: [],
  };

  try {
    const startOutput = startBackground({ name: SESSION_NAME, cwd: sessionCwd, configPath });
    observations.steps.push({ step: "start", output: startOutput.slice(0, 500) });

    // 4. Poll agents JSON for up to 30 seconds; watch for channel connection.
    const client = makeProbeClient({ probePort, token });
    let connected = false;
    let agentState = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const events = (await client.getEvents()).events || [];
      if (events.some((e) => e.method === "ccb/channel/connected")) {
        connected = true;
      }
      try {
        const agents = agentsJson();
        const agent = findAgentByName(agents, SESSION_NAME);
        if (agent) agentState = { status: agent.status, waitingFor: agent.waitingFor, mapped: mapNativeState(agent) };
      } catch {}
      if (connected) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    observations.steps.push({
      step: "channel-connected-within-30s",
      connected,
      agent_state_at_check: agentState,
    });
    observations.connected = connected;

    // 5. If not connected, the implementer must `claude attach <id>` and
    //    observe whether a consent prompt appears. Record that as a manual step.
    if (!connected) {
      observations.steps.push({
        step: "manual-attach-required",
        instruction: "If agents JSON contains an ID, run `claude attach <id>`. If startup failed before an agent existed, run the same command interactively without `--bg`, approve the development-channel warning and project MCP consent, then use `/background`. Record each prompt and whether the channel connects.",
      });
    }
  } catch (error) {
    observations.connected = false;
    observations.steps.push({
      step: "background-start-error",
      message: error.message,
    });
    process.exitCode = 1;
  } finally {
    writeFileSync(
      path.join(EVIDENCE_DIR, "01-consent-flow.md"),
      formatEvidence(observations),
    );
    console.error("[experiment-01] evidence written to evidence/01-consent-flow.md");

    // 6. Cleanup: stop the session and kill probe-control.
    try {
      const agents = agentsJson();
      const agent = findAgentByName(agents, SESSION_NAME);
      if (agent?.id) stopAgent(agent.id);
    } catch {}
    probeChild.kill("SIGTERM");
  }
}

function formatEvidence(obs) {
  return [
    `# Experiment 01 — Consent Flow`,
    ``,
    `**Date:** ${obs.timestamp}`,
    `**Session:** ${obs.session_name}`,
    `**Probe URL:** ${obs.probe_url}`,
    ``,
    `## Observations`,
    ``,
    ...obs.steps.map(
      (s) =>
        `### ${s.step}\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\``,
    ),
    ``,
    `## Conclusion`,
    ``,
    `- **MCP process connected in --bg mode:** \`connected: ${obs.connected}\` above.`,
    `- **Channel registration:** an MCP process connection does not prove Claude accepted the server as a channel. Require either a rendered channel notice or end-to-end injection/reply evidence.`,
    `- **Consent/eligibility:** inspect an interactive launch when registration is not independently proven; Claude can load the MCP server while dropping channel notifications.`,
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] Run experiment 01.

```bash
cd spike/native-channel && node experiments/run-01-consent.mjs
```

Expected: `evidence/01-consent-flow.md` is written with observations. The `connected` field is the key result.

- [ ] If `connected` is `false` and an agent ID exists, run `claude attach <id>`. If no agent was created, rerun the generated launch interactively without `--bg`, approve the development-channel warning and project MCP consent, then use `/background`. Record the exact flow in the evidence file.

### Step 3.2 — Experiment 02: injection and reply

- [ ] Create `spike/native-channel/experiments/run-02-injection.mjs`.

```js
// spike/native-channel/experiments/run-02-injection.mjs
// Goal: verify notifications/claude/channel delivers an injected message
// and the reply tool forwards the session's response back to probe-control.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTempConfig } from "../src/temp-config.mjs";
import { makeProbeClient } from "../src/probe-client.mjs";
import { startBackground, agentsJson, logs, stopAgent } from "../../../lib/native/adapter.mjs";
import { stripAnsi } from "../../../lib/pane.mjs";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(SPIKE_ROOT, "evidence"), { recursive: true });
const SESSION_NAME = "spike-inject-02";
const INJECTED_MESSAGE = "Reply with exactly: SPIKE_INJECTION_OK";

async function main() {
  const probeChild = spawn(process.execPath, [path.join(SPIKE_ROOT, "src", "probe-control.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { probePort, token } = await new Promise((resolve) => {
    let buf = "";
    probeChild.stdout.on("data", (c) => {
      buf += c;
      try { resolve(JSON.parse(buf.trim())); } catch {}
    });
  });
  const probeUrl = `http://127.0.0.1:${probePort}`;
  const { sessionCwd, configPath } = generateTempConfig({ probeUrl, probeToken: token });
  const client = makeProbeClient({ probePort, token });

  const obs = {
    experiment: "02-injection-reply",
    timestamp: new Date().toISOString(),
    session_name: SESSION_NAME,
    session_cwd: sessionCwd,
    mcp_config_path: configPath,
    channel_connected: false,
    reply_received: false,
    reply_matches_expected: false,
  };

  try {
    startBackground({ name: SESSION_NAME, cwd: sessionCwd, configPath });
    // Wait for channel connection (up to 30s).
    const connected = await waitForConnection(client, 30000);
    obs.channel_connected = connected;

    if (connected) {
      // Inject a message via the channel.
      await client.sendMessage(INJECTED_MESSAGE, { experiment: "02" });
      obs.injected_message = INJECTED_MESSAGE;
      obs.injected_at = new Date().toISOString();

      // Wait up to 60s for a reply notification.
      const reply = await waitForReply(client, 60000);
      obs.reply_received = Boolean(reply);
      obs.reply_content = reply?.params?.text?.slice(0, 200) || null;
      obs.reply_received_at = reply?.received_at || null;
      obs.reply_matches_expected = reply?.params?.text?.trim() === "SPIKE_INJECTION_OK";
    }

    obs.probe_events = (await client.getEvents()).events || [];
    const sessionAgent = agentsJson().find((agent) => agent.cwd === sessionCwd);
    obs.agent_at_end = sessionAgent || null;
    if (sessionAgent?.id) {
      try {
        obs.native_log_summary = summarizeNativeLogs(logs(sessionAgent.id));
      } catch (error) {
        obs.native_logs_error = error.message;
      }
    }
  } catch (error) {
    obs.error = error.message;
    process.exitCode = 1;
  } finally {
    writeFileSync(
      path.join(SPIKE_ROOT, "evidence", "02-injection-reply.md"),
      formatEvidence(obs),
    );
    try {
      const agents = agentsJson();
      const agent = agents.find((candidate) => candidate.cwd === sessionCwd);
      if (agent?.id) stopAgent(agent.id);
    } catch {}
    probeChild.kill("SIGTERM");
  }
}

async function waitForConnection(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    if (events.some((e) => e.method === "ccb/channel/connected")) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function waitForReply(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    const reply = events.find((e) => e.method === "ccb/channel/reply");
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function summarizeNativeLogs(raw) {
  const clean = stripAnsi(raw);
  const relevantLines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /channel|SPIKE_INJECTION_OK|reply|permission/i.test(line))
    .slice(-40);
  return {
    injected_marker_rendered: clean.includes("SPIKE_INJECTION_OK"),
    channel_unavailable_rendered: /Channels are not currently available/i.test(clean),
    relevant_lines: relevantLines,
  };
}

function formatEvidence(obs) {
  return [
    `# Experiment 02 — Injection and Reply`,
    ``,
    `**Date:** ${obs.timestamp}`,
    `**Session:** ${obs.session_name}`,
    ``,
    `## Observations`,
    ``,
    "```json",
    JSON.stringify(obs, null, 2),
    "```",
    ``,
    `## Conclusion`,
    ``,
    `- **Injected message arrived:** \`reply_received\` and \`reply_matches_expected\` must both be true.`,
    `- **Reply forwarded via reply tool:** \`reply_received\` is true iff the reply tool posted \`ccb/channel/reply\`.`,
    `- **Acknowledgement limit:** channel notifications are unacknowledged; this experiment proves end-to-end delivery only when the expected reply arrives.`,
  ].join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] Run experiment 02.

```bash
cd spike/native-channel && node experiments/run-02-injection.mjs
```

Expected: `evidence/02-injection-reply.md` written with the `reply_received` and `reply_content` fields populated (if the channel works).

### Step 3.3 — Experiment 03: permission relay (approve + deny)

- [ ] Create `spike/native-channel/experiments/run-03-permission.mjs`.

```js
// spike/native-channel/experiments/run-03-permission.mjs
// Goal: verify notifications/claude/channel/permission_request arrives at
// probe-control and a verdict sent back via notifications/claude/channel/permission
// is honored for both approve and deny paths.
//
// Uses Claude's default permission mode so real permission prompts appear.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTempConfig } from "../src/temp-config.mjs";
import { makeProbeClient } from "../src/probe-client.mjs";
import { startBackground, agentsJson, findAgentByName, stopAgent } from "../../../lib/native/adapter.mjs";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_NAME = "spike-perm-03";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const probeChild = spawn(process.execPath, [path.join(SPIKE_ROOT, "src", "probe-control.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { probePort, token } = await new Promise((resolve) => {
    let buf = "";
    probeChild.stdout.on("data", (c) => { buf += c; try { resolve(JSON.parse(buf.trim())); } catch {} });
  });
  const probeUrl = `http://127.0.0.1:${probePort}`;
  const { sessionCwd, configPath } = generateTempConfig({ probeUrl, probeToken: token });
  const client = makeProbeClient({ probePort, token });

  const obs = {
    experiment: "03-permission-relay",
    timestamp: new Date().toISOString(),
    session_name: SESSION_NAME,
    session_cwd: sessionCwd,
    mcp_config_path: configPath,
    trials: [],
  };

  try {
    // Default permission mode is required so permission prompts appear.
    startBackground({ name: SESSION_NAME, cwd: sessionCwd, configPath });
    if (!(await waitForConnection(client, 30000))) {
      throw new Error("channel did not connect within 30s");
    }

    const seenRequestIds = new Set();
    const approveSentinel = path.join(sessionCwd, "approved-sentinel.txt").replaceAll("\\", "/");
    const denySentinel = path.join(sessionCwd, "denied-sentinel.txt").replaceAll("\\", "/");

    obs.trials.push(
      await runPermissionTrial({
        client,
        behavior: "allow",
        sentinel: approveSentinel,
        seenRequestIds,
      }),
    );
    obs.trials.push(
      await runPermissionTrial({
        client,
        behavior: "deny",
        sentinel: denySentinel,
        seenRequestIds,
      }),
    );

  } catch (error) {
    obs.error = error.message;
    process.exitCode = 1;
  } finally {
    writeFileSync(
      path.join(SPIKE_ROOT, "evidence", "03-permission-relay.md"),
      formatEvidence(obs),
    );
    try {
      const agents = agentsJson();
      const agent = findAgentByName(agents, SESSION_NAME);
      if (agent?.id) stopAgent(agent.id);
    } catch {}
    probeChild.kill("SIGTERM");
  }
}

async function waitForConnection(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    if (events.some((event) => event.method === "ccb/channel/connected")) return true;
    await sleep(500);
  }
  return false;
}

async function runPermissionTrial({ client, behavior, sentinel, seenRequestIds }) {
  const command =
    `node -e "require('fs').writeFileSync(process.argv[1], 'created')" "${sentinel}"`;
  await client.sendMessage(
    `Run exactly this command with Bash and do not use another tool: ${command}`,
    { experiment: "03", behavior },
  );

  const deadline = Date.now() + 60000;
  let request = null;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    request = events.find(
      (event) =>
        event.method === "notifications/claude/channel/permission_request" &&
        !seenRequestIds.has(event.params?.request_id),
    );
    if (request) break;
    await sleep(500);
  }
  if (!request) {
    return {
      behavior,
      request_received: false,
      verdict_honored: false,
      error: "no new permission_request within 60s",
    };
  }

  const requestId = request.params?.request_id;
  seenRequestIds.add(requestId);
  await client.sendVerdict(requestId, behavior);
  const verdictEmitted = await waitForVerdictEmission(client, requestId, 10000);

  const settleDeadline = Date.now() + (behavior === "allow" ? 30000 : 10000);
  while (behavior === "allow" && Date.now() < settleDeadline && !existsSync(sentinel)) {
    await sleep(500);
  }
  if (behavior === "deny") await sleep(1000);
  const permissionPromptCleared = await waitForPermissionPromptToClear(30000);
  if (behavior === "deny") await sleep(10000);

  const sentinelExists = existsSync(sentinel);
  return {
    behavior,
    request_received: true,
    request_id: requestId,
    request_params: request.params,
    sentinel,
    sentinel_exists: sentinelExists,
    verdict_emitted: verdictEmitted,
    permission_prompt_cleared: permissionPromptCleared,
    verdict_honored:
      behavior === "allow"
        ? verdictEmitted && sentinelExists
        : verdictEmitted && permissionPromptCleared && !sentinelExists,
  };
}

async function waitForVerdictEmission(client, requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    if (events.some(
      (event) =>
        event.method === "ccb/channel/emitted" &&
        event.params?.method === "notifications/claude/channel/permission" &&
        event.params?.request_id === requestId,
    )) return true;
    await sleep(250);
  }
  return false;
}

async function waitForPermissionPromptToClear(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const agent = findAgentByName(agentsJson(), SESSION_NAME);
      const stillWaiting =
        agent?.status === "blocked" &&
        /permission/i.test(String(agent.waitingFor || ""));
      if (agent && !stillWaiting) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function formatEvidence(obs) {
  return [
    `# Experiment 03 — Permission Relay`,
    ``,
    `**Date:** ${obs.timestamp}`,
    `**Session:** ${obs.session_name}`,
    ``,
    `## Trials`,
    ``,
    ...obs.trials.map(
      (trial) =>
        `### Verdict: ${trial.behavior}\n\`\`\`json\n${JSON.stringify(trial, null, 2)}\n\`\`\`\n`,
    ),
    ``,
    `## Conclusion`,
    ``,
    `- **Request received:** both trials must have \`request_received: true\`.`,
    `- **Allow honored:** allow trial must show verdict emission, sentinel creation, and \`verdict_honored: true\`.`,
    `- **Deny honored:** deny trial must show verdict emission, permission prompt clearance, no sentinel, and \`verdict_honored: true\`.`,
    `- **Correlation:** each verdict echoes the exact unseen \`request_id\` captured for that trial.`,
  ].join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] Run experiment 03.

```bash
cd spike/native-channel && node experiments/run-03-permission.mjs
```

Expected: `evidence/03-permission-relay.md` contains distinct allow and deny trials. Both receive unique request IDs; allow creates its sentinel and deny does not.

### Step 3.4 — Experiment 04: native state mapping

- [ ] Create `spike/native-channel/experiments/run-04-state-map.mjs`.

```js
// spike/native-channel/experiments/run-04-state-map.mjs
// Goal: verify the native agent state -> broker state mapping from the spec
// by observing real transitions in claude agents --json --all.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentsJson, findAgentByName, startBackground, stopAgent } from "../../../lib/native/adapter.mjs";
import { mapNativeState } from "../../../lib/native/state-map.mjs";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_NAME = "spike-state-04";

async function main() {
  const obs = {
    experiment: "04-native-state-mapping",
    timestamp: new Date().toISOString(),
    session_name: SESSION_NAME,
    snapshots: [],
  };

  try {
    // Experiment 04 tests native state mapping only; no channel server needed.
    // Use a minimal temp cwd so no operator project is touched.
    const sessionCwd = path.join(SPIKE_ROOT, "tmp", `state-04-${Date.now()}`);
    mkdirSync(sessionCwd, { recursive: true });
    startBackground({ name: SESSION_NAME, cwd: sessionCwd });

    // Snapshot 1: right after start (expect working or idle).
    obs.snapshots.push(takeSnapshot("after-start"));

    // Snapshot 2: after 10s (expect working or done).
    await new Promise((r) => setTimeout(r, 10000));
    obs.snapshots.push(takeSnapshot("after-10s"));

    // Snapshot 3: after 30s.
    await new Promise((r) => setTimeout(r, 20000));
    obs.snapshots.push(takeSnapshot("after-30s"));
  } catch (error) {
    obs.error = error.message;
    process.exitCode = 1;
  } finally {
    try {
      const agents = agentsJson();
      const agent = findAgentByName(agents, SESSION_NAME);
      if (agent?.id) stopAgent(agent.id);
    } catch {}
  }

  writeFileSync(
    path.join(SPIKE_ROOT, "evidence", "04-native-state-mapping.md"),
    formatEvidence(obs),
  );
}

function takeSnapshot(label) {
  try {
    const agents = agentsJson();
    const agent = findAgentByName(agents, SESSION_NAME);
    return {
      label,
      timestamp: new Date().toISOString(),
      raw_agent: agent,
      mapped_state: agent ? mapNativeState(agent) : "unknown",
    };
  } catch (e) {
    return { label, error: e.message };
  }
}

function formatEvidence(obs) {
  return [
    `# Experiment 04 — Native State Mapping`,
    ``,
    `**Date:** ${obs.timestamp}`,
    `**Session:** ${obs.session_name}`,
    ``,
    `## Snapshots`,
    ``,
    ...obs.snapshots.map(
      (s) =>
        `### ${s.label}\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`,
    ),
    ``,
    `## Conclusion`,
    ``,
    `- **Mapping accuracy:** compare each trial's \`mapped_state\` against the spec mapping table; any mismatch is a finding.`,
    `- **Unexpected statuses:** scan \`native_states\` for any \`status\` value not in {idle, working, done, failed, stopped, blocked}.`,
    `- **waitingFor disambiguation:** for blocked states, \`waitingFor: "permission"\` maps to permission_prompt; \`waitingFor: "input"|"sandbox"|"dialog"\` maps to needs_input; any other value maps to unknown.`,
  ].join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] Run experiment 04.

```bash
cd spike/native-channel && node experiments/run-04-state-map.mjs
```

Expected: `evidence/04-native-state-mapping.md` written with three snapshots showing the raw agent JSON and mapped broker state at each point.

### Step 3.5 — Experiment 05: respawn conversation integrity

- [ ] Create `spike/native-channel/experiments/run-05-respawn.mjs`.

```js
// spike/native-channel/experiments/run-05-respawn.mjs
// Goal: verify claude respawn <id> restores the session with conversation
// context intact.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTempConfig } from "../src/temp-config.mjs";
import { makeProbeClient } from "../src/probe-client.mjs";
import {
  agentsJson,
  findAgentByName,
  startBackground,
  stopAgent,
  respawn,
  logs,
} from "../../../lib/native/adapter.mjs";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_NAME = "spike-respawn-05";
const MARKER = "SPIKE_RESPAWN_MARKER_42";

async function main() {
  const probeChild = spawn(process.execPath, [path.join(SPIKE_ROOT, "src", "probe-control.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { probePort, token } = await new Promise((resolve) => {
    let buf = "";
    probeChild.stdout.on("data", (c) => { buf += c; try { resolve(JSON.parse(buf.trim())); } catch {} });
  });
  const probeUrl = `http://127.0.0.1:${probePort}`;
  const { sessionCwd, configPath } = generateTempConfig({ probeUrl, probeToken: token });
  const client = makeProbeClient({ probePort, token });

  const obs = {
    experiment: "05-respawn-integrity",
    timestamp: new Date().toISOString(),
    session_name: SESSION_NAME,
    marker: MARKER,
    steps: [],
  };

  try {
    // 1. Start session and inject a marker prompt.
    startBackground({ name: SESSION_NAME, cwd: sessionCwd, configPath });
    if (!(await waitForEventCount(client, "ccb/channel/connected", 1, 30000))) {
      throw new Error("initial channel connection timed out");
    }
    await client.sendMessage(
      `Remember this marker for later: ${MARKER}. Reply with OK.`,
      { experiment: "05", step: "remember" },
    );
    obs.steps.push({ step: "marker-injected", marker: MARKER });

    const firstReply = await waitForReplyCount(client, 1, 60000);
    if (!firstReply) throw new Error("initial marker acknowledgement timed out");
    obs.steps.push({ step: "marker-acknowledged", reply: firstReply.params?.text });
    const connectedBeforeRespawn = await countEvents(client, "ccb/channel/connected");

    // 2. Stop the session.
    const agents1 = agentsJson();
    const agent1 = findAgentByName(agents1, SESSION_NAME);
    if (!agent1?.id) throw new Error("agent not found after start");
    stopAgent(agent1.id);
    obs.steps.push({ step: "stopped", agent_id: agent1.id });

    // 3. Respawn.
    const respawnOutput = respawn(agent1.id);
    obs.steps.push({ step: "respawned", output: String(respawnOutput).slice(0, 500) });

    // 4. Ask the session to recall the marker.
    if (!(await waitForEventCount(
      client,
      "ccb/channel/connected",
      connectedBeforeRespawn + 1,
      30000,
    ))) {
      throw new Error("channel did not reconnect after respawn");
    }
    const repliesBeforeRecall = await countEvents(client, "ccb/channel/reply");
    await client.sendMessage(
      "What marker did I give you earlier? Reply with just the marker.",
      { experiment: "05", step: "recall" },
    );
    const recallReply = await waitForReplyCount(client, repliesBeforeRecall + 1, 60000);
    const recalledText = recallReply?.params?.text?.trim() || null;
    obs.steps.push({
      step: "recall-reply",
      reply: recalledText,
      marker_recalled_exactly: recalledText === MARKER,
    });

    // 5. Keep native logs as diagnostics, not as proof: the original prompt
    // itself contains the marker and would otherwise create a false positive.
    try {
      const tail = logs(agent1.id);
      obs.steps.push({
        step: "log-check",
        marker_present_in_logs: tail.includes(MARKER),
        diagnostic_only: true,
      });
    } catch (error) {
      obs.steps.push({
        step: "log-check-error",
        message: error.message,
        diagnostic_only: true,
      });
    }
  } catch (error) {
    obs.steps.push({ step: "experiment-error", message: error.message });
    process.exitCode = 1;
  } finally {
    writeFileSync(
      path.join(SPIKE_ROOT, "evidence", "05-respawn-integrity.md"),
      formatEvidence(obs),
    );
    try {
      const agents = agentsJson();
      const agent = findAgentByName(agents, SESSION_NAME);
      if (agent?.id) stopAgent(agent.id);
    } catch {}
    probeChild.kill("SIGTERM");
  }
}

async function countEvents(client, method) {
  const events = (await client.getEvents()).events || [];
  return events.filter((event) => event.method === method).length;
}

async function waitForEventCount(client, method, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countEvents(client, method)) >= expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForReplyCount(client, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await client.getEvents()).events || [];
    const replies = events.filter((event) => event.method === "ccb/channel/reply");
    if (replies.length >= expected) return replies[expected - 1];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function formatEvidence(obs) {
  return [
    `# Experiment 05 — Respawn Conversation Integrity`,
    ``,
    `**Date:** ${obs.timestamp}`,
    `**Session:** ${obs.session_name}`,
    `**Marker:** \`${obs.marker}\``,
    ``,
    `## Steps`,
    ``,
    ...obs.steps.map(
      (s) => `### ${s.step}\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`,
    ),
    ``,
    `## Conclusion`,
    ``,
    `- **Respawn restored transport:** a second \`ccb/channel/connected\` event arrived after \`claude respawn\`.`,
    `- **Logs available:** \`log-check\` is diagnostic only and is not conversation-integrity proof.`,
    `- **Conversation intact:** \`recall-reply.marker_recalled_exactly\` must be true.`,
  ].join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] Run experiment 05.

```bash
cd spike/native-channel && node experiments/run-05-respawn.mjs
```

Expected: `evidence/05-respawn-integrity.md` shows a second channel connection and `marker_recalled_exactly: true`. Log presence is recorded only as diagnostics.

**Commit (after all experiments):**

```bash
git add spike/native-channel/experiments/ spike/native-channel/evidence/
git commit -m "Add R0 live experiment scripts and evidence scaffolding

Five experiments: consent flow, injection/reply, permission relay
(approve+deny), native state mapping, respawn conversation integrity.
Each experiment starts a temp-config session, records observations to
evidence/*.md, and cleans up spawned sessions."
```

## Phase 4 — Evidence report and go/no-go decision

### Step 4.1 — Write the go/no-go report

- [ ] After running all five experiments and filling in each evidence file's Conclusion section, create `spike/native-channel/evidence/go-no-go.md` by consolidating the findings.

```markdown
# R0 Go/No-Go Decision

**Date:** Record the experiment execution date.
**Claude version observed:** Copy the exact value from `preflight.json`.
**Node version observed:** Copy the exact value from `preflight.json`.

## Criteria evaluation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | `claude --bg --name` accepts temp MCP config | Record PASS or FAIL | 01-consent-flow.md |
| 2 | Channel consent is at most one step and persists | Record PASS or FAIL | 01-consent-flow.md |
| 3 | `notifications/claude/channel` delivers + reply returns | Record PASS or FAIL | 02-injection-reply.md |
| 4 | Permission relay round-trip (approve + deny) | Record PASS or FAIL | 03-permission-relay.md |
| 5 | Native state/waitingFor maps cleanly | Record PASS or FAIL | 04-native-state-mapping.md |
| 6 | Respawn preserves conversation | Record PASS or FAIL | 05-respawn-integrity.md |

## Decision

Apply the Step 4.2 rule: all six PASS means GO; any FAIL means NO-GO.

## Rationale

If GO: list what worked, any caveats observed, and SDK/channel API findings that affect R2.
If NO-GO: identify which criteria failed, why, and the fallback design (hooks-and-poll-only or wait for channel stabilization).
```

- [ ] For each criterion, read the evidence file's Conclusion section and set the Result column to PASS or FAIL. Then apply the Step 4.2 decision rule.

### Step 4.2 — Go/no-go gate

- [ ] If **any** criterion is FAIL, mark the decision as NO-GO and stop. Do not proceed to Phase 5 spec update or to any broker work (R2+). Document the fallback in the rationale.
- [ ] If **all** criteria are PASS, mark the decision as GO and proceed to Phase 5.

**Commit:**

```bash
git add spike/native-channel/evidence/go-no-go.md
git commit -m "Record R0 go/no-go decision

See evidence/go-no-go.md for the decision and rationale.
Based on five experiments covering consent, injection/reply,
permission relay, state mapping, and respawn integrity."
```

## Phase 5 — Spec update with observations

Goal: update the approved spec with the observed behavior from R0. This step only runs on GO.

### Step 5.1 — Update the spec's remaining-uncertainty section

- [ ] Open `docs/superpowers/specs/2026-07-23-native-control-plane-design.md`.
- [ ] Find the "Remaining uncertainty" section.
- [ ] Replace each bullet with the observed finding from the experiments. For example:

  - **Channel consent flow.** State whether `claude --bg --name` required interactive consent and list the exact observed prompts.
  - **Channel injection semantics.** State whether delivery was immediate or queued, using only evidence the experiment actually captured.
  - **Native state subtypes.** State whether `blocked` plus `waitingFor` distinguished permission prompts from input needs across tested tools.
  - **Respawn conversation integrity.** State whether `claude respawn <id>` preserved context, citing the exact marker-recall result.

- [ ] If any observation contradicts a spec assumption, update the relevant spec section (e.g., state machine, component diagram, or security section) to match reality. Note the change in a short bullet under the updated section.

### Step 5.2 — Update the rollout phases section

- [ ] In the spec's "Rollout phases" section, mark R0 as complete with the date and decision.
- [ ] Add a one-line summary of the key finding next to the R0 entry.

**Commit:**

```bash
git add docs/superpowers/specs/2026-07-23-native-control-plane-design.md
git commit -m "Update V2 spec with R0 spike observations

Replaces remaining-uncertainty entries with observed behavior for
channel consent, injection semantics, state mapping, and respawn
integrity. Marks R0 as complete with GO/NO-GO decision."
```

## Phase 6 — Cleanup

Goal: remove spawned sessions and temp configs; verify V1 is untouched.

### Step 6.1 — Stop any lingering spike sessions

- [ ] List all agents and stop any `spike-*` sessions that were not cleaned up by experiment scripts. Errors from the native adapter (e.g., `claude agents` unavailable) are caught and reported, not fatal — cleanup must be best-effort.

```bash
node -e "
import('./lib/native/adapter.mjs').then(async ({ agentsJson, findAgentByName, stopAgent }) => {
  let agents;
  try {
    agents = agentsJson();
  } catch (e) {
    console.error('Could not list agents (claude agents unavailable):', e.message);
    process.exit(0);
  }
  let stopped = 0;
  for (const a of agents) {
    if (a.name && a.name.startsWith('spike-') && a.id) {
      console.log('stopping', a.name, a.id);
      try {
        stopAgent(a.id);
        stopped++;
      } catch (e) {
        console.error('Failed to stop', a.name, a.id, ':', e.message);
      }
    }
  }
  console.log('Stopped', stopped, 'spike sessions.');
}).catch((e) => {
  console.error('Adapter import failed:', e.message);
  process.exit(0);
});
"
```

Expected: each leftover `spike-*` session is stopped, or an error message explains why `claude agents` was unavailable. Cleanup never blocks on a missing CLI.

### Step 6.2 — Remove temp configs

- [ ] Remove the generated temp MCP configs.

```bash
node -e "require('node:fs').rmSync('spike/native-channel/tmp', { recursive: true, force: true })"
```

Expected: `spike/native-channel/tmp/` no longer exists. The operator's project and global Claude config are untouched.

### Step 6.3 — Verify V1 regression

- [ ] Run V1's test suite and confirm 44/44.

```bash
npm test
```

Expected: `# tests 44`, `# pass 44`, `# fail 0`.

- [ ] Run V1's check and confirm doctor is green.

```bash
npm run check
```

Expected: doctor JSON reports `"ok": true` for all tools.

### Step 6.4 — Verify native adapter tests

- [ ] Run the native test script.

```bash
npm run test:native
```

Expected: all native tests pass with `# fail 0`.

No cleanup commit is expected: `tmp/` is ignored and this phase must not stage unrelated working-tree changes. If verification changes a tracked evidence file, stage that file explicitly and commit only it.

## V1 regression guard

The following files are V1 and must not be modified by this plan:

- `bin/codex-claude-bridge.mjs`
- `lib/pane.mjs`
- `lib/steer.mjs`
- `test/pane.test.mjs`
- `test/fixtures.mjs`

The following files are modified additively (new scripts, new files):

- `package.json` — add `test:native` script only; existing `test` and `check` scripts unchanged.

Verification after every phase: `npm test` reports `# tests 44`, `# pass 44`, `# fail 0`.

## Self-review

- **Spec coverage:** every R0/R1 item from the approved spec is addressed by a plan step. R0's six discovery items map to experiments 01-05 plus the go/no-go report. R1's native adapter and version doctor map to Phases 0 and 1. No R0/R1 spec item is left without a plan step.
- **No incomplete code:** every code snippet is complete. Execution-result templates explicitly say which captured evidence supplies each value.
- **Type consistency:** `VersionTuple` is `readonly [number, number, number]` everywhere. `BrokerState` is defined once in `types.mjs` and referenced consistently. `NativeAgent` fields match what `parseAgentsJson` returns and what `mapNativeState` accepts.
- **Dependency isolation:** the root project gains no new runtime dependencies. `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` live only under `spike/native-channel/`. `lib/native/` is dependency-free.
- **V1 safety:** V1 files are never modified. `package.json` gains only an additive `test:native` script. V1's `npm test` continues to run `test/pane.test.mjs` only.
- **Channel feature detection:** the spec says "channel is feature-detected, not assumed from semver." Experiment 01 is the feature detection mechanism: if the channel does not connect, that is a no-go regardless of the Claude version number. The preflight version check is a gate, not a proof.
- **Cleanup:** every experiment script has a `finally` block that stops the spawned session and kills probe-control. Step 6 adds a belt-and-suspenders sweep for leftover `spike-*` sessions.
- **Scoped commits:** each implementation commit stages explicit paths. Cleanup never uses `git add -A`, so unrelated operator changes cannot be captured.
