import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCommandJournal } from "../lib/command-journal.mjs";

const BIN = fileURLToPath(
  new URL("../bin/codex-claude-bridge.mjs", import.meta.url),
);

test("commands and command-status report durable observed state", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-commands-cli-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const journal = createCommandJournal({
    rootDir: path.join(home, "journal"),
  });
  await journal.recordTransition({
    commandId: "command-1",
    session: "alpha",
    commandClass: "prompt",
    state: "released",
    attempt: 1,
    ack: "injected",
    safeToRetry: false,
    reason: "pane-changed",
  });

  const env = { ...process.env, CCB_HOME: home };
  const list = spawnSync(
    process.execPath,
    [BIN, "commands", "--session", "alpha", "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(list.status, 0, list.stderr);
  const records = JSON.parse(list.stdout);
  assert.equal(records.length, 1);
  assert.equal(records[0].currentState, "released");
  assert.equal(records[0].ack, "injected");

  const status = spawnSync(
    process.execPath,
    [BIN, "command-status", "command-1", "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).reason, "pane-changed");
});
