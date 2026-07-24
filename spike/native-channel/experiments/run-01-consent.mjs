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
