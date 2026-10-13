#!/usr/bin/env node
/**
 * pi-unica packaging.
 *
 * Assembles portable single-file archives of the pi-unica package for the
 * supported targets (linux-x64, win-x64). Each archive is self-contained: it
 * bundles the pinned `unica` runtime plus the four locked third-party engines,
 * so a target machine can install the package with `pi install <dir>` without
 * cargo and without network access.
 *
 * Since Unica 0.13 the published `unica-runtime-<target>.tar.gz` is thin (core
 * binary + generated manifest only), so each archive is assembled from two
 * sources, both pinned in this repository:
 *   - the core binary from the `vX.Y.Z` release named in scripts/lib/version.mjs
 *   - the engines from `unica/plugins/unica/third-party/tools.lock.json`
 *
 * Layout produced inside `dist/pi-unica-<version>-<target>.tar.gz`:
 *   pi-unica-<version>-<target>/
 *     package.json
 *     README.md
 *     extensions/unica.ts
 *     skills/...            (adapted upstream skills, unchanged)
 *     references/...        (content references, unchanged)
 *     runtime/
 *       bin/<target>/...    (unica + bsl-analyzer + v8-runner + rlm-bsl-mcp
 *                            + rlm-bsl-index)
 *       third-party/manifest.json     (generated, per-tool binary SHA-256)
 *       third-party/tools.lock.json   (copied from the vendored source)
 *       runtime-manifest.json         (pinned versions + delivery provenance)
 *       skills/             (empty marker dir for plugin-root discovery)
 *       .mcp.json           (marker file for plugin-root discovery)
 *
 * The archive SHA-256 of each downloaded core is verified against the release
 * metadata asset `unica-runtime-<target>.json`, and every engine against the
 * SHA-256 pinned in the lock.
 *
 * Options:
 *   --target linux-x64|win-x64   build one archive (default: current platform)
 *   --all                        build both linux-x64 and win-x64 archives
 *   --universal                  build one archive bundling both targets
 *   --version <tag>              Unica release tag of the core
 *                                (default: the pinned version)
 *   --build-local                build the core from the vendored source for the
 *                                host target instead of taking the release
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { spawnSync } from "node:child_process";
import { generateManifest } from "./generate-manifest.mjs";
import {
  TARGET_TRIPLES,
  buildRuntimeManifestEntry,
  buildUnicaLocal,
  ensureDir,
  fetchUnicaCore,
  installThirdParty,
  loadLock,
  log,
  sha256File,
  writeRuntimeManifest,
} from "./lib/toolchain.mjs";
import { UNICA_VERSION, UNICA_CORE_VERSION } from "./lib/version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const UNICA_ROOT = join(PACKAGE_ROOT, "unica");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");
const BUILD_ROOT = join(PACKAGE_ROOT, ".package-build");
const DOWNLOAD_ROOT = join(BUILD_ROOT, "downloads");
const STAGING_ROOT = join(BUILD_ROOT, "staging");

const DEFAULT_VERSION = UNICA_VERSION;

const VALID_TARGETS = ["linux-x64", "win-x64"];

const PACKAGE_SOURCES = ["package.json", "README.md", "extensions", "skills", "references"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
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

function detectTarget() {
  const os = platform();
  const a = arch();
  if (os === "linux" && (a === "x64" || a === "amd64")) return "linux-x64";
  if (os === "win32" && (a === "x64" || a === "amd64")) return "win-x64";
  if (os === "darwin" && (a === "arm64" || a === "aarch64")) return "darwin-arm64";
  throw new Error(`unsupported host: ${os}/${a}; pass --target linux-x64|win-x64 explicitly`);
}

function addMarkers(runtimeDir) {
  ensureDir(join(runtimeDir, "skills"));
  const marker = join(runtimeDir, ".mcp.json");
  if (!existsSync(marker)) {
    writeFileSync(
      marker,
      JSON.stringify({ mcpServers: { unica: { command: "unica", args: [] } } }, null, 2) + "\n",
      "utf-8",
    );
  }
}

function copyPackageSources(pkgDir) {
  for (const name of PACKAGE_SOURCES) {
    const src = join(PACKAGE_ROOT, name);
    if (!existsSync(src)) {
      throw new Error(`missing package source: ${src}`);
    }
    cpSync(src, join(pkgDir, name), { recursive: true });
  }
}

function tarCreate(pkgDir, outTar) {
  ensureDir(dirname(outTar));
  rmSync(outTar, { force: true });
  // Deterministic archive: fixed mtime, stable ordering, numeric uid/gid so
  // re-running the packager produces byte-identical output.
  run("tar", [
    "--sort=name",
    "--mtime=1970-01-01 00:00:00 UTC",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    outTar,
    "-C",
    dirname(pkgDir),
    basename(pkgDir),
  ]);
}

function writeSha256(outTar) {
  const sha = sha256File(outTar);
  writeFileSync(`${outTar}.sha256`, `${sha}  ${basename(outTar)}\n`, "utf-8");
  log("sha256", `${sha}  ${basename(outTar)}`);
}

/**
 * Assemble the runtime tree for one target: pinned core + locked engines, the
 * generated third-party manifest, and the version record.
 */
