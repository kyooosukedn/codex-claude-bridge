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
