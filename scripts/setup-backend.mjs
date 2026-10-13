#!/usr/bin/env node
/**
 * pi-unica backend setup.
 *
 * Produces a complete `runtime/` tree for the current host and registers the
 * `unica` MCP server in pi's agent-level MCP config so that pi-mcp-adapter can
 * proxy the `unica.*` tools.
 *
 * Layout produced (mirrors the upstream Unica runtime):
 *   runtime/
 *     bin/<target>/unica                 # pinned release binary (default)
 *     bin/<target>/bsl-analyzer          # downloaded, SHA-256 verified
 *     bin/<target>/v8-runner             # downloaded, SHA-256 verified
 *     bin/<target>/rlm-bsl-mcp           # extracted, archive SHA-256 verified
 *     bin/<target>/rlm-bsl-index         # extracted, archive SHA-256 verified
 *     third-party/manifest.json          # generated (binary SHA-256, target triple)
 *     third-party/tools.lock.json        # copied from vendored upstream
 *     runtime-manifest.json              # pinned Unica version + engine versions
 *     skills/                            # marker dir (plugin-root discovery)
 *     .mcp.json                          # marker file (plugin-root discovery)
 *
 * Since Unica 0.13 the published core archive is thin — it carries only the
 * `unica` binary and a manifest — so the engines are acquired separately from
 * the addresses pinned in the vendored `third-party/tools.lock.json`.
 *
 * The `unica` binary discovers its plugin root by walking ancestors of its own
 * executable looking for `skills/` + `.mcp.json` or `third-party/manifest.json`
 * (see crates/unica-coder/src/infrastructure/plugin_runtime.rs).
 *
 * Options:
 *   --target <id>            linux-x64 | darwin-arm64 | win-x64 (default: detect)
 *   --version <tag>          Unica release tag (default: the pinned version)
 *   --build-local            build `unica` from the vendored source with cargo
 *                            instead of taking the pinned release binary
 *   --skip-core              do not install the `unica` binary
 *   --skip-engines           do not download the third-party engines
 *                            (aliases: --skip-build, --skip-download)
 *   --skip-manifest          do not regenerate third-party/manifest.json
 *   --skip-mcp-config        do not write ~/.pi/agent/mcp.json
 *   --force                  reinstall bin/<target> even when the recorded
 *                            version already matches the pinned one
 *   --from-runtime-url <url> take the core from this archive instead of the
 *                            pinned release asset
 *   --keep-build-cache       keep runtime/.downloads and runtime/.cargo-target
 *   --dry-run                print the plan without performing heavy work
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch } from "node:os";
import { generateManifest } from "./generate-manifest.mjs";
import {
  TARGET_TRIPLES,
  buildRuntimeManifestEntry,
  download,
  extractArchive,
  ensureDir,
  exeSuffix,
  fetchUnicaCore,
  installThirdParty,
  loadLock,
  log,
  buildUnicaLocal,
  sha256File,
  writeRuntimeManifest,
} from "./lib/toolchain.mjs";
import { UNICA_VERSION, UNICA_CORE_VERSION, UNICA_RELEASE_REPO } from "./lib/version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const UNICA_ROOT = join(PACKAGE_ROOT, "unica");
const LOCK_PATH = join(UNICA_ROOT, "plugins", "unica", "third-party", "tools.lock.json");
const RUNTIME_ROOT = join(PACKAGE_ROOT, "runtime");
const MANIFEST_PATH = join(RUNTIME_ROOT, "third-party", "manifest.json");
const RUNTIME_MANIFEST_PATH = join(RUNTIME_ROOT, "runtime-manifest.json");
const MCP_SERVER_NAME = "unica";

function detectTarget() {
  const os = platform();
  const a = arch();
  if (os === "darwin" && (a === "arm64" || a === "aarch64")) return "darwin-arm64";
  if (os === "linux" && (a === "x64" || a === "amd64")) return "linux-x64";
  if (os === "win32" && (a === "x64" || a === "amd64")) return "win-x64";
  throw new Error(`unsupported host: ${os}/${a}`);
}

/** Fail loudly on a half-done version bump (package.json vs scripts/lib/version.mjs). */
function assertVersionsAgree() {
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
  if (packageJson.version !== UNICA_CORE_VERSION) {
    throw new Error(
      `version mismatch: package.json says ${packageJson.version}, ` +
        `scripts/lib/version.mjs pins ${UNICA_CORE_VERSION}`,
    );
  }
}

