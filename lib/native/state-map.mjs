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
