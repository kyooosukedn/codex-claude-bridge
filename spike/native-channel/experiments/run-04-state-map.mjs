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
