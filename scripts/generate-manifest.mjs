#!/usr/bin/env node
/**
 * Generate `runtime/third-party/manifest.json` for the pi-unica package.
 *
 * The manifest contract is defined by the vendored Rust binary:
 *   crates/unica-coder/src/infrastructure/bundled_tools.rs
 * It expects, for each bundled third-party tool, a `binaries` map keyed by
 * target id (`linux-x64` / `darwin-arm64` / `win-x64`) whose values carry
 * `binaryPath` (relative to the plugin root), `sha256` (of the extracted
 * binary, not the downloaded archive) and optionally `targetTriple`.
 *
 * The `sha256` is computed from the actual binary on disk, so the manifest
 * always reflects reality; a corrupt or missing binary produces an explicit
 * error rather than a silently wrong manifest.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const LOCK_PATH = join(PACKAGE_ROOT, "unica", "plugins", "unica", "third-party", "tools.lock.json");
const RUNTIME_ROOT = join(PACKAGE_ROOT, "runtime");
const MANIFEST_PATH = join(RUNTIME_ROOT, "third-party", "manifest.json");

// Only these tools are resolved by the unica binary via the bundled-tools
// mechanism. The `unica` entry in tools.lock.json is a cargo-workspace build
// instruction, not a runtime-resolved bundled tool.
const THIRD_PARTY_TOOLS = ["bsl-analyzer", "v8-runner", "rlm-bsl-mcp", "rlm-bsl-index"];

function sha256File(path) {
  const hash = createHash("sha256");
  const data = readFileSync(path);
  hash.update(data);
  return hash.digest("hex");
}

function loadLock() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  if (lock.schemaVersion !== 1) {
    throw new Error(`unsupported tools.lock.json schemaVersion: ${lock.schemaVersion}`);
  }
  return lock;
}

/**
 * Generate the manifest for a single target.
 * @param {string} target  target id: linux-x64 | darwin-arm64 | win-x64
 * @returns {{ manifest: object, checks: Array<{name: string, sha256: string}> }}
 */
export function generateManifest(target) {
  const lock = loadLock();
  const cfg = lock.targets?.[target];
  if (!cfg) {
    throw new Error(`tools.lock.json has no target "${target}"`);
  }
  const exe = cfg.exe ?? "";
  const targetTriple = cfg.targetTriple;
  const binDir = join(RUNTIME_ROOT, "bin", target);

  const tools = [];
  const checks = [];
  for (const toolName of THIRD_PARTY_TOOLS) {
    const tool = lock.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`tools.lock.json is missing tool "${toolName}"`);
    }
    const binaryName = tool.binaryName;
    const binaryPathRel = `bin/${target}/${binaryName}${exe}`;
    const binaryPathAbs = join(RUNTIME_ROOT, binaryPathRel);
    if (!existsSync(binaryPathAbs) || !statSync(binaryPathAbs).isFile()) {
      throw new Error(
        `binary missing for ${toolName}: ${binaryPathAbs}\n` +
          `Run scripts/setup-backend.sh first to build and download the runtime.`,
      );
    }
    const sha = sha256File(binaryPathAbs);
    tools.push({
      name: toolName,
      version: tool.version ?? null,
      binaries: {
        [target]: {
          targetTriple,
          binaryPath: binaryPathRel,
          sha256: sha,
        },
      },
    });
    checks.push({ name: toolName, sha256: sha, binaryPath: binaryPathRel });
  }

  const manifest = {
    schemaVersion: 2,
    generatedBy: "pi-unica scripts/generate-manifest.mjs",
    sourceLock: "third-party/tools.lock.json",
    target,
    tools,
  };

  return { manifest, checks, target, targetTriple };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(`usage: node generate-manifest.mjs <target>\n  target: linux-x64 | darwin-arm64 | win-x64`);
    process.exit(64);
  }
  try {
    const { manifest, checks } = generateManifest(target);
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    for (const c of checks) {
      console.log(`  ${c.name.padEnd(16)} ${c.sha256}  ${c.binaryPath}`);
    }
    console.log(`manifest written: ${MANIFEST_PATH}`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