function writeMarkers() {
  ensureDir(join(RUNTIME_ROOT, "skills"));
  const mcpMarker = join(RUNTIME_ROOT, ".mcp.json");
  if (!existsSync(mcpMarker)) {
    writeFileSync(
      mcpMarker,
      JSON.stringify({ mcpServers: { unica: { command: "unica", args: [] } } }, null, 2) + "\n",
      "utf-8",
    );
  }
  // tools.lock.json lives next to the manifest for the bundled-tool dry-run
  // fallback and for version lookups performed by the unica binary.
  const lockDest = join(RUNTIME_ROOT, "third-party", "tools.lock.json");
  ensureDir(dirname(lockDest));
  copyFileSync(LOCK_PATH, lockDest);
}

/**
 * Record the pinned versions inside the plugin runtime tree. This file is what
 * answers "which Unica is this plugin built on?" without asking a binary or a
 * running server.
 */
function recordVersions({ target, core, engines, origin }) {
  const entry = buildRuntimeManifestEntry({ target, core, engines, origin });
  const { manifest } = writeRuntimeManifest(RUNTIME_ROOT, {
    generatedBy: "pi-unica scripts/setup-backend.mjs",
    targets: { [target]: entry },
  });
  log(
    "version",
    `runtime-manifest.json: unica ${UNICA_VERSION} core + ${manifest.targets[target].engines.length} engines`,
  );
}

function getPiAgentMcpConfigPath() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return join(configured, "mcp.json");
  return join(homedir(), ".pi", "agent", "mcp.json");
}

