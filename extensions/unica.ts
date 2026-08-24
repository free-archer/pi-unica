/**
 * pi-unica extension.
 *
 * Registers the `unica` Rust MCP server (built/downloaded into `runtime/`) in
 * pi's agent-level MCP config so that pi-mcp-adapter can proxy the `unica.*`
 * tools, and provides a `/unica` status/diagnostics command.
 *
 * Prerequisites:
 *   - pi-mcp-adapter (`pi install npm:pi-mcp-adapter`) — provides the `mcp()`
 *     proxy tool that reads ~/.pi/agent/mcp.json.
 *   - `scripts/setup-backend.sh` — builds `unica` and downloads the pinned
 *     third-party binaries into `runtime/`.
 *
 * This extension starts no background processes or sockets: it only inspects
 * and mutates configuration and reports status.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync, writeFileSync, constants, accessSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";

const PACKAGE_NAME = "pi-unica";
const MCP_SERVER_NAME = "unica";

const PACKAGE_ROOT = dirname(__dirname);

function detectTarget(): string | null {
  const os = platform();
  const a = arch();
  if (os === "darwin" && (a === "arm64" || a === "aarch64")) return "darwin-arm64";
  if (os === "linux" && (a === "x64" || a === "amd64")) return "linux-x64";
  if (os === "win32" && (a === "x64" || a === "amd64")) return "win-x64";
  return null;
}

function binaryPath(): { target: string; path: string } | null {
  const target = detectTarget();
  if (!target) return null;
  const exe = target === "win-x64" ? ".exe" : "";
  return {
    target,
    path: join(PACKAGE_ROOT, "runtime", "bin", target, `unica${exe}`),
  };
}

function getPiAgentMcpConfigPath(): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return join(configured, "mcp.json");
  return join(homedir(), ".pi", "agent", "mcp.json");
}

interface McpConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

function readMcpConfig(path: string): McpConfig | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as McpConfig;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Result of ensuring the `unica` entry in pi's agent-level MCP config.
 * - "updated":   entry was written or updated successfully
 * - "unchanged": entry already matches, no write needed
 * - "failed":    config could not be read or written (never overwrite on read failure)
 */
type EnsureResult = "updated" | "unchanged" | "failed";

