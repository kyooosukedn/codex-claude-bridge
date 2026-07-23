// Pure helpers for steer message construction. Kept separate from
// bin/ so tests can verify multiline preservation without invoking tmux.

// Returns the exact string that steerMessage writes to the paste buffer.
// Trims outer whitespace; preserves all interior newlines verbatim.
export function buildSteerPayload(message) {
  const trimmed = String(message ?? "").replace(/^\s+|\s+$/g, "");
  return `Steering update from ccmux:\n${trimmed}`;
}

// Count logical lines in a payload (used for telemetry and tests).
export function countLines(payload) {
  return String(payload).split(/\r?\n/).length;
}
