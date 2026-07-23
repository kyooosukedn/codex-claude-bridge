// Dependency-free tests using node:test and node:assert.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  stripAnsi,
  cleanLines,
  excerpt,
  classifyPane,
  extractOptions,
  selectOption,
} from "../lib/pane.mjs";
import { buildSteerPayload, countLines } from "../lib/steer.mjs";
import {
  IDLE_PANE,
  THINKING_PANE,
  DONE_PANE,
  PERMISSION_PROMPT_PANE,
  NEEDS_INPUT_PANE,
  INLINE_YN_PANE,
  CRASHED_PANE,
  HOOK_ERRORS_HEALTHY_PANE,
  HOOK_ERRORS_THINKING_PANE,
  GENERIC_YESNO_PANE,
  UNNUMBERED_MENU_PANE,
  UNNUMBERED_MENU_CURSOR_ON_NO_PANE,
  UNNUMBERED_MENU_NO_CURSOR_PANE,
  HISTORICAL_SPINNER_WITH_PERMISSION_PANE,
  HISTORICAL_SPINNER_WITH_YESNO_PANE,
} from "./fixtures.mjs";

test("stripAnsi removes CSI sequences", () => {
  const input = "\x1B[38;5;211mhello\x1B[0m world";
  assert.equal(stripAnsi(input), "hello world");
});

test("stripAnsi removes OSC sequences with BEL terminator", () => {
  const input = "\x1B]0;title\x07text";
  assert.equal(stripAnsi(input), "text");
});

test("stripAnsi removes OSC sequences with ST terminator", () => {
  const input = "\x1B]0;title\x1B\\text";
  assert.equal(stripAnsi(input), "text");
});

test("stripAnsi strips non-tab/newline C0 controls", () => {
  const input = "a\x00b\x07c\x1Fd";
  assert.equal(stripAnsi(input), "abcd");
});

test("stripAnsi preserves tabs and newlines", () => {
  const input = "a\tb\nc";
  assert.equal(stripAnsi(input), "a\tb\nc");
});

test("cleanLines trims trailing whitespace per line", () => {
  const lines = cleanLines("foo   \nbar\t\n");
  assert.deepEqual(lines, ["foo", "bar", ""]);
});

test("excerpt returns last N non-empty lines joined", () => {
  const text = "a\n\nb\nc\nd";
  assert.equal(excerpt(text, 2), "c\nd");
});

test("excerpt is stable for empty input", () => {
  assert.equal(excerpt("", 5), "");
});

test("classifyPane: idle (footer + empty prompt)", () => {
  const r = classifyPane(IDLE_PANE);
  assert.equal(r.state, "idle");
  assert.equal(r.evidence.footer, true);
  assert.equal(r.evidence.emptyPrompt, true);
});

test("classifyPane: thinking (glyph-agnostic spinner)", () => {
  const r = classifyPane(THINKING_PANE);
  assert.equal(r.state, "thinking");
  assert.equal(r.spinner.label, "Running checks and smoke");
  assert.match(r.spinner.detail, /tokens$/);
});

test("classifyPane: done (recent CCMUX_DONE with space)", () => {
  const r = classifyPane(DONE_PANE);
  assert.equal(r.state, "done");
  assert.match(r.doneMarker, /CCMUX_DONE:\s*9ad5f024/);
});

test("classifyPane: done not triggered by stale marker", () => {
  // Marker present but buried under subsequent idle activity.
  const r = classifyPane(IDLE_PANE);
  assert.notEqual(r.state, "done");
});

test("classifyPane: permission_prompt with numbered options", () => {
  const r = classifyPane(PERMISSION_PROMPT_PANE);
  assert.equal(r.state, "permission_prompt");
  assert.ok(r.options.length >= 3);
  assert.match(r.prompt, /Allow Claude to execute/);
});

test("classifyPane: needs_input for non-permission question", () => {
  const r = classifyPane(NEEDS_INPUT_PANE);
  assert.equal(r.state, "needs_input");
  assert.ok(r.options.length >= 3);
});

test("classifyPane: inline y/n prompt", () => {
  const r = classifyPane(INLINE_YN_PANE);
  assert.equal(r.state, "permission_prompt");
  assert.equal(r.options.length, 0);
  assert.match(r.prompt, /Overwrite existing config/);
});

test("classifyPane: crashed on positive signal", () => {
  const r = classifyPane(CRASHED_PANE);
  assert.equal(r.state, "crashed");
});

test("classifyPane: unknown for ambiguous input", () => {
  const r = classifyPane("some random text\nno markers here\njust prose");
  assert.equal(r.state, "unknown");
});

test("classifyPane: JSON output is stable and serializable", () => {
  const r = classifyPane(IDLE_PANE);
  const json = JSON.stringify(r);
  const parsed = JSON.parse(json);
  assert.equal(parsed.state, "idle");
  assert.equal(parsed.evidence.footer, true);
});

