// Bounded, guarded confirmation for slash-command delivery.
//
// Claude Code v2.1.218 ships slash autocomplete: the first Enter after pasting
// a slash command only ACCEPTS the autocomplete suggestion, leaving the command
// staged in the active input (`> /model default`). A second Enter is needed to
// actually submit it — but blindly double-Enter is dangerous (it can fire a
// command twice, or submit whatever the user had staged).
//
// This module performs ONE bounded, guarded confirmation Enter. After the
// initial paste+Enter it settles, captures the pane, and inspects the BOTTOM
// active input line only:
//
//   - no input prompt visible (thinking / busy)        -> no Enter (executing)
//   - empty input prompt (idle)                        -> no Enter (executed)
//   - active input EXACTLY equals the submitted command-> ONE Enter (staged)
//   - active input differs                             -> no Enter (different)
//
// At most one confirmation Enter is ever sent. Everything is injected (capture,
// sendEnter, clock, sleep) so it is fully deterministic under `node --test` and
// never touches ccmux/tmux/Claude. ANSI escapes, NBSP, and whitespace are
// normalized before the exact comparison so a styled prompt (`[36m>[0m ...`) and
// a non-breaking space paste still match the plain command.

const ANSI_RE = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const NBSP_RE = /[     ​]/g;

export function normalizeCommand(value) {
  const text = String(value ?? "");
  const stripped = text.replace(ANSI_RE, "").replace(NBSP_RE, " ");
  return stripped.replace(/\s+/g, " ").trim();
}

// Return the content of the BOTTOM active input prompt in a captured pane, or
// null when no `>` input prompt is present (thinking/idle/scrollback only).
// An empty prompt (`> ` with nothing after it) returns "" — distinct from null
// because an empty idle prompt means "command already executed", not "no
// prompt". We scan from the bottom so a command echoed higher in scrollback is
// ignored in favor of the live bottom prompt.
export function extractActiveInput(pane) {
  const text = String(pane ?? "");
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // Strip ANSI / NBSP / extra whitespace from the raw line first so a styled
    // prompt (`\x1b[36m>\x1b[0m ...`) still matches the plain `>` input pattern.
    const line = normalizeCommand(lines[i]);
    const match = line.match(/^\s*>\s?(.*)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

// Bounded, guarded, at-most-one confirmation Enter for slash delivery.
//
// `capture` is async and returns pane text. `sendEnter` is async and performs
// exactly one Enter when the command is confirmed staged. Returns
// { confirmSent, reason, attempts, activeInput, command }.
//
// Polling policy (at most one Enter, only on an exact staged match):
//   - staged (active input === command)        -> ONE Enter, done.
//   - executed (empty idle prompt)             -> definitive: stop, no Enter.
//   - different (non-empty, not the command)   -> definitive: stop, no Enter.
//   - thinking (no input prompt)               -> NON-definitive: poll again.
// `thinking` is the one transient we poll through: a settling autocomplete can
// render busy for a frame before showing the staged command, and a command that
// submitted on the first Enter goes thinking -> executed. Polling lets us still
// catch a delayed-staged command. The budget (`pollAttempts`) bounds the wait;
// `pollIntervalMs` paces the polls. We never Enter on thinking/executed/different.
//
// reason values:
//   - "autocomplete-staged": active input matched the command; ONE Enter sent.
//   - "executed":            empty idle prompt; command already ran. No Enter.
//   - "thinking":            no input prompt; pane stayed busy through the budget.
//   - "different":           active input differs from the command. No Enter.
export async function confirmSlashDelivery({
  text,
  capture,
  sendEnter,
  now,
  sleep,
  settleMs = 120,
  pollAttempts = 3,
  pollIntervalMs = 150,
}) {
  const command = normalizeCommand(text);
  // Let the autocomplete accept settle before we read the pane.
  if (typeof sleep === "function" && settleMs > 0) {
    await sleep(settleMs);
  }

  const maxAttempts = Math.max(1, pollAttempts);
  let attempts = 0;
  let activeInput = null;
  let reason = "thinking";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const pane = await capture();
    activeInput = extractActiveInput(pane);

    if (activeInput === command) {
      await sendEnter();
      return { confirmSent: true, reason: "autocomplete-staged", attempts, activeInput, command };
    }
    if (activeInput === "") {
      // Empty idle prompt: the first Enter already submitted the command.
      // Definitive — stop early, no confirmation Enter.
      reason = "executed";
      break;
    }
    if (activeInput !== null) {
      // Non-empty input that is NOT the command: a different input is staged.
      // Definitive — stop early, never Enter someone else's staged input.
      reason = "different";
      break;
    }
    // activeInput === null: no input prompt (thinking/busy). The one transient
    // we poll through — pace the next attempt and continue.
    reason = "thinking";
    if (attempt < maxAttempts && typeof sleep === "function" && pollIntervalMs > 0) {
      await sleep(pollIntervalMs);
    }
  }

  return { confirmSent: false, reason, attempts, activeInput, command };
}
