// Pure parsing/classification logic for Claude Code pane captures.
// No I/O. Imported by bin/codex-claude-bridge.mjs and tests.

export const STATES = [
  "idle",
  "thinking",
  "needs_input",
  "permission_prompt",
  "done",
  "crashed",
  "unknown",
];

const DEFAULT_TAIL_LINES = 80;
const DEFAULT_EXCERPT_LINES = 24;
const OPTION_CLUSTER_MAX_DEPTH = 30;

const YES_WORDS = new Set([
  "yes",
  "allow",
  "proceed",
  "continue",
  "accept",
  "approve",
  "confirm",
  "ok",
  "okay",
  "always",
  "trust",
  "install",
  "run",
]);
const NO_WORDS = new Set([
  "no",
  "deny",
  "cancel",
  "reject",
  "stop",
  "abort",
  "skip",
  "decline",
  "never",
]);

const PERMISSION_PROMPT_WORDS = [
  "allow",
  "permission",
  "approve",
  "executing",
  "execute",
  "run command",
  "edit file",
  "write to",
  "overwrite",
  "delete",
  "use bash",
  "use tool",
];

// Strip ANSI escape sequences and other terminal control noise.
// Handles CSI, OSC, single-char ESC sequences, 8-bit C1 controls,
// and strips non-tab/newline C0 controls.
export function stripAnsi(text) {
  return String(text)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function cleanLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""));
}

export function excerpt(text, maxLines = DEFAULT_EXCERPT_LINES) {
  const lines = cleanLines(text).filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

function normalizeLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsOverlap(text, wordSet) {
  const words = normalizeLabel(text).split(" ").filter(Boolean);
  return words.filter((w) => wordSet.has(w));
}

function isOptionTrigger(line) {
  if (!line) return false;
  return (
    /^\s*[❯›»]\s+[A-Za-z]/.test(line) ||
    /^\s*[❯›»]?\s*\(?\d{1,2}[.)]\s+\S/.test(line)
  );
}

function isOptionContinuation(line) {
  if (!line) return false;
  if (!/^\s+/.test(line)) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[─━=]{10,}/.test(trimmed)) return false;
  if (/^⎿/.test(trimmed)) return false;
  if (/^[●✻✶✷✸✹✢✲✱\*o○]/.test(trimmed)) return false;
  if (/^glm-|bypass permissions|shift\+tab/i.test(trimmed)) return false;
  return true;
}

function parseOptionLine(line) {
  const match = line.match(
    /^\s*([❯›»])?\s*\(?(?:(\d{1,2})[.)]?)?\s*(.+?)\s*$/,
  );
  if (!match) return null;
  const marker = match[1] || null;
  const number = match[2] ? Number(match[2]) : null;
  const label = match[3].trim();
  if (!label) return null;
  if (/^[\s─━│*=._-]+$/.test(label)) return null;
  return { marker, number, label, selected: Boolean(marker) };
}

// Find the LAST option cluster by scanning bottom-up for a trigger line
// (cursor or numbered), then expanding to adjacent continuation lines.
// Returns options with their line indices, or [] when no cluster is found
// within OPTION_CLUSTER_MAX_DEPTH lines of the bottom.
export function extractOptions(lines) {
  const cleaned = lines.map((line) => line.replace(/\s+$/g, ""));
  const minIndex = Math.max(0, cleaned.length - OPTION_CLUSTER_MAX_DEPTH);
  let triggerIdx = -1;
  for (let i = cleaned.length - 1; i >= minIndex; i--) {
    if (isOptionTrigger(cleaned[i])) {
      triggerIdx = i;
      break;
    }
  }
  if (triggerIdx === -1) return [];

  let start = triggerIdx;
  while (start > 0 && isOptionContinuation(cleaned[start - 1])) {
    start--;
  }
  let end = triggerIdx;
  while (end < cleaned.length - 1 && isOptionContinuation(cleaned[end + 1])) {
    end++;
  }

  const found = [];
  for (let i = start; i <= end; i++) {
    const line = cleaned[i];
    if (!line.trim()) continue;
    const opt = parseOptionLine(line);
    if (opt && opt.label) {
      found.push({ ...opt, lineIndex: i });
    }
  }
  return found;
}

