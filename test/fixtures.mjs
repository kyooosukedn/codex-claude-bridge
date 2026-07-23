// Canned pane fixtures for tests. Mix of real captures (lightly trimmed)
// and synthetic ones for states we could not observe live (permission_prompt,
// needs_input, crashed) because the smoke sessions run with
// --dangerously-skip-permissions and never crashed.

export const IDLE_PANE = `
  ⎿  SessionStart:startup says: ready

● bridge package works

  CCMUX_DONE:61f5ba28-55da-4200-bf1a-6ef36d0bfe74

✻ Baked for 28s

─────────────────────────────────────────────────────────────────── ccb-smoke ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ work ░░░░░░░░░░ 6%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Captured from a live thinking session (robustness-v1). Spinner glyph
// rotates between *, ✶, ✢, etc. — classifier must be glyph-agnostic.
export const THINKING_PANE = `
  ⎿  Updated lib/pane.mjs

● Bash(node ./bin/codex-claude-bridge.mjs inspect --session robustness-v1)
  ⎿  Running…

✢ Running checks and smoke… (13m 36s · ↓ 36.0k tokens)
  ⎿  ■ Run tests and smoke against live tmux
     ■ Fix Windows steer load-buffer path bug
     □ Add dependency-free Node tests with fixtures
─────────────────────────────────────────────────────────────────── robustness-v1 ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ codex-claude-bridge ███░░░░░░░ 34%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Done marker at the very bottom (most recent line). The marker sometimes
// has a space after the colon — regex must tolerate that.
export const DONE_PANE = `
● Wrote summary

  CCMUX_DONE: 9ad5f024-83da-45e2-b74a-4a05de3e143f

✻ Baked for 14s
`;

// Synthetic: Claude Code permission prompt for a bash command.
// Pattern based on documented CC v2 TUI layout.
export const PERMISSION_PROMPT_PANE = `
  user wants to run a command

  ⎿  Tool: Bash

  ? Allow Claude to execute \`npm install\`?

  ❯ 1. Yes, and don't ask again for this session
    2. Yes, but ask again next time
    3. No, and stop

─────────────────────────────────────────────────────────────────── session-x ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ████░░░░░░ 40%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Synthetic: generic input question (not a permission ask).
export const NEEDS_INPUT_PANE = `
● I found 3 failing tests. How would you like to proceed?

  ❯ 1. Fix all three at once
    2. Fix them one at a time
    3. Show me the failures first

─────────────────────────────────────────────────────────────────── session-y ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ██████░░░░ 60%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Inline y/n style (older CC UI or compact prompts).
export const INLINE_YN_PANE = `
● Ready to write the file.

? Overwrite existing config.yaml? (y/n)

─────────────────────────────────────────────────────────────────── session-z ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ████████░░ 80%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Synthetic: explicit crash signal.
export const CRASHED_PANE = `
● Working...

Assertion failed: 0 && "stream closed"
panic: runtime error: index out of range
goroutine 1 [running]:
$ `;

// Healthy session with nonblocking hook errors in scrollback. The word
// "command not found" appears in startup-hook output, but the Claude Code
// footer + empty prompt is intact → must classify as idle, NOT crashed.
// Captured from real ccb-smoke startup.
export const HOOK_ERRORS_HEALTHY_PANE = `
╭─── Claude Code v2.1.150 ─────────────────────────────────────────────────────╮

  ⎿  SessionStart:startup hook error      ⎿  Failed with non-blocking status
                                             code: /usr/bin/bash: line 1:
                                             C:UsersdanieAppDataRoamingnpmnode_m
                                             oduleschrome-devtools-axidistbinchr
                                             ome-devtools-axi.js: command not
                                             found
  ⎿  SessionStart:startup hook error      ⎿  Failed with non-blocking status
                                             code: /usr/bin/bash: line 1:
                                             lavish-axidistcli.mjs: command not
                                             found

● bridge package works

  CCMUX_DONE:61f5ba28-55da-4200-bf1a-6ef36d0bfe74

✻ Baked for 28s

