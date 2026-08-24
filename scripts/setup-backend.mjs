#!/usr/bin/env node
/**
 * pi-unica backend setup.
 *
 * Produces a complete `runtime/` tree and registers the `unica` MCP server in
 * pi's agent-level MCP config so that pi-mcp-adapter can proxy `unica.*` tools.
 *
 * Layout produced (mirrors the upstream Unica runtime):
 *   runtime/
 *     bin/<target>/unica                 # built from vendored source (cargo)
 *     bin/<target>/bsl-analyzer          # downloaded, SHA-256 verified
 *     bin/<target>/v8-runner             # downloaded, SHA-256 verified
 *     bin/<target>/rlm-bsl-mcp           # extracted, archive SHA-256 verified
 *     bin/<target>/rlm-bsl-index         # extracted, archive SHA-256 verified
 *     third-party/manifest.json          # generated (binary SHA-256, target triple)
 *     third-party/tools.lock.json        # copied from vendored upstream
 *     skills/                            # marker dir (plugin-root discovery)
 *     .mcp.json                          # marker file (plugin-root discovery)
 *
 * The `unica` binary discovers its plugin root by walking ancestors of its own
 * executable looking for `skills/` + `.mcp.json` or `third-party/manifest.json`
 * (see crates/unica-coder/src/infrastructure/plugin_runtime.rs).
 *
 * Options:
 *   --target <id>            linux-x64 | darwin-arm64 | win-x64 (default: detect)
 *   --skip-build             do not run cargo build (unica binary must already exist)
 *   --skip-download          do not download third-party binaries
 *   --skip-mcp-config        do not write ~/.pi/agent/mcp.json
 *   --from-runtime-url <url> fallback: install from an official
 *                            unica-runtime-<target>.tar.gz release asset
 *   --dry-run                print the plan without performing heavy work
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateManifest } from "./generate-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const UNICA_ROOT = join(PACKAGE_ROOT, "unica");
const LOCK_PATH = join(UNICA_ROOT, "plugins", "unica", "third-party", "tools.lock.json");
const RUNTIME_ROOT = join(PACKAGE_ROOT, "runtime");
const MANIFEST_PATH = join(RUNTIME_ROOT, "third-party", "manifest.json");
const MCP_SERVER_NAME = "unica";

const THIRD_PARTY_TOOLS = ["bsl-analyzer", "v8-runner", "rlm-bsl-mcp", "rlm-bsl-index"];
const TARGET_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "win-x64": "x86_64-pc-windows-msvc",
};

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function loadLock() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  if (lock.schemaVersion !== 1) throw new Error(`unsupported tools.lock.json schemaVersion: ${lock.schemaVersion}`);
  return lock;
}

function detectTarget() {
  const os = platform();
  const a = arch();
  if (os === "darwin" && (a === "arm64" || a === "aarch64")) return "darwin-arm64";
  if (os === "linux" && (a === "x64" || a === "amd64")) return "linux-x64";
  if (os === "win32" && (a === "x64" || a === "amd64")) return "win-x64";
  throw new Error(`unsupported host: ${os}/${a}`);
}

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function releaseAssetUrl(tool, asset) {
  const repository = tool.assetRepository || tool.repository;
  const tag = tool.assetTag || tool.sourceTag;
  return `${repository}/releases/download/${tag}/${asset.assetName}`;
}

async function download(url, dest) {
  log("download", url);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buffer);
  return buffer.length;
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (entry === name) return full;
    }
  }
  return null;
}

function buildUnica(target, dryRun) {
  const exe = target === "win-x64" ? ".exe" : "";
  const dest = join(RUNTIME_ROOT, "bin", target, `unica${exe}`);
  if (existsSync(dest)) {
    log("build", `unica binary already present: ${dest} (use --skip-build or delete to rebuild)`);
    return dest;
  }
  if (dryRun) {
    log("build", `[dry-run] would run: cargo build --release --locked -p unica-coder --bin unica`);
    return dest;
  }
  const targetDir = join(RUNTIME_ROOT, ".cargo-target");
  log("build", "cargo build --release --locked -p unica-coder --bin unica");
  run("cargo", ["build", "--release", "--locked", "-p", "unica-coder", "--bin", "unica", "--target-dir", targetDir], {
    cwd: UNICA_ROOT,
  });
  const produced = join(targetDir, "release", `unica${exe}`);
  if (!existsSync(produced)) throw new Error(`cargo build output not found: ${produced}`);
  ensureDir(dirname(dest));
  copyFileSync(produced, dest);
  if (exe === "") chmodSync(dest, 0o755);
  log("build", `built ${dest}`);
  return dest;
}

async function downloadThirdParty(target, lock, dryRun) {
  const cfg = lock.targets[target];
  const exe = cfg.exe ?? "";
  const binDir = join(RUNTIME_ROOT, "bin", target);
  ensureDir(binDir);
  const workDir = join(RUNTIME_ROOT, ".downloads", target);
  ensureDir(workDir);

  const byName = new Map(lock.tools.map((t) => [t.name, t]));
  const archiveGroups = new Map(); // assetName -> { tool, asset, tools: [] }

  for (const toolName of THIRD_PARTY_TOOLS) {
    const tool = byName.get(toolName);
    if (!tool) throw new Error(`tools.lock.json missing tool ${toolName}`);
    const asset = tool.assets?.[target];
    if (!asset) throw new Error(`${toolName} has no asset for ${target}`);
    if (tool.assetStrategy === "direct-release-asset") {
      const dest = join(binDir, `${tool.binaryName}${exe}`);
      if (existsSync(dest)) {
        log("download", `${toolName} already present: ${dest}`);
        continue;
      }
      if (dryRun) {
        log("download", `[dry-run] would fetch ${releaseAssetUrl(tool, asset)}`);
        continue;
      }
      const tmp = join(workDir, asset.assetName);
      await download(releaseAssetUrl(tool, asset), tmp);
      const actual = sha256File(tmp);
      if (actual !== asset.sha256) {
        throw new Error(`${toolName} checksum mismatch: expected ${asset.sha256}, got ${actual}`);
      }
      copyFileSync(tmp, dest);
      chmodSync(dest, 0o755);
      log("download", `${toolName} verified (sha256 ok)`);
    } else if (tool.assetStrategy === "archive-release-asset") {
      const key = asset.assetName;
      if (!archiveGroups.has(key)) archiveGroups.set(key, { tool, asset, tools: [] });
      archiveGroups.get(key).tools.push(tool);
    } else {
      throw new Error(`unsupported assetStrategy for ${toolName}: ${tool.assetStrategy}`);
    }
  }

  for (const { tool, asset, tools } of archiveGroups.values()) {
    const archiveFile = join(workDir, asset.assetName);
    const allPresent = tools.every((t) => existsSync(join(binDir, `${t.binaryName}${exe}`)));
    if (allPresent) {
      log("download", `${tools.map((t) => t.name).join(", ")} already present`);
      continue;
    }
    if (dryRun) {
      log("download", `[dry-run] would fetch ${releaseAssetUrl(tool, asset)} and extract ${tools.map((t) => t.assets[target].archiveBinary).join(", ")}`);
      continue;
    }
    await download(releaseAssetUrl(tool, asset), archiveFile);
    const actual = sha256File(archiveFile);
    if (actual !== asset.sha256) {
      throw new Error(`${asset.assetName} checksum mismatch: expected ${asset.sha256}, got ${actual}`);
    }
    const extractDir = join(workDir, "extract", basename(asset.assetName, ".tar.gz"));
    rmSync(extractDir, { recursive: true, force: true });
    ensureDir(extractDir);
    run("tar", ["-xzf", archiveFile, "-C", extractDir]);
    for (const t of tools) {
      const archiveBinary = t.assets[target].archiveBinary;
      const found = findFile(extractDir, archiveBinary);
      if (!found) throw new Error(`archive ${asset.assetName} does not contain ${archiveBinary}`);
      const dest = join(binDir, `${t.binaryName}${exe}`);
      copyFileSync(found, dest);
      chmodSync(dest, 0o755);
      log("download", `${t.name} extracted from ${asset.assetName}`);
    }
  }
}

function writeMarkers(target) {
  ensureDir(join(RUNTIME_ROOT, "skills"));
  const mcpMarker = join(RUNTIME_ROOT, ".mcp.json");
  if (!existsSync(mcpMarker)) {
    writeFileSync(mcpMarker, JSON.stringify({
      mcpServers: {
        unica: { command: "unica", args: [] },
      },
    }, null, 2) + "\n", "utf-8");
  }
  // tools.lock.json lives next to the manifest for bundled-tool dry-run fallback.
  const lockDest = join(RUNTIME_ROOT, "third-party", "tools.lock.json");
  ensureDir(dirname(lockDest));
  copyFileSync(LOCK_PATH, lockDest);
}

function getPiAgentMcpConfigPath() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return join(configured, "mcp.json");
  return join(homedir(), ".pi", "agent", "mcp.json");
}

function writeMcpConfig(target, dryRun) {
  const exe = target === "win-x64" ? ".exe" : "";
  const command = join(RUNTIME_ROOT, "bin", target, `unica${exe}`);
  const configPath = getPiAgentMcpConfigPath();

  if (dryRun) {
    log("mcp", `[dry-run] would write "${MCP_SERVER_NAME}" -> ${command} in ${configPath}`);
    return;
  }

  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (error) {
      throw new Error(`failed to read existing MCP config ${configPath}: ${error.message}`);
    }
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  const existing = servers[MCP_SERVER_NAME];
  if (existing && existing.command === command && (existing.args ?? []).length === 0) {
    log("mcp", `entry already matches in ${configPath}`);
    return;
  }
  servers[MCP_SERVER_NAME] = { command, args: [] };
  ensureDir(dirname(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + "\n", "utf-8");
  log("mcp", `wrote "${MCP_SERVER_NAME}" -> ${command} in ${configPath}`);
}

async function installFromRuntimeUrl(url, target, lock) {
  const exe = target === "win-x64" ? ".exe" : "";
  const archiveFile = join(RUNTIME_ROOT, ".downloads", `unica-runtime-${target}.tar.gz`);
  await download(url, archiveFile);
  const extractDir = join(RUNTIME_ROOT, ".downloads", `unica-runtime-${target}-extract`);
  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  run("tar", ["-xzf", archiveFile, "-C", extractDir]);

  // The official archive may wrap content in a single top-level directory.
  let contentRoot = extractDir;
  const entries = readdirSync(extractDir).filter((e) => statSync(join(extractDir, e)).isDirectory());
  if (entries.length === 1) contentRoot = join(extractDir, entries[0]);

  const binSrc = join(contentRoot, "bin", target);
  if (!existsSync(binSrc)) throw new Error(`runtime archive has no bin/${target} directory`);
  const binDest = join(RUNTIME_ROOT, "bin", target);
  ensureDir(binDest);
  for (const entry of readdirSync(binSrc)) {
    copyFileSync(join(binSrc, entry), join(binDest, entry));
    if (!entry.endsWith(".exe")) chmodSync(join(binDest, entry), 0o755);
  }
  // Prefer the archive's own third-party manifest if present.
  const manifestSrc = join(contentRoot, "third-party", "manifest.json");
  if (existsSync(manifestSrc)) {
    ensureDir(join(RUNTIME_ROOT, "third-party"));
    copyFileSync(manifestSrc, join(RUNTIME_ROOT, "third-party", "manifest.json"));
  }
  // Copy the lock and markers regardless.
  writeMarkers(target);
  log("install", `installed runtime from ${url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target = value("--target") ?? detectTarget();
  if (!TARGET_TRIPLES[target]) throw new Error(`unknown target: ${target}`);
  const dryRun = flag("--dry-run");

  log("setup", `pi-unica backend — target ${target} (${TARGET_TRIPLES[target]})`);
  ensureDir(RUNTIME_ROOT);

  if (!existsSync(LOCK_PATH)) throw new Error(`tools.lock.json not found: ${LOCK_PATH}`);
  const lock = loadLock();

  const runtimeUrl = value("--from-runtime-url");
  if (runtimeUrl) {
    if (dryRun) log("install", `[dry-run] would install from ${runtimeUrl}`);
    else await installFromRuntimeUrl(runtimeUrl, target, lock);
  } else {
    if (!flag("--skip-build")) buildUnica(target, dryRun);
    if (!flag("--skip-download")) await downloadThirdParty(target, lock, dryRun);
    writeMarkers(target);
  }

  const keepCache = flag("--keep-build-cache");
  if (!dryRun && !keepCache) {
    rmSync(join(RUNTIME_ROOT, ".cargo-target"), { recursive: true, force: true });
    rmSync(join(RUNTIME_ROOT, ".downloads"), { recursive: true, force: true });
  }

  if (!dryRun && !flag("--skip-manifest")) {
    if (flag("--skip-download")) {
      log("manifest", "skipped (--skip-download); run 'node scripts/generate-manifest.mjs " + target + "' after binaries are present");
    } else {
      const { manifest, checks } = generateManifest(target);
      mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
      writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      for (const c of checks) log("manifest", `${c.name.padEnd(16)} ${c.sha256}  ${c.binaryPath}`);
      log("manifest", `written ${MANIFEST_PATH}`);
    }
  }

  if (!flag("--skip-mcp-config")) writeMcpConfig(target, dryRun);

  log("setup", "done. Run /reload in pi, then verify with mcp({ server: \"unica\" }).");
}

main().catch((error) => {
  console.error(`\n[error] ${error.message}`);
  process.exit(1);
});
