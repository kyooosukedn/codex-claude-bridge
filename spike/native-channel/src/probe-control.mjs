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
