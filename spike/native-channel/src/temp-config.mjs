// spike/native-channel/src/temp-config.mjs
// Generates a temporary session directory under spike/native-channel/tmp/
// containing a .mcp.json that registers ccb-channel-server. Experiments pass
// configPath explicitly to startBackground. The operator's project and global
// Claude config are never modified.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const SPIKE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TMP_DIR = path.join(SPIKE_ROOT, "tmp");

/**
 * @param {{ probeUrl: string, probeToken: string }} opts
 * @returns {{ sessionCwd: string, configPath: string, mcpConfig: Object }}
 */
export function generateTempConfig({ probeUrl, probeToken }) {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const channelServerPath = path.join(SPIKE_ROOT, "src", "ccb-channel-server.mjs");
  const mcpConfig = {
    mcpServers: {
      "ccb-channel-server": {
        command: process.execPath,
        args: [channelServerPath.replace(/\\/g, "/")],
        env: {
          CCB_PROBE_URL: probeUrl,
          CCB_PROBE_TOKEN: probeToken,
        },
      },
    },
  };
  const sessionCwd = path.join(TMP_DIR, `session-${Date.now()}`);
  mkdirSync(sessionCwd, { recursive: true });
  const configPath = path.join(sessionCwd, ".mcp.json");
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return { sessionCwd, configPath, mcpConfig };
}

// CLI entry: `node src/temp-config.mjs <probeUrl> <probeToken>`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [probeUrl, probeToken] = process.argv.slice(2);
  if (!probeUrl || !probeToken) {
    console.error("Usage: temp-config.mjs <probeUrl> <probeToken>");
    process.exit(1);
  }
  const { sessionCwd } = generateTempConfig({ probeUrl, probeToken });
  process.stdout.write(sessionCwd + "\n");
}
