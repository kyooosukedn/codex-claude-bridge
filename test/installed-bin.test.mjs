import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("CLI runs when package path is a symlink or npm-style junction", (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ccb-linked-bin-"));
  const linkedRoot = path.join(tempRoot, "codex-claude-bridge");
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  symlinkSync(REPO_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const binary = path.join(linkedRoot, "bin", "codex-claude-bridge.mjs");
  const result = spawnSync(process.execPath, [binary, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-claude-bridge/);
  assert.match(result.stdout, /Usage:/);
});
