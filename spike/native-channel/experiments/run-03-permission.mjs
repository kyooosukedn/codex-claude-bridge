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
