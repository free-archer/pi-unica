#!/usr/bin/env node
/**
 * Adapt the vendored `unica` plugin skills + references for the pi-unica package.
 *
 * Transformations applied to every SKILL.md:
 *   1. Drop the Claude/Codex-specific `argument-hint` frontmatter field.
 *   2. Convert `allowed-tools` from a YAML list of Claude tool names into a
 *      space-delimited list of pi tool names (the format pi's skills standard
 *      expects).
 *   3. Rewrite `/unica:<name>` command references to pi's `/skill:<name>`.
 *   4. Replace every JSON-RPC `tools/call` example with a `mcp({ tool, args })`
 *      call that routes through the pi-mcp-adapter proxy tool.
 *   5. Rewrite prose references to the raw `tools/call` transport to `mcp()`.
 *
 * References (`unica/plugins/unica/references/`) are copied verbatim; the
 * relative `../../references/...` links used by skills keep working because the
 * package keeps `skills/` and `references/` side by side at the package root.
 *
 * Idempotent: re-running regenerates `skills/` and `references/` from scratch.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const UPSTREAM = join(PACKAGE_ROOT, "unica", "plugins", "unica");
const SKILLS_SRC = join(UPSTREAM, "skills");
const REFERENCES_SRC = join(UPSTREAM, "references");
const SKILLS_DST = join(PACKAGE_ROOT, "skills");
const REFERENCES_DST = join(PACKAGE_ROOT, "references");

// Claude/Codex tool name -> pi tool name (allowed-tools frontmatter).
const TOOL_MAP = new Map([
  ["Read", "read"],
  ["Glob", "find"],
  ["Grep", "grep"],
  ["Bash", "bash"],
  ["Edit", "edit"],
  ["Write", "write"],
  ["AskUserQuestion", null], // pi has no direct equivalent; dropped
]);

function listSkillDirs(root) {
  return readdirSync(root)
    .filter((name) => {
      const p = join(root, name);
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
    })
    .sort();
}

/**
 * Convert an `allowed-tools` YAML block (possibly `allowed-tools: []`) into a
 * space-delimited pi frontmatter value.
 */
function convertAllowedTools(lines, startIdx) {
  // lines[startIdx] is the "allowed-tools:" line (possibly with inline "[]").
  const first = lines[startIdx];
  const inline = first.replace(/^allowed-tools:\s*/, "").trim();
  const items = [];

  if (inline !== "[]" && inline !== "") {
    // inline form (rare): allowed-tools: [Read, Glob]
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const inner = inline.slice(1, -1);
      for (const raw of inner.split(",")) {
        const t = raw.trim().replace(/^['"]|['"]$/g, "");
        if (t) items.push(t);
      }
    } else {
      items.push(inline.replace(/^['"]|['"]$/g, ""));
    }
  }

  // YAML list form: subsequent lines "  - ToolName"
  let i = startIdx + 1;
  while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
    const name = lines[i].replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, "");
    if (name) items.push(name);
    i += 1;
  }

  const mapped = items
    .map((name) => (TOOL_MAP.has(name) ? TOOL_MAP.get(name) : null))
    .filter((name, idx, arr) => name !== null && arr.indexOf(name) === idx);

  return { value: mapped.join(" "), nextIdx: i };
}

/**
 * Extract frontmatter (the leading --- ... --- block) and rewrite it.
 * Returns the new frontmatter block and the index just past its closing fence.
 */
function rewriteFrontmatter(lines) {
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, nextIdx: 0 };
  }
  const out = ["---"];
  let i = 1;
  while (i < lines.length && lines[i].trim() !== "---") {
    const line = lines[i];
    if (/^argument-hint:\s*/.test(line)) {
      i += 1; // drop
      continue;
    }
    if (/^allowed-tools:\s*/.test(line)) {
      const { value, nextIdx } = convertAllowedTools(lines, i);
      if (value) out.push(`allowed-tools: ${value}`);
      i = nextIdx;
      continue;
    }
    out.push(line);
    i += 1;
  }
  out.push("---");
  // i now points at the closing "---" line; advance past it.
  if (lines[i]?.trim() === "---") i += 1;
  return { frontmatter: out.join("\n"), nextIdx: i };
}

