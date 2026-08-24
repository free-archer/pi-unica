#!/usr/bin/env node
/**
 * pi-unica packaging.
 *
 * Assembles portable single-file archives of the pi-unica package for the
 * supported targets (linux-x64, win-x64). Each archive is self-contained:
 * it bundles the prebuilt `unica` Rust runtime (plus the four third-party
 * binaries) downloaded from the official IngvarConsulting/unica release, so a
 * target machine can install the package with `pi install <dir>` without
 * cargo and without network access.
 *
 * Layout produced inside `dist/pi-unica-<target>.tar.gz`:
 *   pi-unica-<target>/
 *     package.json
 *     README.md
 *     extensions/unica.ts
 *     skills/...            (73 skills, unchanged)
 *     references/...        (content references, unchanged)
 *     runtime/
 *       bin/<target>/...    (unica + bsl-analyzer + v8-runner + rlm-bsl-mcp
 *                            + rlm-bsl-index + bundled Python support files)
 *       third-party/manifest.json
 *       skills/             (empty marker dir for plugin-root discovery)
 *       .mcp.json           (marker file for plugin-root discovery)
 *
 * The archive SHA-256 of each downloaded `unica-runtime-<target>.tar.gz` is
 * verified against the release metadata asset `unica-runtime-<target>.json`
 * (field `asset.sha256`). If the metadata asset is absent, the computed SHA is
 * pinned and a warning is printed.
 *
 * Options:
 *   --target linux-x64|win-x64   build one archive (default: current platform)
 *   --all                        build both linux-x64 and win-x64 archives
 *   --universal                  build one archive bundling both targets
 *   --version <tag>              release tag of the runtimes (default: v0.12.0)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");
const BUILD_ROOT = join(PACKAGE_ROOT, ".package-build");
const DOWNLOAD_ROOT = join(BUILD_ROOT, "downloads");
const STAGING_ROOT = join(BUILD_ROOT, "staging");

const REPO = "https://github.com/IngvarConsulting/unica";
const DEFAULT_VERSION = "v0.12.0";

const VALID_TARGETS = ["linux-x64", "win-x64"];
const TARGET_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win-x64": "x86_64-pc-windows-msvc",
};
// Only these are resolved by the unica binary via the bundled-tools manifest.
const THIRD_PARTY_TOOLS = ["bsl-analyzer", "v8-runner", "rlm-bsl-mcp", "rlm-bsl-index"];

const PACKAGE_SOURCES = ["package.json", "README.md", "extensions", "skills", "references"];

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function detectTarget() {
  const os = platform();
  const a = arch();
  if (os === "linux" && (a === "x64" || a === "amd64")) return "linux-x64";
  if (os === "win32" && (a === "x64" || a === "amd64")) return "win-x64";
  throw new Error(
    `unsupported host: ${os}/${a}; pass --target linux-x64|win-x64 explicitly`,
  );
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { redirect: "follow" });
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        const delay = 500 * 2 ** i;
        console.warn(`[warn] fetch failed for ${url} (attempt ${i + 1}/${attempts}); retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function fetchText(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  return await response.text();
}

async function fetchMetadata(target, version) {
  const url = `${REPO}/releases/download/${version}/unica-runtime-${target}.json`;
  const text = await fetchText(url);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function downloadArchive(target, version, dest) {
  const url = `${REPO}/releases/download/${version}/unica-runtime-${target}.tar.gz`;
  console.log(`[download] ${url}`);
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  ensureDir(dirname(dest));
  writeFileSync(dest, buffer);
  return buffer.length;
}

/**
 * Download and SHA-verify the runtime archive for one target.
 * Returns the archive path (the archive is cached in `.package-build/downloads`).
 */
async function fetchRuntime(target, version) {
  const archivePath = join(DOWNLOAD_ROOT, `unica-runtime-${target}.tar.gz`);
  const meta = await fetchMetadata(target, version);
  const expectedSha = meta?.asset?.sha256;

  if (!existsSync(archivePath)) {
    const bytes = await downloadArchive(target, version, archivePath);
    console.log(`[download] ${basename(archivePath)}: ${bytes} bytes`);
  } else {
    console.log(`[download] using cached ${basename(archivePath)}`);
  }

  const actualSha = sha256File(archivePath);
  if (expectedSha) {
    if (actualSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
      throw new Error(
        `checksum mismatch for unica-runtime-${target}.tar.gz: ` +
          `expected ${expectedSha}, got ${actualSha}`,
      );
    }
    console.log(`[verify] unica-runtime-${target}.tar.gz sha256 OK`);
  } else {
    console.warn(
      `[warn] no release metadata (${version}/unica-runtime-${target}.json); ` +
        `pinning computed sha256 ${actualSha}`,
    );
  }

  return { archivePath, meta, archiveSha: actualSha };
}

/**
 * Extract the runtime archive into a fresh per-target directory and return the
 * directory that actually holds `bin/` and `third-party/` (the official
 * archives are rooted at `bin/` + `third-party/`, but tolerate a wrapper dir).
 */