async function assembleRuntime({ target, version, runtimeDir, lock, buildLocal, coreVersion }) {
  const binDir = join(runtimeDir, "bin", target);
  const cacheDir = join(DOWNLOAD_ROOT, target);
  ensureDir(runtimeDir);

  let core;
  let origin = "release";
  if (buildLocal) {
    if (target !== detectTarget()) {
      throw new Error(
        `--build-local can only build the host target (${detectTarget()}), not ${target}`,
      );
    }
    origin = "local-build";
    const dest = buildUnicaLocal({
      unicaRoot: UNICA_ROOT,
      binDir,
      target,
      targetDir: join(BUILD_ROOT, "cargo-target"),
    });
    core = { sha256: sha256File(dest) };
  } else {
    core = await fetchUnicaCore({
      target,
      version,
      coreVersion: version === UNICA_VERSION ? UNICA_CORE_VERSION : undefined,
      binDir,
      cacheDir,
    });
  }

  const engines = await installThirdParty({ target, lock, binDir, cacheDir });

  const { manifest, checks } = generateManifest(target, runtimeDir);
  ensureDir(join(runtimeDir, "third-party"));
  writeFileSync(
    join(runtimeDir, "third-party", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  for (const c of checks) log("manifest", `${c.name.padEnd(16)} ${c.sha256}  ${c.binaryPath}`);

  // tools.lock.json travels with the manifest: the unica binary reads it for
  // bundle diagnostics and dry-run path reporting.
  cpSync(
    join(UNICA_ROOT, "plugins", "unica", "third-party", "tools.lock.json"),
    join(runtimeDir, "third-party", "tools.lock.json"),
  );

  addMarkers(runtimeDir);

  return {
    target,
    core,
    engines,
    origin,
    entry: buildRuntimeManifestEntry({ target, core, engines, origin }),
  };
}

async function packageTarget({ target, version, buildLocal }) {
  log("build", `packaging ${target} (unica ${version})`);
  const { lock } = loadLock(UNICA_ROOT);

  const pkgDirName = `pi-unica-${UNICA_CORE_VERSION}-${target}`;
  const pkgDir = join(STAGING_ROOT, pkgDirName);
  rmSync(pkgDir, { recursive: true, force: true });
  ensureDir(pkgDir);

  const runtimeDir = join(pkgDir, "runtime");
  const assembled = await assembleRuntime({
    target,
    version,
    runtimeDir,
    lock,
    buildLocal,
    coreVersion: UNICA_CORE_VERSION,
  });
  writeRuntimeManifest(runtimeDir, {
    generatedBy: "pi-unica scripts/package.mjs",
    targets: { [target]: assembled.entry },
  });

  copyPackageSources(pkgDir);

  const outTar = join(DIST_ROOT, `${pkgDirName}.tar.gz`);
  tarCreate(pkgDir, outTar);
  writeSha256(outTar);
  log("done", outTar);
  return outTar;
}

/**
 * Merge the per-tool entries of both targets into one manifest in the
 * multi-target `binaries` map format understood by the vendored
 * `bundled_tools.rs`.
 */
function buildUniversalManifest(manifests) {
  const targets = Object.keys(manifests);
  const tools = [];
  const toolNames = manifests[targets[0]].tools.map((t) => t.name).sort();
  for (const toolName of toolNames) {
    const binaries = {};
    let version = null;
    for (const target of targets) {
      const tool = manifests[target].tools.find((t) => t.name === toolName);
      if (!tool) throw new Error(`manifest for ${target} is missing tool ${toolName}`);
      const binary = tool.binaries[target];
      if (!binary) throw new Error(`manifest for ${target}/${toolName} has no binaries entry`);
      if (version === null) version = tool.version ?? null;
      binaries[target] = {
        targetTriple: TARGET_TRIPLES[target],
        binaryPath: binary.binaryPath,
        sha256: binary.sha256,
      };
    }
    tools.push({ name: toolName, version, binaries });
  }
  return {
    schemaVersion: 2,
    generatedBy: "pi-unica scripts/package.mjs",
    sourceLock: "third-party/tools.lock.json",
    unicaVersion: UNICA_VERSION,
    coreVersion: UNICA_CORE_VERSION,
    tools,
  };
}

async function packageUniversal({ version, buildLocal }) {
  log("build", `packaging universal (unica ${version})`);
  const { lock } = loadLock(UNICA_ROOT);
  const targets = VALID_TARGETS.slice();

  const pkgDirName = `pi-unica-${UNICA_CORE_VERSION}-universal`;
  const pkgDir = join(STAGING_ROOT, pkgDirName);
  rmSync(pkgDir, { recursive: true, force: true });
  ensureDir(pkgDir);

  const runtimeDir = join(pkgDir, "runtime");
  ensureDir(runtimeDir);

  const entries = {};
  const manifests = {};
  for (const target of targets) {
    // Each target is assembled in its own tree, then its binaries are merged.
    const targetRuntime = join(STAGING_ROOT, ".universal", target, "runtime");
    rmSync(targetRuntime, { recursive: true, force: true });
    const assembled = await assembleRuntime({
      target,
      version,
      runtimeDir: targetRuntime,
      lock,
      buildLocal,
      coreVersion: UNICA_CORE_VERSION,
    });
    entries[target] = assembled.entry;
    manifests[target] = JSON.parse(
      readFileSync(join(targetRuntime, "third-party", "manifest.json"), "utf-8"),
    );
    cpSync(join(targetRuntime, "bin", target), join(runtimeDir, "bin", target), { recursive: true });
  }

  ensureDir(join(runtimeDir, "third-party"));
  writeFileSync(
    join(runtimeDir, "third-party", "manifest.json"),
    JSON.stringify(buildUniversalManifest(manifests), null, 2) + "\n",
    "utf-8",
  );
  cpSync(
    join(UNICA_ROOT, "plugins", "unica", "third-party", "tools.lock.json"),
    join(runtimeDir, "third-party", "tools.lock.json"),
  );
  writeRuntimeManifest(runtimeDir, {
    generatedBy: "pi-unica scripts/package.mjs",
    targets: entries,
  });
  addMarkers(runtimeDir);
  copyPackageSources(pkgDir);

  const outTar = join(DIST_ROOT, `${pkgDirName}.tar.gz`);
  tarCreate(pkgDir, outTar);
  writeSha256(outTar);
  log("done", outTar);
  return outTar;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    target: value("--target"),
    all: flag("--all"),
    universal: flag("--universal"),
    buildLocal: flag("--build-local"),
    version: value("--version") ?? DEFAULT_VERSION,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.target && !VALID_TARGETS.includes(opts.target)) {
    throw new Error(`unknown target: ${opts.target} (supported: ${VALID_TARGETS.join(", ")})`);
  }
  assertVersionsAgree();

  ensureDir(DIST_ROOT);
  ensureDir(DOWNLOAD_ROOT);
  rmSync(STAGING_ROOT, { recursive: true, force: true });
  ensureDir(STAGING_ROOT);

  log("version", `pi-unica ${UNICA_CORE_VERSION} — unica ${opts.version}`);

  if (opts.universal) {
    await packageUniversal(opts);
  } else if (opts.all) {
    for (const target of VALID_TARGETS) {
      await packageTarget({ ...opts, target });
    }
  } else {
    await packageTarget({ ...opts, target: opts.target ?? detectTarget() });
  }
}

main().catch((error) => {
  console.error(`\n[error] ${error.message}`);
  process.exit(1);
});