function ensureServerEntry(configPath: string, binPath: string): EnsureResult {
  const config = readMcpConfig(configPath);

  // If the file exists but can't be read/parsed, never clobber it.
  if (config === null) return "failed";

  const servers =
    config.mcpServers && isRecord(config.mcpServers)
      ? (config.mcpServers as Record<string, { command?: string; args?: string[] }>)
      : {};

  const existing = servers[MCP_SERVER_NAME];
  if (
    existing &&
    existing.command === binPath &&
    (existing.args ?? []).length === 0
  ) {
    return "unchanged";
  }

  // Merge, don't clobber: keep all other servers intact.
  servers[MCP_SERVER_NAME] = { command: binPath, args: [] };
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, mcpServers: servers }, null, 2) + "\n",
      "utf-8",
    );
    return "updated";
  } catch (error) {
    console.error(
      `${PACKAGE_NAME}: failed to write MCP config to ${configPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    return "failed";
  }
}

interface StatusReport {
  ok: boolean;
  lines: string[];
  level: "info" | "warning" | "error";
}

function buildStatus(): StatusReport {
  const lines: string[] = [];
  let ok = true;

  const bin = binaryPath();
  if (!bin) {
    return {
      ok: false,
      level: "error",
      lines: [
        `${PACKAGE_NAME}: unsupported host ${platform()}/${arch()}`,
        "Supported targets: linux-x64, darwin-arm64, win-x64.",
      ],
    };
  }
  lines.push(`binary target: ${bin.target}`);

  if (existsSync(bin.path)) {
    try {
      accessSync(bin.path, constants.X_OK);
      lines.push(`unica binary: OK (${bin.path})`);
    } catch {
      ok = false;
      lines.push(`unica binary: present but NOT executable (${bin.path})`);
    }
  } else {
    ok = false;
    lines.push(`unica binary: MISSING (${bin.path})`);
    lines.push("Run scripts/setup-backend.sh to build and download the runtime.");
  }

  const manifest = join(PACKAGE_ROOT, "runtime", "third-party", "manifest.json");
  lines.push(
    existsSync(manifest)
      ? "third-party manifest: present"
      : "third-party manifest: missing (run scripts/setup-backend.sh)",
  );

  const configPath = getPiAgentMcpConfigPath();
  const config = readMcpConfig(configPath);
  if (config === null) {
    ok = false;
    lines.push(`MCP config: unreadable (${configPath})`);
  } else {
    const entry = config.mcpServers?.[MCP_SERVER_NAME];
    if (entry?.command === bin.path && (entry.args ?? []).length === 0) {
      lines.push(`MCP config: записан/совпадает (${configPath})`);
    } else if (entry) {
      ok = false;
      lines.push(
        `MCP config: запись есть, но не совпадает (${configPath})`,
        `  command: ${entry.command ?? "(none)"}`,
        `  expected: ${bin.path}`,
      );
    } else {
      ok = false;
      lines.push(
        `MCP config: запись "${MCP_SERVER_NAME}" отсутствует (${configPath}); ` +
          "будет записана на session_start",
      );
    }
  }

  return {
    ok,
    level: ok ? "info" : "warning",
    lines: [`${PACKAGE_NAME} status:`, ...lines.map((l) => `  ${l}`)],
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const bin = binaryPath();

      if (!bin) {
        const status = buildStatus();
        if (ctx.hasUI) ctx.ui.notify?.(status.lines.join("\n"), "error");
        return;
      }

      if (!existsSync(bin.path)) {
        if (ctx.hasUI) {
          ctx.ui.notify?.(
            `${PACKAGE_NAME}: unica binary not found at ${bin.path}. ` +
              "Run scripts/setup-backend.sh in the package to build and download the runtime.",
            "warning",
          );
        }
        return;
      }

      // Self-register the `unica` MCP server so pi-mcp-adapter can proxy it.
      const configPath = getPiAgentMcpConfigPath();
      const result = ensureServerEntry(configPath, bin.path);
      if (result === "updated" && ctx.hasUI) {
        ctx.ui.notify?.(
          `${PACKAGE_NAME}: MCP server "${MCP_SERVER_NAME}" registered at ${configPath}. ` +
            "Run /reload if pi-mcp-adapter is already installed.",
          "info",
        );
      } else if (result === "failed" && ctx.hasUI) {
        ctx.ui.notify?.(
          `${PACKAGE_NAME}: failed to register MCP server at ${configPath}. ` +
            "Check the console logs and ensure the file is writable.",
          "error",
        );
      }

      // Ensure pi-mcp-adapter's proxy tool is present.
      const tools = pi.getAllTools();
      if (tools.length > 0 && !tools.some((t) => t.name === "mcp")) {
        if (ctx.hasUI) {
          ctx.ui.notify?.(
            `${PACKAGE_NAME}: pi-mcp-adapter not detected (no "mcp" tool). ` +
              "Install it with 'pi install npm:pi-mcp-adapter' then /reload.",
            "warning",
          );
        }
      }

      const status = buildStatus();
      if (!status.ok && ctx.hasUI) {
        ctx.ui.notify?.(status.lines.join("\n"), "warning");
      }
    } catch (error) {
      console.error(
        `${PACKAGE_NAME}: session_start error:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  pi.registerCommand("unica", {
    description: "Show pi-unica backend status and diagnostics",
    handler: async (_args, ctx) => {
      // Ensure (idempotently) the config entry exists before reporting.
      const bin = binaryPath();
      if (bin && existsSync(bin.path)) {
        ensureServerEntry(getPiAgentMcpConfigPath(), bin.path);
      }

      const status = buildStatus();

      // Check the mcp() proxy tool availability for the report.
      const tools = pi.getAllTools();
      const hasProxy = tools.some((t) => t.name === "mcp");
      const report = [
        ...status.lines,
        `  mcp() proxy tool: ${hasProxy ? "available" : "MISSING (install npm:pi-mcp-adapter, then /reload)"}`,
        hasProxy
          ? '  verify: mcp({ server: "unica" }) → 74 tools'
          : "  verify after installing pi-mcp-adapter: mcp({ server: \"unica\" })",
      ];

      ctx.ui.notify(report.join("\n"), status.ok && hasProxy ? "info" : "warning");
    },
  });
}
