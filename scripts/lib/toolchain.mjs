/**
 * Shared runtime acquisition for pi-unica.
 *
 * Since Unica 0.13 the published `unica-runtime-<target>.tar.gz` is *thin*: it
 * carries the `unica` binary and a generated tool manifest, and nothing else.
 * The four third-party engines (bsl-analyzer, v8-runner, rlm-bsl-mcp,
 * rlm-bsl-index) live in their own immutable releases and are addressed by
 * `plugins/unica/third-party/tools.lock.json` of the vendored source.
 *
 * Both entry points of this package need the same two steps — take the core
 * from the release, place the locked engines next to it — so they share this
 * module instead of growing two drifting copies:
 *   - scripts/setup-backend.mjs -> runtime/ for the current host
 *   - scripts/package.mjs       -> runtime/ inside each dist/ archive
 *
 * Every downloaded byte is SHA-256 verified against the lock (engines) or the
 * release metadata (core); nothing is trusted because it arrived over HTTPS.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { UNICA_RELEASE_REPO, UNICA_VERSION, UNICA_CORE_VERSION } from "./version.mjs";

export { UNICA_RELEASE_REPO };

/** Host id -> Rust target triple. Target ids are the keys used by the lock. */
export const TARGET_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "win-x64": "x86_64-pc-windows-msvc",
};

/**
 * Engines resolved at runtime through `runtime/third-party/manifest.json`.
 * The `unica` entry of the lock is a cargo build instruction, not a bundled
 * engine, and is handled separately (see fetchUnicaCore / buildUnica).
 */
export const THIRD_PARTY_TOOLS = ["bsl-analyzer", "v8-runner", "rlm-bsl-mcp", "rlm-bsl-index"];

