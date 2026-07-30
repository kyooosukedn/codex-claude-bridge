import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import path from "node:path";

function pathValue(env) {
  return String(env.Path ?? env.PATH ?? "");
}

function pathDirectories(env, platform, pathApi) {
  const delimiter = platform === "win32" ? ";" : pathApi.delimiter;
  return pathValue(env)
    .split(delimiter)
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function resolveExistingExecutable(command, options) {
  const { env, existsSync, pathApi } = options;
  const extensions = pathApi.extname(command) ? [""] : [".exe", ".com"];
  for (const directory of pathDirectories(env, "win32", pathApi)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveNodePackageBin(packageName, binName, options) {
  const { env, existsSync, readFileSync, pathApi } = options;
  for (const directory of pathDirectories(env, "win32", pathApi)) {
    const packageRoot = pathApi.join(directory, "node_modules", packageName);
    const packageJsonPath = pathApi.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read ${packageName} package metadata: ${error.message}`, {
        cause: error,
      });
    }
    const relativeEntry =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
    if (!relativeEntry) {
      throw new Error(`${packageName} does not declare the ${binName} executable`);
    }

    const entry = pathApi.resolve(packageRoot, relativeEntry);
    const relative = pathApi.relative(packageRoot, entry);
    if (relative.startsWith("..") || pathApi.isAbsolute(relative)) {
      throw new Error(`${packageName} declares an executable outside its package`);
    }
    return entry;
  }
  return null;
}

export function resolveTransportCommand(command, overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  if (platform !== "win32") return { command, prefixArgs: [] };

  const options = {
    env: overrides.env ?? process.env,
    existsSync: overrides.existsSync ?? nodeExistsSync,
    readFileSync: overrides.readFileSync ?? nodeReadFileSync,
    pathApi: overrides.pathApi ?? path.win32,
  };
  const execPath = overrides.execPath ?? process.execPath;

  if (command === "node") {
    return { command: execPath, prefixArgs: [] };
  }

  if (command === "ccmux") {
    const entry = resolveNodePackageBin(
      "claude-code-tmux",
      "ccmux",
      options,
    );
    if (!entry) {
      throw new Error(
        "Cannot resolve ccmux without a shell. Install claude-code-tmux globally and ensure its npm bin directory is on PATH.",
      );
    }
    return { command: execPath, prefixArgs: [entry] };
  }

  if (command === "pi") {
    const entry = resolveNodePackageBin(
      "@mariozechner/pi-coding-agent",
      "pi",
      options,
    );
    if (!entry) {
      throw new Error("Cannot resolve pi without a shell");
    }
    return { command: execPath, prefixArgs: [entry] };
  }

  if (command === "claude") {
    const entry = resolveNodePackageBin(
      "@anthropic-ai/claude-code",
      "claude",
      options,
    );
    if (entry) {
      if (options.pathApi.extname(entry).toLowerCase() === ".exe") {
        return { command: entry, prefixArgs: [] };
      }
      return { command: execPath, prefixArgs: [entry] };
    }
    throw new Error("Cannot resolve claude without a shell");
  }

  if (command === "npm") {
    const entry = resolveNodePackageBin("npm", "npm", options);
    if (!entry) {
      throw new Error(
        "Cannot resolve npm without a shell. Ensure the npm installation directory is on PATH.",
      );
    }
    return { command: execPath, prefixArgs: [entry] };
  }

  const executable = resolveExistingExecutable(command, options);
  if (!executable) {
    throw new Error(`Cannot resolve ${command}.exe on PATH without a shell`);
  }
  return { command: executable, prefixArgs: [] };
}

export function createTransport(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const spawnSync = overrides.spawnSync ?? nodeSpawnSync;
  const resolverOptions = {
    platform,
    env,
    execPath: overrides.execPath ?? process.execPath,
    existsSync: overrides.existsSync ?? nodeExistsSync,
    readFileSync: overrides.readFileSync ?? nodeReadFileSync,
    pathApi: overrides.pathApi ?? (platform === "win32" ? path.win32 : path),
  };

  return {
    run(command, args = [], options = {}) {
      const resolved = resolveTransportCommand(command, resolverOptions);
      return spawnSync(resolved.command, [...resolved.prefixArgs, ...args], {
        cwd: options.cwd,
        env,
        encoding: "utf8",
        input: options.input,
        shell: false,
        stdio: options.stdio ?? "pipe",
      });
    },
  };
}