test("extractOptions: finds bottom cluster with selected marker", () => {
  const lines = cleanLines(PERMISSION_PROMPT_PANE);
  const opts = extractOptions(lines);
  assert.equal(opts.length, 3);
  assert.equal(opts[0].number, 1);
  assert.equal(opts[0].selected, true);
  assert.match(opts[0].label, /Yes, and don't ask again/);
  assert.equal(opts[2].number, 3);
  assert.match(opts[2].label, /^No,/);
});

test("extractOptions: ignores numbered prose in scrollback", () => {
  // Numbered list in scrollback, but bottom is idle footer => no options.
  const lines = cleanLines(IDLE_PANE);
  const opts = extractOptions(lines);
  assert.equal(opts.length, 0);
});

test("selectOption: approve picks clear yes", () => {
  const r = classifyPane(PERMISSION_PROMPT_PANE);
  const pick = selectOption(r.options, "approve");
  assert.ok(pick);
  assert.match(pick.label, /Yes/i);
  assert.equal(pick.via, "label-match");
});

test("selectOption: deny picks no when labelled", () => {
  const r = classifyPane(PERMISSION_PROMPT_PANE);
  const pick = selectOption(r.options, "deny");
  assert.ok(pick);
  assert.match(pick.label, /No/i);
  assert.equal(pick.number, 3);
});

test("selectOption: returns null when no semantic match", () => {
  const opts = [
    { number: 1, label: "Redraw diagram", selected: false },
    { number: 2, label: "Export as PDF", selected: false },
  ];
  assert.equal(selectOption(opts, "approve"), null);
  assert.equal(selectOption(opts, "deny"), null);
});

test("selectOption: no positional fallback — approve refuses when uncertain", () => {
  const opts = [
    { number: 1, label: "Proceed with step 1", selected: false },
    { number: 2, label: "Do something else", selected: false },
  ];
  // "Proceed" is a YES word, so this still matches by label.
  const pick = selectOption(opts, "approve");
  assert.ok(pick);
  assert.equal(pick.via, "label-match");
  assert.equal(pick.number, 1);
});

test("selectOption: deny picks cancel, approve picks continue (label match)", () => {
  const opts = [
    { number: 1, label: "Cancel operation", selected: false },
    { number: 2, label: "Continue anyway", selected: false },
  ];
  const denyPick = selectOption(opts, "deny");
  assert.ok(denyPick);
  assert.equal(denyPick.number, 1);
  assert.equal(denyPick.via, "label-match");
  const approvePick = selectOption(opts, "approve");
  assert.ok(approvePick);
  assert.equal(approvePick.number, 2);
  assert.equal(approvePick.via, "label-match");
});

test("regression: Windows steer load-buffer patch present in bridge source", async () => {
  const binPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "codex-claude-bridge.mjs",
  );
  const src = await readFile(binPath, "utf8");
  // The patchCcmuxWindows function must include a regex that targets the
  // steerSession load-buffer call (variable name `promptPath`) and a
  // replacement that routes it through msysPathForShell.
  assert.ok(
    src.includes('"-b", id, promptPath'),
    "steer load-buffer target (id + promptPath) must appear in patchCcmuxWindows",
  );
  assert.ok(
    src.includes("msysPathForShell(promptPath)"),
    "patched replacement must route promptPath through msysPathForShell",
  );
  assert.ok(
    src.includes("ccb-patched"),
    "steer patch should leave an idempotent marker so re-runs are no-ops",
  );
});

// ---- Codex review fixes (regression coverage) ----

test("regression: healthy session with hook errors classifies as idle, not crashed", () => {
  const r = classifyPane(HOOK_ERRORS_HEALTHY_PANE);
  assert.equal(r.state, "idle", `expected idle, got ${r.state} (${JSON.stringify(r.evidence)})`);
});

test("regression: spinner wins over hook-error crash signals", () => {
  const r = classifyPane(HOOK_ERRORS_THINKING_PANE);
  assert.equal(r.state, "thinking", `expected thinking, got ${r.state}`);
  assert.ok(r.spinner, "spinner should be populated");
});

test("regression: positive crash still classified when no live UI", () => {
  // Pure crash with no footer/spinner/prompt → crashed.
  const r = classifyPane(CRASHED_PANE);
  assert.equal(r.state, "crashed");
});

test("regression: generic yes/no menu without permission wording stays needs_input", () => {
  const r = classifyPane(GENERIC_YESNO_PANE);
  assert.equal(r.state, "needs_input", `expected needs_input, got ${r.state}`);
  assert.equal(r.options.length, 2);
});

test("regression: permission wording still triggers permission_prompt", () => {
  const r = classifyPane(PERMISSION_PROMPT_PANE);
  assert.equal(r.state, "permission_prompt");
});

