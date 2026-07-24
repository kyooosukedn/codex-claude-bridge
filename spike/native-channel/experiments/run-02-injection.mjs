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
    if (!obs.reply_matches_expected) process.exitCode = 1;

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