function findQuestionLine(lines, optionStartIndex) {
  const lowerBound = Math.max(0, optionStartIndex - 6);
  for (let i = optionStartIndex - 1; i >= lowerBound; i--) {
    const line = (lines[i] || "").trim();
    if (!line) continue;
    const stripped = line.replace(/^\s*\?\s*/, "").trim();
    if (/^Do you|^Allow|^How would|^Which|^Select|^Choose|^Would you/i.test(stripped)) {
      return stripped;
    }
    if (stripped.length > 4 && stripped.endsWith("?")) return stripped;
    if (i < optionStartIndex - 1 && stripped.length > 8) break;
  }
  return null;
}

function isPermissionPrompt(question) {
  if (!question) return false;
  const lower = question.toLowerCase();
  return PERMISSION_PROMPT_WORDS.some((word) => lower.includes(word));
}

// Match a Claude Code spinner line, e.g.:
//   "* Gitifying… (1m 34s · ↓ 1.9k tokens)"
//   "✢ Running checks and smoke… (11m 44s · ↓ 31.1k tokens)"
// Glyph-agnostic: CC versions rotate through many Unicode spinner symbols,
// so we require the unique "<glyph> <CapLabel>… (<detail> tokens)" signature.
// Scan a generous window: spinner can sit many lines above the footer
// when tool I/O fills the visible pane.
const SPINNER_SCAN_LINES = 40;
function findSpinnerLine(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - SPINNER_SCAN_LINES); i--) {
    const line = lines[i] || "";
    const active = line.match(
      /^\s*[^A-Za-z0-9\s]\s+([A-Z][\w /-]{1,60}?)\s*(?:…|\.{3})\s*\(([^)]*tokens?[^)]*)\)\s*$/,
    );
    if (active) {
      return {
        kind: "active",
        label: active[1].trim(),
        detail: active[2].trim(),
        lineIndex: i,
      };
    }
  }
  return null;
}

function hasClaudeFooter(lines) {
  const tail = lines.slice(-6).join("\n").toLowerCase();
  return (
    tail.includes("bypass permissions") ||
    tail.includes("shift+tab to cycle") ||
    /shift\+tab/.test(tail)
  );
}

// A line counts as an EMPTY prompt (`>`) in one of these forms:
//   1. bare empty prompt:        `^\s*>\s*$`
//   2. separator then prompt:    `─+\s*>\s*$`  (separator rendered above `>`)
//   3. prompt then separator:    `^\s*>\s*─{N,}\s*$`
// Form 3 covers a tmux/ccmux long-history/CR rendering where the empty `>`
// and the following horizontal box-drawing separator are joined onto one
// captured line, e.g. `><NBSP><spaces>────────...`. It is accepted ONLY when
// the suffix is purely a LONG run of box-drawing horizontal characters
// (U+2500/U+2501, >= HORIZONTAL_RULE_MIN) plus whitespace, so arbitrary text
// after `>` (staged slash, queued-message text, menus, short dashes) stays
// non-idle. \s covers NBSP (U+00A0); ANSI/CRLF are already handled by
// cleanLines upstream.
const HORIZONTAL_RULE_MIN = 8;
const EMPTY_PROMPT_RULE_SUFFIX = /^\s*>\s*[─━]{8,}\s*$/;

export function isEmptyPromptLine(line) {
  if (line == null) return false;
  if (/^\s*>\s*$/.test(line)) return true;
  if (/─+\s*>\s*$/.test(line)) return true;
  return EMPTY_PROMPT_RULE_SUFFIX.test(line);
}

function hasEmptyPromptLine(lines) {
  const recent = lines.slice(-10);
  return recent.some((line) => isEmptyPromptLine(line));
}

