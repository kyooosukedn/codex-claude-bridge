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
