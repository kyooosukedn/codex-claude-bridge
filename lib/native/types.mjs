// lib/native/types.mjs
// Shared JSDoc types for lib/native/. No runtime exports; type-only.

/**
 * @typedef {readonly [number, number, number]} VersionTuple
 */

/**
 * @typedef {Object} PreflightResult
 * @property {string} timestamp
 * @property {string} platform
 * @property {{ raw: string, parsed: VersionTuple | null, target: string, ok: boolean }} claude
 * @property {{ raw: string, parsed: readonly [number, number], target: string, ok: boolean }} node
 * @property {string[]} blockers
 * @property {boolean} allOk
 */

/**
 * @typedef {Object} NativeAgent
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [status]
 * @property {string} [waitingFor]
 * @property {string} [cwd]
 * @property {string} [model]
 */

/**
 * @typedef {"starting" | "consent_pending" | "ready" | "idle" | "thinking" | "needs_input" | "permission_prompt" | "done" | "crashed" | "stopped" | "waking" | "killed" | "unknown"} BrokerState
 */

/**
 * Subset of {@link BrokerState} that can be derived directly from a native
 * agent poll. Broker-only states (starting, consent_pending, ready, waking,
 * killed) are never returned by mapNativeState.
 * @typedef {"idle" | "thinking" | "needs_input" | "permission_prompt" | "done" | "crashed" | "stopped" | "unknown"} NativeMappableState
 */
