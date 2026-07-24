# Experiment 02 — Injection and Reply

**Date:** 2026-07-24T14:37:17.785Z
**Session:** spike-inject-02

## Observations

```json
{
  "experiment": "02-injection-reply",
  "timestamp": "2026-07-24T14:37:17.785Z",
  "session_name": "spike-inject-02",
  "session_cwd": "<worktree>\\spike\\native-channel\\tmp\\session-1784903837783",
  "mcp_config_path": "<worktree>\\spike\\native-channel\\tmp\\session-1784903837783\\.mcp.json",
  "channel_connected": true,
  "reply_received": false,
  "reply_matches_expected": false,
  "injected_message": "Reply with exactly: SPIKE_INJECTION_OK",
  "injected_at": "2026-07-24T14:37:23.681Z",
  "reply_content": null,
  "reply_received_at": null,
  "probe_events": [
    {
      "received_at": "2026-07-24T14:37:22.872Z",
      "method": "ccb/channel/connected",
      "params": {
        "pid": 27768,
        "timestamp": "2026-07-24T14:37:22.703Z"
      }
    },
    {
      "received_at": "2026-07-24T14:37:23.745Z",
      "method": "ccb/channel/emitted",
      "params": {
        "outbound_id": 1,
        "method": "notifications/claude/channel"
      }
    }
  ],
  "agent_at_end": {
    "pid": 25028,
    "id": "ab244a1f",
    "cwd": "<worktree>\\spike\\native-channel\\tmp\\session-1784903837783",
    "kind": "background",
    "startedAt": 1784903841874,
    "sessionId": "ab244a1f-592b-4af3-8028-00648f8fb74a",
    "name": "spike-inject-02",
    "status": "idle",
    "state": "blocked"
  },
  "native_log_summary": {
    "injected_marker_rendered": false,
    "channel_unavailable_rendered": false,
    "relevant_lines": [
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
    ]
  }
}
```

## Conclusion

- **Injected message arrived:** `reply_received` and `reply_matches_expected` must both be true.
- **Reply forwarded via reply tool:** `reply_received` is true iff the reply tool posted `ccb/channel/reply`.
- **Acknowledgement limit:** channel notifications are unacknowledged; this experiment proves end-to-end delivery only when the expected reply arrives.
