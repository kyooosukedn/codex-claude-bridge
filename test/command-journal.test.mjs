import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createCommandJournal,
  recoveryVerdict,
} from "../lib/command-journal.mjs";

async function tempJournal() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-journal-"));
  return {
    rootDir,
    journal: createCommandJournal({
      rootDir,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      randomUUID: () => "temp-1",
      isProcessAlive: () => false,
    }),
  };
}

test("journal atomically preserves lifecycle metadata without prompt text", async (t) => {
  const { rootDir, journal } = await tempJournal();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await journal.recordTransition({
    commandId: "command-1",
    session: "alpha",
    commandClass: "prompt",
    state: "queued",
    attempt: 1,
  });
  await journal.recordTransition({
    commandId: "command-1",
    session: "alpha",
    commandClass: "prompt",
    state: "injecting",
    attempt: 1,
    safeToRetry: false,
  });

  const record = await journal.readCommand("alpha", "command-1");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.currentState, "injecting");
  assert.equal(record.safeToRetry, false);
  assert.deepEqual(
    record.transitions.map((transition) => transition.state),
    ["queued", "injecting"],
  );
  assert.doesNotMatch(JSON.stringify(record), /promptText|hello world/);

  const stat = await fs.stat(
    path.join(rootDir, "alpha", "command-1.json"),
  );
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("journal rejects fields outside the redacted schema", async (t) => {
  const { rootDir, journal } = await tempJournal();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await assert.rejects(
    journal.recordTransition({
      commandId: "command-1",
      session: "alpha",
      commandClass: "prompt",
      state: "queued",
      attempt: 1,
      prompt: "do not persist me",
    }),
    /unsupported journal field: prompt/,
  );
});

test("malformed command records fail closed", async (t) => {
  const { rootDir, journal } = await tempJournal();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "alpha"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "alpha", "command-1.json"),
    '{"schemaVersion":1',
  );

  await assert.rejects(
    journal.readCommand("alpha", "command-1"),
    (error) => error.code === "JOURNAL_MALFORMED",
  );
});

test("restart verdict never retries a possibly injected command", () => {
  assert.deepEqual(recoveryVerdict({ currentState: "queued" }), {
    state: "interrupted",
    ack: "not-injected",
    safeToRetry: true,
    reason: "restart-before-transport",
  });
  assert.deepEqual(recoveryVerdict({ currentState: "pre-write" }), {
    state: "interrupted",
    ack: "not-injected",
    safeToRetry: true,
    reason: "restart-before-transport",
  });
  assert.deepEqual(recoveryVerdict({ currentState: "injecting" }), {
    state: "interrupted",
    ack: "uncertain",
    safeToRetry: false,
    reason: "restart-during-transport",
  });
  assert.equal(recoveryVerdict({ currentState: "released" }), null);
});

test("reconcile persists conservative restart verdicts", async (t) => {
  const { rootDir, journal } = await tempJournal();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await journal.recordTransition({
    commandId: "command-1",
    session: "alpha",
    commandClass: "prompt",
    state: "injecting",
    attempt: 1,
  });

  const reconciled = await journal.reconcile({ session: "alpha" });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].ack, "uncertain");
  assert.equal(reconciled[0].safeToRetry, false);
  const record = await journal.readCommand("alpha", "command-1");
  assert.equal(record.currentState, "interrupted");
  assert.equal(record.ack, "uncertain");
});

test("a new process reconciles records left by a dead owner process", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccb-journal-dead-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(
    path.resolve("lib/command-journal.mjs"),
  ).href;
  const script = `
    import { createCommandJournal } from ${JSON.stringify(moduleUrl)};
    const journal = createCommandJournal({ rootDir: process.argv[1] });
    await journal.recordTransition({
      commandId: "dead-command",
      session: "alpha",
      commandClass: "prompt",
      state: "injecting",
      attempt: 1
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, rootDir],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);

  const journal = createCommandJournal({ rootDir });
  const reconciled = await journal.reconcile({ session: "alpha" });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].currentState, "interrupted");
  assert.equal(reconciled[0].ack, "uncertain");
  assert.equal(reconciled[0].safeToRetry, false);
});

test("reconcile leaves live and unknown owners byte-for-byte unchanged", async (t) => {
  for (const [name, alive] of [["live", true], ["unknown", null]]) {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `ccb-journal-${name}-`),
    );
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const journal = createCommandJournal({
      rootDir,
      isProcessAlive: () => alive,
    });
    await journal.recordTransition({
      commandId: `${name}-command`,
      session: "alpha",
      commandClass: "prompt",
      state: "injecting",
      attempt: 1,
    });
    const filePath = path.join(
      rootDir,
      "alpha",
      `${name}-command.json`,
    );
    const before = await fs.readFile(filePath, "utf8");

    assert.deepEqual(await journal.reconcile({ session: "alpha" }), []);
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  }
});