function writeMcpConfig(target, dryRun) {
  const command = join(RUNTIME_ROOT, "bin", target, `unica${exeSuffix(target)}`);
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
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
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

/** Install the core from an explicit archive URL (kept for pinned mirrors). */
async function installCoreFromUrl(url, target, binDir, cacheDir) {
  const archive = join(cacheDir, `unica-runtime-${target}.tar.gz`);
  await download(url, archive);
  const extractDir = join(cacheDir, `unica-runtime-${target}-extract`);
  extractArchive(archive, extractDir);
  const source = join(extractDir, "bin", target, `unica${exeSuffix(target)}`);
  if (!existsSync(source)) {
    throw new Error(`core archive has no bin/${target}/unica${exeSuffix(target)}: ${url}`);
  }
  const dest = join(binDir, `unica${exeSuffix(target)}`);
  ensureDir(binDir);
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  log("core", `installed ${dest} from ${url}`);
  return dest;
}

/**
 * The Unica version the current `runtime/` was assembled for, or null when it
 * predates version recording. Used to reinstall instead of silently keeping
 * binaries of an older release.
 */
function runtimeAssembledVersion() {
  if (!existsSync(RUNTIME_MANIFEST_PATH)) return null;
  try {
    const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST_PATH, "utf-8"));
    return manifest.unicaVersion ?? null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    target: value("--target") ?? detectTarget(),
    version: value("--version") ?? UNICA_VERSION,
    buildLocal: flag("--build-local"),
    force: flag("--force"),
    skipCore: flag("--skip-core") || flag("--skip-build"),
    skipEngines: flag("--skip-engines") || flag("--skip-download"),
    skipManifest: flag("--skip-manifest"),
    skipMcpConfig: flag("--skip-mcp-config"),
    keepBuildCache: flag("--keep-build-cache"),
    coreUrl: value("--from-runtime-url"),
    dryRun: flag("--dry-run"),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { target } = opts;
  if (!TARGET_TRIPLES[target]) throw new Error(`unknown target: ${target}`);
  assertVersionsAgree();

  log("setup", `pi-unica ${UNICA_CORE_VERSION} backend — target ${target} (${TARGET_TRIPLES[target]})`);
  ensureDir(RUNTIME_ROOT);

  if (!existsSync(LOCK_PATH)) throw new Error(`tools.lock.json not found: ${LOCK_PATH}`);
  const { lock } = loadLock(UNICA_ROOT);

  const binDir = join(RUNTIME_ROOT, "bin", target);
  const cacheDir = join(RUNTIME_ROOT, ".downloads", target);

  // A runtime tree from another Unica release must not be reused in place:
  // the engines and the core change together, and half of each is worse than
  // neither. Version is read from the tree's own runtime-manifest.json.
  const previousVersion = runtimeAssembledVersion();
  const hasCore = existsSync(join(binDir, `unica${exeSuffix(target)}`));
  const stale =
    opts.force ||
    (previousVersion !== null && previousVersion !== UNICA_VERSION) ||
    (previousVersion === null && hasCore);
  if (stale) {
    if (opts.skipCore || opts.skipEngines) {
      throw new Error(
        `runtime/ holds unica ${previousVersion ?? "of unknown version"}, ` +
          `this package pins ${UNICA_VERSION}; drop --skip-core/--skip-engines to reinstall`,
      );
    }
    if (opts.dryRun) {
      log("setup", `[dry-run] would reinstall bin/${target} (was unica ${previousVersion ?? "unknown"})`);
    } else {
      rmSync(binDir, { recursive: true, force: true });
      log(
        "setup",
        `reinstalling bin/${target}: was unica ${previousVersion ?? "unknown (pre-0.13 tree)"}, ` +
          `now ${UNICA_VERSION}`,
      );
    }
  }

  let core = { sha256: null };
  let origin = "release";
  if (!opts.skipCore) {
    if (opts.buildLocal && target !== detectTarget()) {
      throw new Error(
        `--build-local can only build the host target (${detectTarget()}), not ${target}`,
      );
    }
    if (opts.buildLocal && opts.dryRun) {
      log("build", "[dry-run] would run: cargo build --release --locked -p unica-coder --bin unica");
      origin = "local-build";
    } else if (opts.buildLocal) {
      origin = "local-build";
      const dest = buildUnicaLocal({
        unicaRoot: UNICA_ROOT,
        binDir,
        target,
        targetDir: join(RUNTIME_ROOT, ".cargo-target"),
      });
      core = { sha256: sha256File(dest), meta: null };
    } else if (opts.coreUrl) {
      origin = "url";
      if (opts.dryRun) {
        log("core", `[dry-run] would install the core from ${opts.coreUrl}`);
      } else {
        const dest = await installCoreFromUrl(opts.coreUrl, target, binDir, cacheDir);
        core = { sha256: sha256File(dest), meta: null };
      }
    } else {
      core = await fetchUnicaCore({
        target,
        version: opts.version,
        coreVersion: opts.version === UNICA_VERSION ? UNICA_CORE_VERSION : undefined,
        binDir,
        cacheDir,
        dryRun: opts.dryRun,
        ignoreExisting: stale,
      });
    }
  } else {
    log("core", "skipped (--skip-core)");
  }

  let engines = [];
  if (!opts.skipEngines) {
    engines = await installThirdParty({
      target,
      lock,
      binDir,
      cacheDir,
      dryRun: opts.dryRun,
      ignoreExisting: stale,
    });
  } else {
    log("engine", "skipped (--skip-engines)");
  }

  writeMarkers();

  if (!opts.dryRun && !opts.keepBuildCache) {
    rmSync(join(RUNTIME_ROOT, ".cargo-target"), { recursive: true, force: true });
    rmSync(join(RUNTIME_ROOT, ".downloads"), { recursive: true, force: true });
  }

  if (!opts.dryRun && !opts.skipManifest) {
    const { manifest, checks } = generateManifest(target);
    ensureDir(dirname(MANIFEST_PATH));
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    for (const c of checks) log("manifest", `${c.name.padEnd(16)} ${c.sha256}  ${c.binaryPath}`);
    log("manifest", `written ${MANIFEST_PATH}`);
    recordVersions({ target, core, engines, origin });
  } else if (opts.dryRun) {
    log("manifest", "[dry-run] would write third-party/manifest.json and runtime-manifest.json");
  }

  if (!opts.skipMcpConfig) writeMcpConfig(target, opts.dryRun);

  log("setup", "done. Run /reload in pi, then verify with mcp({ server: \"unica\" }).");
}

main().catch((error) => {
  console.error(`\n[error] ${error.message}`);
  process.exit(1);
});
