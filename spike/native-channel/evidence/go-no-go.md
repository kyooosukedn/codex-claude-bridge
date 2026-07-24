# R0 Native Channel Decision

**Date:** 2026-07-24
**Decision:** NO-GO on current authentication environment

## Host

- Claude Code: `2.1.218`
- Node: `22.23.1` portable, official SHA-256 verified
- Claude model/auth display: `glm-5.2 · API Usage Billing`

## Evidence

1. `ccb-channel-server` connected over MCP stdio in two background runs.
2. Interactive launch with the same generated config printed:
   - `--dangerously-load-development-channels ignored (server:ccb-channel-server)`
   - `Channels are not currently available`
3. Experiment 02 queued and emitted `notifications/claude/channel`.
4. Claude rendered no channel event, performed no model turn, and sent no reply within 60 seconds across three reproductions.
5. Official [Channels documentation](https://code.claude.com/docs/en/channels) states that Channels require Anthropic authentication through claude.ai or a Console API key.
6. Experiments 03-05 were not run because Experiment 02 failed a mandatory R0 criterion.

## Root Cause

Current Claude session uses a third-party GLM/API-billing provider. Claude can still start the configured MCP subprocess, but it rejects channel registration. MCP connection presence therefore cannot serve as channel-liveness proof.

## R1 Result

Native adapter work remains valid and tested:

- Native tests: `35/35`
- Existing V1 tests: `44/44`
- Duplicate session names now select newest active agent.
- Lifecycle `state` takes precedence over secondary `status`; blocked sessions without `waitingFor` map to `unknown`.

## Retest Gate

Authenticate Claude Code through claude.ai or an Anthropic Console API key, confirm the terminal no longer reports `Channels are not currently available`, then rerun R0 from Experiment 01. Do not implement R2 broker code before all six R0 criteria pass.