function looksCrashed(lines) {
  const joined = lines.slice(-30).join("\n");
  if (/panic:|fatal error|assertion failed|segmentation fault|core dumped|not found:\s*claude\b|claude:\s+command not found/i.test(joined)) {
    return true;
  }
  if (/process exited|process terminated|claude has (crashed|stopped)|stack trace:/i.test(joined)) {
    return true;
  }
  return false;
}

// Classify a captured pane. Conservative: returns "unknown" unless strong evidence.
export function classifyPane(rawText, opts = {}) {
  const tailLines = Number(opts.tailLines) || DEFAULT_TAIL_LINES;
  const excerptLines = Number(opts.excerptLines) || DEFAULT_EXCERPT_LINES;
  const allLines = cleanLines(rawText);
  const tail = allLines.slice(-tailLines);

  const result = {
    state: "unknown",
    prompt: null,
    options: null,
    spinner: null,
    doneMarker: null,
    excerpt: excerpt(rawText, excerptLines),
    evidence: {},
  };

  const footerPresent = hasClaudeFooter(allLines);
  const emptyPrompt = hasEmptyPromptLine(allLines);
  const spinner = findSpinnerLine(allLines);
  const liveUiPresent =
    (spinner && spinner.kind === "active") ||
    (footerPresent && emptyPrompt);

  // 1. Done: explicit CCMUX_DONE marker near the bottom of the tail.
  // Only count the last 8 cleaned lines so a stale marker from an earlier
  // turn doesn't keep the session pinned at "done" forever.
  const recentTail = allLines.slice(-8).join("\n");
  const doneMatches = [
    ...recentTail.matchAll(/CCMUX_DONE:\s*([0-9a-fA-F-]{8,})/g),
  ];
  if (doneMatches.length > 0) {
    const last = doneMatches[doneMatches.length - 1];
    result.doneMarker = last[0];
    result.state = "done";
    result.evidence.doneMarker = last[0];
    // Record whether the done marker coincides with a truly idle frame
    // (empty active prompt + footer) AND whether any spinner/busy signal is
    // still present. A bare done marker is marker-complete, not proof of a
    // quiescent pane (stop hooks can outlive it), so callers can decide
    // injectability from evidence instead of trusting the marker alone.
    result.evidence.footer = footerPresent;
    result.evidence.emptyPrompt = emptyPrompt;
    result.evidence.spinnerActive = Boolean(spinner && spinner.kind === "active");
    result.spinner = spinner && spinner.kind === "active" ? spinner : null;
    return result;
  }

  // 2. Permission / input prompt at the bottom outranks a historical spinner
  //    still visible in the scan window. The spinner scan reaches back ~40
  //    lines, so an older spinner would otherwise mask a fresh prompt.
  //
  //    A cluster classifies as a live prompt only when at least one option
  //    carries a selection cursor (❯/›/»). Real Claude Code menus always
  //    render the cursor on the currently-selected option. Numbered prose
  //    (e.g. items in a steering message rendered by the assistant) has no
  //    cursor and must never become an actionable prompt state.
  const options = extractOptions(tail);
  const hasSelectionCursor = options.some((o) => o.selected);
  if (options.length >= 2 && hasSelectionCursor) {
    const question = findQuestionLine(tail, options[0].lineIndex);
    result.options = options.map(({ number, label, selected }) => ({
      number,
      label,
      selected,
    }));
    result.prompt = question || options[0].label;
    result.state = isPermissionPrompt(question)
      ? "permission_prompt"
      : "needs_input";
    result.evidence.optionCount = options.length;
    result.evidence.questionLine = question;
    result.evidence.selectionCursor = true;
    return result;
  }
  if (options.length >= 2 && !hasSelectionCursor) {
    result.evidence.optionsWithoutCursor = options.length;
  }

  // Inline y/n prompt — only look at the very bottom to avoid scrollback hits.
  const bottomSlice = allLines.slice(-12).join("\n");
  const inline = bottomSlice.match(
    /(?:^|\n)\s*\??\s*([^?\n]{6,120}?\?)\s*[\[\(]?\s*(?:y(?:es)?[\s/|]+n(?:o)?|y[\s/|]+n|n(?:o)?[\s/|]+y(?:es)?)\s*[\]\)]?/i,
  );
  if (inline) {
    const question = inline[1].trim();
    result.prompt = question;
    result.state = isPermissionPrompt(question)
      ? "permission_prompt"
      : "needs_input";
    result.options = [];
    result.evidence.inlineYesNo = true;
    return result;
  }

  // 3. Thinking: active spinner. Checked AFTER prompt evidence so a fresh
  //    permission/input menu at the bottom outranks a historical spinner.
  if (spinner && spinner.kind === "active") {
    result.spinner = { label: spinner.label, detail: spinner.detail };
    result.state = "thinking";
    result.evidence.spinner = `${spinner.label}… (${spinner.detail})`;
    result.evidence.footer = footerPresent;
    return result;
  }

  // 4. Idle: empty `>` prompt + recognizable footer.
  if (footerPresent && emptyPrompt) {
    result.state = "idle";
    result.evidence.footer = true;
    result.evidence.emptyPrompt = true;
    return result;
  }

  // 5. Crashed: positive evidence, AND no healthy live UI supersedes.
  // Hook errors ("command not found" from SessionStart hooks) appear in
  // scrollback while the session itself is healthy — those cases are
  // already captured as idle/thinking above.
  if (looksCrashed(allLines) && !liveUiPresent) {
    result.state = "crashed";
    result.evidence.crashedSignal = true;
    result.evidence.footer = footerPresent;
    result.evidence.emptyPrompt = emptyPrompt;
    return result;
  }

  // 6. Unknown fallthrough. Record why we declined to guess.
  result.evidence.footer = footerPresent;
  result.evidence.emptyPrompt = emptyPrompt;
  result.evidence.tailLines = tail.length;
  result.evidence.crashSignalPresent = looksCrashed(allLines);
  return result;
}