export function log(step, message) {
  console.log(`[${step}] ${message}`);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

export function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/**
 * Describe one target inside `runtime/runtime-manifest.json`: which Unica
 * release the core came from, which engines sit next to it, and the exact bytes
 * of each. `origin` is `release`, `local-build` or `url`.
 */
export function buildRuntimeManifestEntry({ target, core, engines, origin = "release" }) {
  const binaryName = (path) => path.split(/[\\/]/).pop();
  return {
    targetTriple: TARGET_TRIPLES[target],
    core: {
      origin,
      binaryPath: `bin/${target}/unica${exeSuffix(target)}`,
      sha256: core?.sha256 ?? null,
    },
    engines: (engines ?? [])
      .map((engine) => ({
        name: engine.name,
        version: engine.version,
        assetName: engine.assetName,
        binaryPath: `bin/${target}/${binaryName(engine.path)}`,
        sha256: engine.sha256,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Write the version record of an assembled runtime tree. This is the file that
 * answers "which Unica is this plugin built on?" without asking a binary or a
 * running server.
 */
export function writeRuntimeManifest(runtimeRoot, { generatedBy, targets }) {
  const manifest = {
    schemaVersion: 2,
    generatedBy,
    pluginVersion: UNICA_CORE_VERSION,
    unicaVersion: UNICA_VERSION,
    source: { repository: UNICA_RELEASE_REPO, tag: UNICA_VERSION },
    targets,
  };
  const path = join(runtimeRoot, "runtime-manifest.json");
  ensureDir(runtimeRoot);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return { path, manifest };
}

export function exeSuffix(target) {
  return target === "win-x64" ? ".exe" : "";
}

/** Load the vendored `plugins/unica/third-party/tools.lock.json`. */
export function loadLock(unicaRoot) {
  const path = join(unicaRoot, "plugins", "unica", "third-party", "tools.lock.json");
  if (!existsSync(path)) {
    throw new Error(`tools.lock.json not found: ${path}`);
  }
  const lock = JSON.parse(readFileSync(path, "utf-8"));
  if (lock.schemaVersion !== 1) {
    throw new Error(`unsupported tools.lock.json schemaVersion: ${lock.schemaVersion}`);
  }
  return { lock, path };
}

export function lockTool(lock, name) {
  const tool = lock.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tools.lock.json is missing tool "${name}"`);
  return tool;
}

/**
 * Where an engine's bytes come from. The lock distinguishes three delivery
 * shapes; all of them are just "a URL plus a checked SHA-256" to this module:
 *   - direct-release-asset      one bare binary
 *   - archive-release-asset     an archive published by the toolchain repo
 *   - upstream-archive-release-asset  an archive published by the tool's own repo
 */
export function releaseAssetUrl(tool, asset) {
  const repository = tool.assetRepository || tool.repository;
  const tag = tool.assetTag || tool.sourceTag;
  return `${repository}/releases/download/${tag}/${asset.assetName}`;
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
        log("warn", `fetch failed for ${url} (attempt ${i + 1}/${attempts}); retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/** Fetch JSON, returning null for a missing (404) document. */
async function fetchJson(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Download `url` to `dest`, returning the byte count. */
export async function download(url, dest) {
  log("download", url);
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  ensureDir(dirname(dest));
  writeFileSync(dest, buffer);
  return buffer.length;
}

function verifySha256(path, expected, label) {
  const actual = sha256File(path);
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

/** Extract a `.tar.gz` (or `.zip`, used by the Windows v8-runner asset). */
export function extractArchive(archivePath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  ensureDir(destDir);
  if (archivePath.endsWith(".zip")) {
    run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
    return;
  }
  run("tar", ["-xzf", archivePath, "-C", destDir]);
}

/**
 * Locate one declared member inside an extracted archive. The lock names it as
 * `<archive-root>/<file>`; we look for that exact path first and fall back to a
 * basename search so a re-rooted upstream archive still resolves.
 */
function findArchiveMember(root, declaredName) {
  const exact = join(root, declaredName);
  if (existsSync(exact) && statSync(exact).isFile()) return exact;

  const wanted = basename(declaredName);
  const stack = [root];
  const matches = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (entry === wanted) matches.push(full);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`ambiguous archive member ${declaredName} (${matches.length} candidates)`);
  }
  return matches[0];
}

/**
 * Install the four locked engines for `target` into `binDir`.
 *
 * @returns {Promise<Array<{name: string, version: string|null, assetName: string,
 *                          sha256: string, path: string}>>}
 */
export async function installThirdParty({ target, lock, binDir, cacheDir, dryRun = false, ignoreExisting = false }) {
  if (!TARGET_TRIPLES[target]) throw new Error(`unknown target: ${target}`);
  const exe = exeSuffix(target);
  ensureDir(binDir);
  ensureDir(cacheDir);

  // Engines sharing one archive (rlm-tools-bsl carries two) are downloaded once.
  const archiveJobs = new Map();
  const installed = [];

  for (const toolName of THIRD_PARTY_TOOLS) {
    const tool = lockTool(lock, toolName);
    const asset = tool.assets?.[target];
    if (!asset) throw new Error(`${toolName} has no asset for ${target}`);
    const dest = join(binDir, `${tool.binaryName}${exe}`);

    if (tool.assetStrategy === "direct-release-asset") {
      if (!ignoreExisting && existsSync(dest)) {
        log("engine", `${toolName} ${tool.version}: already present`);
      } else if (dryRun) {
        log("engine", `[dry-run] would fetch ${releaseAssetUrl(tool, asset)}`);
        continue;
      } else {
        const tmp = join(cacheDir, `${tool.version ?? "unpinned"}-${asset.assetName}`);
        if (!existsSync(tmp)) await download(releaseAssetUrl(tool, asset), tmp);
        verifySha256(tmp, asset.sha256, toolName);
        copyFileSync(tmp, dest);
        chmodSync(dest, 0o755);
        log("engine", `${toolName} ${tool.version}: verified`);
      }
      if (existsSync(dest)) {
        installed.push({
          name: toolName,
          version: tool.version ?? null,
          assetName: asset.assetName,
          sha256: sha256File(dest),
          path: dest,
        });
      }
      continue;
    }

    if (
      tool.assetStrategy === "archive-release-asset" ||
      tool.assetStrategy === "upstream-archive-release-asset"
    ) {
      const key = asset.assetName;
      if (!archiveJobs.has(key)) archiveJobs.set(key, { tool, asset, tools: [] });
      archiveJobs.get(key).tools.push(tool);
      continue;
    }

    throw new Error(`unsupported assetStrategy for ${toolName}: ${tool.assetStrategy}`);
  }

  for (const { tool, asset, tools } of archiveJobs.values()) {
    const exeMissing = ignoreExisting
      ? tools.slice()
      : tools.filter((t) => !existsSync(join(binDir, `${t.binaryName}${exe}`)));
    if (exeMissing.length === 0) {
      log("engine", `${tools.map((t) => t.name).join(", ")}: already present`);
    } else if (dryRun) {
      log(
        "engine",
        `[dry-run] would fetch ${releaseAssetUrl(tool, asset)} and extract ` +
          `${tools.map((t) => t.assets[target].archiveBinary).join(", ")}`,
      );
      continue;
    } else {
      // Cache key carries the tool version: asset names alone are not unique
      // across releases (`rlm-tools-bsl-linux-x64.tar.gz` names every version).
      const archive = join(cacheDir, `${tool.version ?? "unpinned"}-${asset.assetName}`);
      if (!existsSync(archive)) await download(releaseAssetUrl(tool, asset), archive);
      verifySha256(archive, asset.sha256, asset.assetName);
      if (typeof asset.size === "number" && statSync(archive).size !== asset.size) {
        throw new Error(
          `${asset.assetName} size mismatch: expected ${asset.size}, got ${statSync(archive).size}`,
        );
      }
      const extractDir = join(
        cacheDir,
        "extract",
        `${tool.version ?? "unpinned"}-${basename(asset.assetName).replace(/\.(tar\.gz|zip)$/, "")}`,
      );
      extractArchive(archive, extractDir);
      for (const t of tools) {
        const member = t.assets[target].archiveBinary;
        const found = findArchiveMember(extractDir, member);
        if (!found) throw new Error(`${asset.assetName} does not contain ${member}`);
        const dest = join(binDir, `${t.binaryName}${exe}`);
        copyFileSync(found, dest);
        chmodSync(dest, 0o755);
        log("engine", `${t.name} ${t.version}: extracted from ${asset.assetName}`);
      }
    }

    for (const t of tools) {
      const dest = join(binDir, `${t.binaryName}${exe}`);
      if (!existsSync(dest)) continue;
      installed.push({
        name: t.name,
        version: t.version ?? null,
        assetName: asset.assetName,
        sha256: sha256File(dest),
        path: dest,
      });
    }
  }

  return installed;
}

/**
 * Fetch the thin core archive of `version` for `target` and place the `unica`
 * binary into `binDir`.
 *
 * The archive carries only `bin/<target>/unica[.exe]` plus a generated tool
 * manifest. The companion `<archive>.json` metadata names the exact bytes, so
 * both the archive and the extracted binary are verified, and the metadata
 * `version` is checked against the version this package pins.
 */
export async function fetchUnicaCore({
  target,
  version,
  coreVersion,
  binDir,
  cacheDir,
  dryRun = false,
  ignoreExisting = false,
}) {
  const exe = exeSuffix(target);
  const dest = join(binDir, `unica${exe}`);
  ensureDir(binDir);
  ensureDir(cacheDir);

  const metaUrl = `${UNICA_RELEASE_REPO}/releases/download/${version}/unica-runtime-${target}.json`;
  const archiveUrl = `${UNICA_RELEASE_REPO}/releases/download/${version}/unica-runtime-${target}.tar.gz`;

  if (!ignoreExisting && existsSync(dest)) {
    log("core", `unica ${coreVersion ?? version}: already present (${dest})`);
    return { path: dest, sha256: sha256File(dest), meta: null, fromCache: true };
  }
  if (dryRun) {
    log("core", `[dry-run] would fetch ${archiveUrl} and take bin/${target}/unica${exe}`);
    return { path: dest, sha256: null, meta: null, dryRun: true };
  }

  const meta = await fetchJson(metaUrl);
  if (meta && coreVersion && meta.version && meta.version !== coreVersion) {
    throw new Error(
      `release ${version} publishes unica ${meta.version}, but this package pins ${coreVersion}`,
    );
  }

  const archive = join(cacheDir, `${version}-unica-runtime-${target}.tar.gz`);
  if (!existsSync(archive)) {
    await download(archiveUrl, archive);
  } else {
    log("core", `using cached ${basename(archive)}`);
  }
  if (meta?.asset?.sha256) {
    verifySha256(archive, meta.asset.sha256, `unica-runtime-${target}.tar.gz`);
    log("core", `unica-runtime-${target}.tar.gz sha256 OK`);
  } else {
    log("warn", `no release metadata at ${metaUrl}; pinning computed archive sha256`);
  }

  const extractDir = join(cacheDir, `${version}-unica-runtime-${target}-extract`);
  extractArchive(archive, extractDir);

  let contentRoot = extractDir;
  const topLevel = readdirSync(extractDir).filter((entry) =>
    statSync(join(extractDir, entry)).isDirectory(),
  );
  if (topLevel.length === 1 && !existsSync(join(extractDir, "bin"))) {
    contentRoot = join(extractDir, topLevel[0]);
  }

  const source = join(contentRoot, "bin", target, `unica${exe}`);
  if (!existsSync(source)) {
    throw new Error(`core archive has no bin/${target}/unica${exe}: ${archiveUrl}`);
  }
  const declaredFile = meta?.files?.find((f) => f.path === `bin/${target}/unica${exe}`);
  if (declaredFile?.sha256) {
    verifySha256(source, declaredFile.sha256, `bin/${target}/unica${exe}`);
  }
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  log("core", `unica ${coreVersion ?? version}: installed ${dest}`);
  return { path: dest, sha256: sha256File(dest), meta, fromCache: false };
}

/**
 * Build the `unica` binary from the vendored source with cargo. Kept as an
 * explicit opt-in: the released binary is the same artifact every host gets,
 * while a local build exists for working on the core itself.
 */
export function buildUnicaLocal({ unicaRoot, binDir, target, targetDir }) {
  const exe = exeSuffix(target);
  const dest = join(binDir, `unica${exe}`);
  ensureDir(binDir);
  log("build", "cargo build --release --locked -p unica-coder --bin unica");
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "-p",
      "unica-coder",
      "--bin",
      "unica",
      "--target-dir",
      targetDir,
    ],
    { cwd: unicaRoot },
  );
  const produced = join(targetDir, "release", `unica${exe}`);
  if (!existsSync(produced)) throw new Error(`cargo build output not found: ${produced}`);
  copyFileSync(produced, dest);
  chmodSync(dest, 0o755);
  log("build", `built ${dest}`);
  return dest;
}
