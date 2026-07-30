// Regression: a tmux/ccmux long-history/CR rendering form joins the empty `>`
// prompt and the following horizontal separator onto ONE captured line:
//   ><NBSP><many spaces>────────────────────────────────...
// The canonical parser must still classify this as an empty/idle prompt, but
// ONLY when the suffix is purely a long box-drawing separator (rendering
// chrome) and a footer is present. Arbitrary text after `>` (staged slash,
// queued-message text, menus, short dashes) must remain non-idle.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyPane } from "../lib/pane.mjs";

const SEP = "─".repeat(72);
const JOINED_PROMPT_LINE = `> ${" ".repeat(76)}${SEP}`;

function footerLines() {
  return [
    "  glm-5.2 │ work ░░░░░░░░░░ 6%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
}

function pane(lines) {
  return [...lines, ...footerLines()].join("\n");
}

const IDLE_JOINED = pane([
  "● bridge works",
  "",
  "✻ Baked for 1s",
  "",
  JOINED_PROMPT_LINE,
]);

const STAGED_SLASH = pane(["> /model default"]);
const ARBITRARY_TEXT = pane(["> hello world"]);
const SHORT_BOX_RULE = pane(["> " + "─".repeat(3)]);
const ASCII_DASH_MENU = pane(["> -- choose --"]);

test("joined `>` + long separator + footer classifies as idle (emptyPrompt true)", () => {
  const r = classifyPane(IDLE_JOINED);
  assert.equal(r.state, "idle");
  assert.equal(r.evidence.emptyPrompt, true);
  assert.equal(r.evidence.footer, true);
});

test("staged slash after `>` is NOT idle (emptyPrompt false)", () => {
  const r = classifyPane(STAGED_SLASH);
  assert.equal(r.evidence.emptyPrompt, false);
  assert.notEqual(r.state, "idle");
});

test("arbitrary text after `>` is NOT idle (emptyPrompt false)", () => {
  const r = classifyPane(ARBITRARY_TEXT);
  assert.equal(r.evidence.emptyPrompt, false);
  assert.notEqual(r.state, "idle");
});

test("a short box-drawing run after `>` is NOT empty (below threshold)", () => {
  const r = classifyPane(SHORT_BOX_RULE);
  assert.equal(r.evidence.emptyPrompt, false);
  assert.notEqual(r.state, "idle");
});

test("ASCII dashes / menu after `>` is NOT empty", () => {
  const r = classifyPane(ASCII_DASH_MENU);
  assert.equal(r.evidence.emptyPrompt, false);
  assert.notEqual(r.state, "idle");
});

test("joined separator also works under CRLF + ANSI noise", () => {
  const noisy = IDLE_JOINED.replace(/\n/g, "\r\n").replace(
    ">",
    "[36m>[0m",
  );
  const r = classifyPane(noisy);
  assert.equal(r.state, "idle");
  assert.equal(r.evidence.emptyPrompt, true);
});