─────────────────────────────────────────────────────────────────── ccb-smoke ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ work ░░░░░░░░░░ 6%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Healthy session WITH a spinner AND hook errors in scrollback. Must classify
// as thinking, not crashed, even though hook errors mention "command not found".
export const HOOK_ERRORS_THINKING_PANE = `
  ⎿  SessionStart:startup hook error      ⎿  Failed with non-blocking status
                                             code: lavish-axidistcli.mjs:
                                             command not found

● Bash(npm test)
  ⎿  Running…

✢ Running tests… (2m 10s · ↓ 4.2k tokens)
─────────────────────────────────────────────────────────────────── session-x ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ██░░░░░░░░ 22%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Generic yes/no question with no permission/tool/action evidence.
// Must remain needs_input, NOT permission_prompt.
export const GENERIC_YESNO_PANE = `
● I found three issues.

? Would you like me to continue investigating?

  ❯ 1. Yes
    2. No

─────────────────────────────────────────────────────────────────── session-y ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ████░░░░░░ 40%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Unnumbered cursor menu (CC TUI without numeric prefixes). Caller must
// navigate via Up/Down from the single selected option.
export const UNNUMBERED_MENU_PANE = `
● Tool use:

  ❯ Yes, proceed
    No, cancel
    Always allow

─────────────────────────────────────────────────────────────────── session-z ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ██████░░░░ 60%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Same shape but the cursor sits on a non-target option — approve must
// navigate Down to reach "Yes, proceed".
export const UNNUMBERED_MENU_CURSOR_ON_NO_PANE = `
● Tool use:

    Yes, proceed
  ❯ No, cancel
    Always allow

─────────────────────────────────────────────────────────────────── session-z ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ██████░░░░ 60%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Unnumbered menu with no visible cursor — navigation impossible, must refuse.
export const UNNUMBERED_MENU_NO_CURSOR_PANE = `
● Tool use:

    Yes, proceed
    No, cancel
    Always allow

─────────────────────────────────────────────────────────────────────────── session-w ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ██████░░░░ 60%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Recency trap: a HISTORICAL spinner from a previous turn is still within
// the 40-line scan window, but a new permission menu is now visible at the
// bottom. Must classify as permission_prompt, NOT thinking.
export const HISTORICAL_SPINNER_WITH_PERMISSION_PANE = `
● Bash(npm test)
  ⎿  Ran 39 tests in 1.2s. All passing.

✢ Running tests… (2m 10s · ↓ 4.2k tokens)

● Now I want to install a dependency.

  ⎿  Tool: Bash

  ? Allow Claude to execute \`npm install lodash\`?

  ❯ 1. Yes, and don't ask again for this session
    2. Yes, but ask again next time
    3. No, and stop

─────────────────────────────────────────────────────────────────── session-q ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ████████░░ 80%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Same recency trap but the fresh menu is a generic yes/no (no permission
// wording). Must classify as needs_input, NOT thinking.
export const HISTORICAL_SPINNER_WITH_YESNO_PANE = `
● Bash(npm test)
  ⎿  Ran 39 tests in 1.2s. All passing.

✢ Running tests… (2m 10s · ↓ 4.2k tokens)

● I found three failing tests.

? Would you like me to continue investigating?

  ❯ 1. Yes
    2. No

─────────────────────────────────────────────────────────────────── session-r ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ project ████████░░ 80%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// Numbered prose from a steering message rendered near the bottom of the
// pane. The footer and empty `>` prompt are intact — Claude is idle, NOT
// waiting for a menu. Without the cursor-required rule, items 11–13 would
// be misextracted as a 3-option cluster and flip the state to needs_input.
// Discovered via dogfood during docs work.
export const NUMBERED_PROSE_IDLE_PANE = `
  ⎿  Updated docs/ARCHITECTURE.md

● Done. Summary of corrections:

  11. Replaced every ~/.ccmux reference with ~/.pi/ccmux/state.json.
  12. Corrected safeName to preserve case (letters, digits, _, ., -).
  13. Swapped claude-opus-4-7 for the opus pass-through alias.

✻ Baked for 28s

─────────────────────────────────────────────────────────────────── ccb-smoke ──
>
────────────────────────────────────────────────────────────────────────────────
  glm-5.2 │ work ░░░░░░░░░░ 6%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

