// Filesystem-backed contract for the P1 per-session coordinator.
//
// lib/session-coordinator.mjs ships a production file lock store. These tests
// prove the real-filesystem primitives an in-memory FakeStore cannot: O_EXCL
// across child processes, atomic rename, quarantine containment, the 0600 mode
// on POSIX, and fail-closed handling of a malformed canonical lock.
//
// Acquire / dead-owner-recovery races that drive the same store through real
// child processes live at the bottom of this file (added with Task 3).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createFileLockStore,
  DEFAULT_LOCK_DIR,
  DEFAULT_PRE_WRITE_ATTEMPTS,
} from "../lib/session-coordinator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_URL = pathToFileURL(path.resolve(HERE, "../lib/session-coordinator.mjs")).href;
const IS_POSIX = process.platform !== "win32";

async function mkLockDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ccb-coord-"));
}

function sampleRecord(overrides = {}) {
  return {
    version: 1,
    session: "reviewer",
    ownerToken: "owner-1",
    pid: 4321,
    commandId: "command-1",
    commandClass: "prompt",
    phase: "pre-write",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

// Run a child node process whose -e body is ESM, resolving with stdout/stderr.
function runChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`child exited ${code}\nstdout: ${out}\nstderr: ${err}`));
        return;
      }
      resolve({ out, err });
    });
  });
}

test("exports a default lock dir and pre-write attempt budget", () => {
  assert.equal(typeof DEFAULT_LOCK_DIR, "string");
  assert.ok(DEFAULT_LOCK_DIR.length > 0);
  assert.ok(DEFAULT_PRE_WRITE_ATTEMPTS >= 1);
});

test("createExclusive writes a 0600 record and wins once", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });
  const record = sampleRecord();

  const first = await store.createExclusive(target, record);
  assert.equal(first.created, true);

  const second = await store.createExclusive(target, sampleRecord({ ownerToken: "owner-2" }));
  assert.equal(second.created, false);

  const readBack = await store.read(target);
  assert.equal(readBack.ownerToken, "owner-1");

  if (IS_POSIX) {
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("read returns null for missing and throws malformed for garbage", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });

  assert.equal(await store.read(target), null);

  await fs.writeFile(target, "{not json", { mode: 0o600 });
  await assert.rejects(
    () => store.read(target),
    (error) => error.malformed === true,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("real O_EXCL permits exactly one winner across child processes", async () => {
  const dir = await mkLockDir();
  const target = path.join(dir, "race.lock");
  const record = sampleRecord({ session: "race" });

  const childScript = (token) => `
const { createFileLockStore } = await import(${JSON.stringify(LIB_URL)});
const store = createFileLockStore();
const r = await store.createExclusive(${JSON.stringify(target)}, ${JSON.stringify({ ...record, ownerToken: token })});
process.stdout.write(JSON.stringify(r));
`;

  const tokens = Array.from({ length: 6 }, (_, i) => `child-${i}`);
  const results = await Promise.all(
    tokens.map((token) => runChild(childScript(token)).then(({ out }) => JSON.parse(out))),
  );

  const winners = results.filter((r) => r.created);
  assert.equal(winners.length, 1, `expected one O_EXCL winner, got ${winners.length}`);

  const readBack = await createFileLockStore().read(target);
  assert.equal(readBack.session, "race");
  await fs.rm(dir, { recursive: true, force: true });
});

test("rename moves one generation and never overwrites a quarantine target", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const quarantine = path.join(dir, "reviewer.lock.dead-1.quarantine");
  const store = createFileLockStore({ lockDir: dir });

  await store.createExclusive(canonical, sampleRecord());

  const renamed = await store.rename(canonical, quarantine);
  assert.equal(renamed.renamed, true);
  assert.equal(await store.read(canonical), null);
  const quarantined = await store.read(quarantine);
  assert.equal(quarantined.ownerToken, "owner-1");

  // Re-seed and pre-create the quarantine target: rename must refuse.
  await store.createExclusive(canonical, sampleRecord({ ownerToken: "owner-2" }));
  await fs.writeFile(quarantine, "blocker", { mode: 0o600 });
  const refused = await store.rename(canonical, quarantine);
  assert.equal(refused.renamed, false);
  // Canonical untouched because rename refused to overwrite the quarantine.
  assert.equal((await store.read(canonical)).ownerToken, "owner-2");

  await fs.rm(dir, { recursive: true, force: true });
});

test("rename refuses a quarantine name that escapes the lock directory", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const escape = path.join(dir, "..", "escaped.quarantine");
  const store = createFileLockStore({ lockDir: dir });

  await store.createExclusive(canonical, sampleRecord());
  const refused = await store.rename(canonical, escape);
  assert.equal(refused.renamed, false);
  // Canonical still present; nothing escaped the directory.
  assert.equal((await store.read(canonical)).ownerToken, "owner-1");
  await assert.rejects(() => fs.readFile(path.join(dir, "..", "escaped.quarantine")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("updateIfOwner is atomic and requires token plus command id", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });
  await store.createExclusive(canonical, sampleRecord());

  const wrongToken = await store.updateIfOwner(canonical, "wrong", "command-1", { phase: "injecting" });
  assert.equal(wrongToken.updated, false);
  const wrongCommand = await store.updateIfOwner(canonical, "owner-1", "wrong", { phase: "injecting" });
  assert.equal(wrongCommand.updated, false);

  const ok = await store.updateIfOwner(canonical, "owner-1", "command-1", { phase: "injecting" });
  assert.equal(ok.updated, true);
  assert.equal((await store.read(canonical)).phase, "injecting");
  // No temp siblings leak into the lock directory after the atomic rename.
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ["reviewer.lock"]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("unlinkIfOwner refuses missing, malformed, and mismatched records", async () => {
  const dir = await mkLockDir();
  const canonical = path.join(dir, "reviewer.lock");
  const store = createFileLockStore({ lockDir: dir });

  // Missing.
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, false);

  // Owned, wrong credentials.
  await store.createExclusive(canonical, sampleRecord());
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "wrong")).unlinked, false);
  assert.equal((await store.unlinkIfOwner(canonical, "wrong", "command-1")).unlinked, false);

  // Owned, matching credentials.
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, true);
  assert.equal(await store.read(canonical), null);

  // Malformed canonical lock fails closed (no unlink, no throw).
  await fs.writeFile(canonical, "{garbage", { mode: 0o600 });
  assert.equal((await store.unlinkIfOwner(canonical, "owner-1", "command-1")).unlinked, false);

  await fs.rm(dir, { recursive: true, force: true });
});