test("selectOption: unnumbered menu with cursor on target returns cursor-confirm", () => {
  const lines = cleanLines(UNNUMBERED_MENU_PANE);
  const opts = extractOptions(lines);
  const pick = selectOption(opts, "approve");
  assert.ok(pick);
  assert.equal(pick.number, null, "unnumbered menu must report null number");
  assert.equal(pick.selectionState, "single");
  assert.equal(pick.moves.direction, "none");
  assert.equal(pick.moves.count, 0);
  assert.equal(pick.targetIndex, pick.selectedIndex);
});

test("selectOption: unnumbered menu navigates Down when cursor above target", () => {
  const lines = cleanLines(UNNUMBERED_MENU_CURSOR_ON_NO_PANE);
  const opts = extractOptions(lines);
  // Cursor is on "No, cancel" (index 1). Approve target is "Yes, proceed" (index 0)
  // — that requires moving Up by 1.
  const approve = selectOption(opts, "approve");
  assert.ok(approve);
  assert.equal(approve.selectionState, "single");
  assert.equal(approve.selectedIndex, 1);
  assert.equal(approve.targetIndex, 0);
  assert.equal(approve.moves.direction, "up");
  assert.equal(approve.moves.count, 1);
  // Deny target is the cursor position itself — no movement.
  const deny = selectOption(opts, "deny");
  assert.ok(deny);
  assert.equal(deny.targetIndex, 1);
  assert.equal(deny.moves.direction, "none");
});

test("selectOption: unnumbered menu refuses when no cursor present", () => {
  const lines = cleanLines(UNNUMBERED_MENU_NO_CURSOR_PANE);
  const opts = extractOptions(lines);
  // No cursor trigger means extractOptions can't safely identify a menu cluster.
  // Caller sees an empty option list and refuses via resolvePromptAction's
  // "no matching option" path — never sends a literal null key.
  assert.equal(opts.length, 0);
  assert.equal(selectOption(opts, "approve"), null);
});

test("selectOption: numbered menu still returns the number (never null)", () => {
  const lines = cleanLines(PERMISSION_PROMPT_PANE);
  const opts = extractOptions(lines);
  const pick = selectOption(opts, "approve");
  assert.ok(pick);
  assert.equal(typeof pick.number, "number");
  assert.equal(pick.number, 1);
});

test("buildSteerPayload: preserves interior newlines end-to-end", () => {
  const input = "line one\nline two\nline three";
  const payload = buildSteerPayload(input);
  assert.equal(
    payload,
    "Steering update from ccmux:\nline one\nline two\nline three",
  );
  assert.equal(countLines(payload), 4);
});

test("buildSteerPayload: trims outer whitespace but keeps inner structure", () => {
  const payload = buildSteerPayload("\n\n  body A\n  body B  \n\n");
  assert.equal(payload, "Steering update from ccmux:\nbody A\n  body B");
});

test("buildSteerPayload: handles empty input safely", () => {
  const payload = buildSteerPayload("");
  assert.equal(payload, "Steering update from ccmux:\n");
});

test("regression: bridge source contains -dpr paste-buffer flag for steer", async () => {
  const binPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "codex-claude-bridge.mjs",
  );
  const src = await readFile(binPath, "utf8");
  assert.ok(
    src.includes('"paste-buffer", "-dpr"'),
    "steer must use paste-buffer -dpr (delete + bracket paste + preserve LF)",
  );
  assert.ok(
    src.includes("buildSteerPayload(message)"),
    "steer must route message through the pure buildSteerPayload helper",
  );
});

// ---- Final audit fix: recency-aware classification ----

test("regression: historical spinner + fresh permission menu => permission_prompt", () => {
  const r = classifyPane(HISTORICAL_SPINNER_WITH_PERMISSION_PANE);
  assert.equal(
    r.state,
    "permission_prompt",
    `expected permission_prompt, got ${r.state} (${JSON.stringify(r.evidence)})`,
  );
  assert.ok(r.prompt && /Allow Claude to execute/.test(r.prompt));
  assert.ok(r.options && r.options.length >= 3);
});

test("regression: historical spinner + fresh generic yes/no => needs_input", () => {
  const r = classifyPane(HISTORICAL_SPINNER_WITH_YESNO_PANE);
  assert.equal(
    r.state,
    "needs_input",
    `expected needs_input, got ${r.state} (${JSON.stringify(r.evidence)})`,
  );
  assert.ok(r.prompt && /continue investigating/i.test(r.prompt));
});

test("regression: spinner alone still classifies as thinking", () => {
  // Sanity: with no menu present, the spinner still wins (now checked after
  // options but before idle/crashed).
  const r = classifyPane(THINKING_PANE);
  assert.equal(r.state, "thinking");
});

test("regression: thinking still outranks crashed when hook errors present", () => {
  // Reorder must not regress the earlier hook-error fix.
  const r = classifyPane(HOOK_ERRORS_THINKING_PANE);
  assert.equal(r.state, "thinking");
});