function extractRuntime(archivePath, target) {
  const dir = join(STAGING_ROOT, ".runtime", target);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  run("tar", ["-xzf", archivePath, "-C", dir]);

  const entries = readdirSync(dir);
  if (entries.length === 1) {
    const only = join(dir, entries[0]);
    if (statSync(only).isDirectory()) return only;
  }
  return dir;
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
  console.log(`[sha256] ${sha}  ${basename(outTar)}`);
}

async function packageTarget(target, version) {
  console.log(`\n==> packaging ${target} (runtime ${version})`);
  const { archivePath } = await fetchRuntime(target, version);
  const runtimeSrc = extractRuntime(archivePath, target);

  const pkgDirName = `pi-unica-${target}`;
  const pkgDir = join(STAGING_ROOT, pkgDirName);
  rmSync(pkgDir, { recursive: true, force: true });
  ensureDir(pkgDir);

  cpSync(runtimeSrc, join(pkgDir, "runtime"), { recursive: true });
  addMarkers(join(pkgDir, "runtime"));
  copyPackageSources(pkgDir);

  const outTar = join(DIST_ROOT, `${pkgDirName}.tar.gz`);
  tarCreate(pkgDir, outTar);
  writeSha256(outTar);
  console.log(`[done] ${outTar}`);
}

/**
 * Merge the two per-target legacy manifests (top-level targetTriple +
 * per-tool binaryPath/sha256) into the multi-target `binaries` map format
 * understood by the vendored `bundled_tools.rs`.
 */
function buildUniversalManifest(manifests) {
  const targets = Object.keys(manifests);
  const tools = [];
  for (const toolName of THIRD_PARTY_TOOLS) {
    const binaries = {};
    let version = null;
    for (const target of targets) {
      const legacy = manifests[target];
      const tool = legacy?.tools?.find((t) => t.name === toolName);
      if (!tool || !tool.binaryPath || !tool.sha256) {
        throw new Error(`manifest for ${target} is missing tool ${toolName}`);
      }
      if (version === null) version = tool.version ?? null;
      binaries[target] = {
        targetTriple: TARGET_TRIPLES[target],
        binaryPath: tool.binaryPath,
        sha256: tool.sha256,
      };
    }
    tools.push({ name: toolName, version, binaries });
  }
  return {
    schemaVersion: 2,
    generatedBy: "pi-unica scripts/package.mjs",
    tools,
  };
}

async function packageUniversal(version) {
  console.log(`\n==> packaging universal (runtime ${version})`);
  const targets = VALID_TARGETS.slice();
  const runtimeDirs = {};
  const manifests = {};

  for (const target of targets) {
    const { archivePath } = await fetchRuntime(target, version);
    const runtimeSrc = extractRuntime(archivePath, target);
    runtimeDirs[target] = runtimeSrc;
    const manifestPath = join(runtimeSrc, "third-party", "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`runtime archive for ${target} has no third-party/manifest.json`);
    }
    manifests[target] = JSON.parse(readFileSync(manifestPath, "utf-8"));
  }

  const pkgDirName = "pi-unica-universal";
  const pkgDir = join(STAGING_ROOT, pkgDirName);
  rmSync(pkgDir, { recursive: true, force: true });
  ensureDir(pkgDir);

  const runtimeDest = join(pkgDir, "runtime");
  ensureDir(runtimeDest);
  for (const target of targets) {
    cpSync(join(runtimeDirs[target], "bin", target), join(runtimeDest, "bin", target), {
      recursive: true,
    });
  }
  ensureDir(join(runtimeDest, "third-party"));
  writeFileSync(
    join(runtimeDest, "third-party", "manifest.json"),
    JSON.stringify(buildUniversalManifest(manifests), null, 2) + "\n",
    "utf-8",
  );
  addMarkers(runtimeDest);
  copyPackageSources(pkgDir);

  const outTar = join(DIST_ROOT, `${pkgDirName}.tar.gz`);
  tarCreate(pkgDir, outTar);
  writeSha256(outTar);
  console.log(`[done] ${outTar}`);
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
    version: value("--version") ?? DEFAULT_VERSION,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.target && !VALID_TARGETS.includes(opts.target)) {
    throw new Error(`unknown target: ${opts.target} (supported: ${VALID_TARGETS.join(", ")})`);
  }

  ensureDir(DIST_ROOT);
  ensureDir(DOWNLOAD_ROOT);
  rmSync(STAGING_ROOT, { recursive: true, force: true });
  ensureDir(STAGING_ROOT);

  if (opts.universal) {
    await packageUniversal(opts.version);
  } else if (opts.all) {
    for (const target of VALID_TARGETS) {
      await packageTarget(target, opts.version);
    }
  } else {
    const target = opts.target ?? detectTarget();
    await packageTarget(target, opts.version);
  }
}

main().catch((error) => {
  console.error(`\n[error] ${error.message}`);
  process.exit(1);
});