/**
 * Given the JSON text of a tools/call example, render a pi `mcp()` call.
 */
function renderMcpCall(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`failed to parse tools/call JSON: ${error.message}`);
  }
  const name = parsed?.params?.name;
  const args = parsed?.params?.arguments;
  if (typeof name !== "string") {
    throw new Error("tools/call JSON is missing params.name");
  }
  const argsText =
    args !== undefined && args !== null
      ? JSON.stringify(args, null, 2)
      : "{}";
  return `mcp({\n  tool: ${JSON.stringify(name)},\n  args: ${indentBlock(argsText, 2)}\n})`;
}

function indentBlock(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, idx) => (idx === 0 ? line : pad + line))
    .join("\n");
}

/**
 * Rewrite a single SKILL.md body, transforming JSON-RPC tools/call fences and
 * prose transport references.
 */
function transformBody(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(json|jsonc)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const block = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        block.push(lines[i]);
        i += 1;
      }
      const closing = lines[i] ?? "```";
      i += 1;
      const body = block.join("\n");
      if (body.includes('"method": "tools/call"') || body.includes('"method":"tools/call"')) {
        try {
          out.push("```js");
          out.push(renderMcpCall(body));
          out.push("```");
        } catch (error) {
          console.warn(`  [warn] keeping tools/call block as-is: ${error.message}`);
          out.push(`\`\`\`${lang}`);
          out.push(...block);
          out.push("```");
        }
      } else {
        out.push(`\`\`\`${lang}`);
        out.push(...block);
        out.push(closing);
      }
      continue;
    }

    // Prose transforms on non-fence lines.
    let text = line
      // Command references
      .replace(/\/unica:([a-z0-9-]+)/g, "/skill:$1")
      // Raw transport references (only meaningful outside the JSON fences,
      // which are handled above).
      .replace(/`tools\/call`/g, "`mcp()`")
      .replace(/tools\/call/g, "mcp()")
      // Preferred-path routing bullets.
      .replace(
        /use MCP `unica` tool `unica\.([A-Za-z0-9_.]+)`/g,
        'call `mcp({ tool: "unica.$1", args: { ... } })`',
      )
      .replace(/use MCP `unica` tools `/g, "call through the `mcp()` proxy with tools `")
      // Section header for the routing block: add the pi-mcp-adapter call
      // convention once, right under the header.
      .replace(
        /^## MCP routing$/,
        '## MCP routing\n\nВсе инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.',
      );

    out.push(text);
    i += 1;
  }
  return out;
}

function adaptSkill(srcDir, dstDir, name) {
  const srcPath = join(srcDir, name, "SKILL.md");
  const dstPath = join(dstDir, name, "SKILL.md");
  const raw = readFileSync(srcPath, "utf-8").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  const { frontmatter, nextIdx } = rewriteFrontmatter(lines);
  if (!frontmatter) {
    throw new Error(`${name}: missing frontmatter`);
  }
  const body = transformBody(lines.slice(nextIdx));

  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, frontmatter + "\n\n" + body.join("\n").trimEnd() + "\n", "utf-8");
}

function copyTree(src, dst) {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
}

function main() {
  if (!existsSync(SKILLS_SRC)) {
    console.error(`upstream skills not found: ${SKILLS_SRC}`);
    process.exit(1);
  }

  const names = listSkillDirs(SKILLS_SRC);
  console.log(`adapting ${names.length} skills -> ${relative(PACKAGE_ROOT, SKILLS_DST)}`);

  rmSync(SKILLS_DST, { recursive: true, force: true });
  mkdirSync(SKILLS_DST, { recursive: true });

  for (const name of names) {
    adaptSkill(SKILLS_SRC, SKILLS_DST, name);
  }

  if (existsSync(REFERENCES_SRC)) {
    copyTree(REFERENCES_SRC, REFERENCES_DST);
    console.log(`copied references -> ${relative(PACKAGE_ROOT, REFERENCES_DST)}`);
  } else {
    console.warn(`references not found: ${REFERENCES_SRC}`);
  }

  console.log("done.");
}

main();
