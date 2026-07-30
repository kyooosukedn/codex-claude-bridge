import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;
const ALLOWED_TRANSITION_FIELDS = new Set([
  "commandId",
  "session",
  "commandClass",
  "state",
  "attempt",
  "ack",
  "safeToRetry",
  "reason",
  "evidenceHash",
  "pid",
]);

export const JOURNAL_SCHEMA_VERSION = 1;
export const DEFAULT_JOURNAL_DIR = process.env.CCB_HOME
  ? path.join(process.env.CCB_HOME, "journal")
  : path.join(os.homedir(), ".codex-claude-bridge", "journal");

function validateComponent(value, label) {
  const text = String(value ?? "");
  if (!SAFE_COMPONENT_RE.test(text) || text === "." || text === "..") {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return text;
}

function malformed(filePath, error) {
  const wrapped = new Error(`Malformed journal record at ${filePath}: ${error.message}`);
  wrapped.code = "JOURNAL_MALFORMED";
  wrapped.path = filePath;
  wrapped.cause = error;
  return wrapped;
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Journal clock returned an invalid date");
  return date.toISOString();
}

export function recoveryVerdict(record) {
  if (record.currentState === "queued" || record.currentState === "pre-write") {
    return {
      state: "interrupted",
      ack: "not-injected",
      safeToRetry: true,
      reason: "restart-before-transport",
    };
  }
  if (record.currentState === "injecting") {
    return {
      state: "interrupted",
      ack: "uncertain",
      safeToRetry: false,
      reason: "restart-during-transport",
    };
  }
  if (record.currentState === "acknowledged") {
    return {
      state: "released",
      ack: "injected",
      safeToRetry: false,
      reason: "restart-after-acknowledgement",
    };
  }
  return null;
}

export function createCommandJournal(options = {}) {
  const fsp = options.fs ?? fs;
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_JOURNAL_DIR);
  const randomUUID =
    options.randomUUID ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const now = options.now ?? (() => new Date());
  const isProcessAlive =
    options.isProcessAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        return null;
      }
    });

  function commandPath(session, commandId) {
    const safeSession = validateComponent(session, "session");
    const safeCommandId = validateComponent(commandId, "command id");
    return path.join(rootDir, safeSession, `${safeCommandId}.json`);
  }

  async function ensureDirectory(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700).catch(() => {});
  }

  async function readFileRecord(filePath) {
    let content;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const record = JSON.parse(content);
      if (
        record?.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
        !Array.isArray(record.transitions)
      ) {
        throw new Error("unsupported schema or missing transitions");
      }
      return record;
    } catch (error) {
      throw malformed(filePath, error);
    }
  }

  async function atomicWrite(filePath, record) {
    const directory = path.dirname(filePath);
    await ensureDirectory(directory);
    const tempPath = path.join(
      directory,
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fsp.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    try {
      await fsp.rename(tempPath, filePath);
      await fsp.chmod(filePath, 0o600).catch(() => {});
      let directoryHandle;
      try {
        directoryHandle = await fsp.open(directory, "r");
        await directoryHandle.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code)) {
          throw error;
        }
      } finally {
        if (directoryHandle) await directoryHandle.close();
      }
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async function readCommand(session, commandId) {
    return readFileRecord(commandPath(session, commandId));
  }

  async function recordTransition(input) {
    for (const key of Object.keys(input)) {
      if (!ALLOWED_TRANSITION_FIELDS.has(key)) {
        throw new Error(`unsupported journal field: ${key}`);
      }
    }
    const commandId = validateComponent(input.commandId, "command id");
    const session = validateComponent(input.session, "session");
    const commandClass = validateComponent(input.commandClass, "command class");
    const state = validateComponent(input.state, "state");
    const attempt = Number(input.attempt);
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error(`Invalid journal attempt: ${JSON.stringify(input.attempt)}`);
    }

    const filePath = commandPath(session, commandId);
    const existing = await readFileRecord(filePath);
    if (
      existing &&
      (existing.commandId !== commandId ||
        existing.session !== session ||
        existing.commandClass !== commandClass)
    ) {
      throw new Error("Journal command identity mismatch");
    }

    const timestamp = isoNow(now);
    const transition = { state, attempt, timestamp };
    for (const key of ["ack", "safeToRetry", "reason", "evidenceHash"]) {
      if (input[key] !== undefined && input[key] !== null) {
        transition[key] = input[key];
      }
    }
    const ownerPid = Number(input.pid ?? existing?.ownerPid ?? process.pid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error(`Invalid journal pid: ${JSON.stringify(input.pid)}`);
    }
    transition.pid = ownerPid;
    const record = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      commandId,
      session,
      commandClass,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      currentState: state,
      ownerPid,
      attempt,
      ack: input.ack ?? existing?.ack ?? null,
      safeToRetry: input.safeToRetry ?? existing?.safeToRetry ?? null,
      reason: input.reason ?? existing?.reason ?? null,
      evidenceHash: input.evidenceHash ?? existing?.evidenceHash ?? null,
      transitions: [...(existing?.transitions ?? []), transition],
    };
    await atomicWrite(filePath, record);
    return record;
  }

  async function listCommands({ session } = {}) {
    const directories = [];
    if (session) {
      directories.push(path.join(rootDir, validateComponent(session, "session")));
    } else {
      let entries;
      try {
        entries = await fsp.readdir(rootDir, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && SAFE_COMPONENT_RE.test(entry.name)) {
          directories.push(path.join(rootDir, entry.name));
        }
      }
    }

    const records = [];
    for (const directory of directories) {
      let entries;
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const record = await readFileRecord(path.join(directory, entry.name));
        if (record) records.push(record);
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function reconcile({ session } = {}) {
    const records = await listCommands({ session });
    const reconciled = [];
    for (const record of records) {
      const verdict = recoveryVerdict(record);
      if (!verdict) continue;
      const alive = await isProcessAlive(record.ownerPid);
      if (alive !== false) continue;
      const next = await recordTransition({
        commandId: record.commandId,
        session: record.session,
        commandClass: record.commandClass,
        state: verdict.state,
        attempt: record.attempt,
        ack: verdict.ack,
        safeToRetry: verdict.safeToRetry,
        reason: verdict.reason,
        pid: record.ownerPid,
      });
      reconciled.push(next);
    }
    return reconciled;
  }

  return {
    rootDir,
    recordTransition,
    readCommand,
    listCommands,
    reconcile,
  };
}