// Pick the best option for approve/deny actions.
// Conservative: never blindly assumes position; requires label evidence.
//
// Returns:
//   {
//     number,         // number | null  (null for unnumbered cursor menus)
//     label,          // string
//     via,            // "label-match"
//     targetIndex,    // index in the input options array
//     selectedIndex,  // index of the currently selected option, or null
//     selectionState, // "none" | "single" | "ambiguous"
//     moves,          // { direction: "none"|"up"|"down", count } from selected to target
//   }
// Returns null when no semantic match is found. Caller must handle
// selectionState before using `moves` for unnumbered menus.
export function selectOption(options, intent) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const wordSet = intent === "deny" ? NO_WORDS : YES_WORDS;
  const antiSet = intent === "deny" ? YES_WORDS : NO_WORDS;

  let best = null;
  let bestScore = 0;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const hits = wordsOverlap(opt.label, wordSet).length;
    const anti = wordsOverlap(opt.label, antiSet).length;
    if (hits === 0 || anti > hits) continue;
    const score = hits - anti;
    if (score > bestScore) {
      best = { opt, index: i };
      bestScore = score;
    }
  }
  if (!best) return null;

  const selectedIndices = options
    .map((o, i) => (o.selected ? i : -1))
    .filter((i) => i >= 0);
  let selectionState = "none";
  let selectedIndex = null;
  if (selectedIndices.length === 1) {
    selectionState = "single";
    selectedIndex = selectedIndices[0];
  } else if (selectedIndices.length > 1) {
    selectionState = "ambiguous";
  }

  let direction = "none";
  let count = 0;
  if (selectedIndex !== null) {
    const delta = best.index - selectedIndex;
    if (delta > 0) {
      direction = "down";
      count = delta;
    } else if (delta < 0) {
      direction = "up";
      count = -delta;
    }
  }

  return {
    number: best.opt.number ?? null,
    label: best.opt.label,
    via: "label-match",
    targetIndex: best.index,
    selectedIndex,
    selectionState,
    moves: { direction, count },
  };
}
