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
