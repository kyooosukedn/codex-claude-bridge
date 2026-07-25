# Experiment 01 — Consent Flow

**Date:** 2026-07-24T14:32:44.505Z
**Session:** spike-consent-01
**Probe URL:** http://127.0.0.1:54638

## Observations

### start
```json
{
  "step": "start",
  "output": "backgrounded · 1d7159e7 · spike-consent-01\n  claude agents             list sessions\n  claude attach 1d7159e7    open in this terminal\n  claude logs 1d7159e7      show recent output\n  claude stop 1d7159e7      stop this session\n"
}
```
### channel-connected-within-30s
```json
{
  "step": "channel-connected-within-30s",
  "connected": true,
  "agent_state_at_check": {
    "mapped": "unknown"
  }
}
```

## Conclusion

- **MCP process connected in `--bg` mode:** `connected: true` above, reproduced twice.
- **Channel registration not proven by connection:** Experiment 02 emitted a notification but Claude never rendered or processed it.
- **Interactive verification:** exact same config produced `--dangerously-load-development-channels ignored (server:ccb-channel-server)` and `Channels are not currently available`.
- **Result:** current authentication environment cannot register custom channels; this is eligibility failure, not a consent-flow success.
