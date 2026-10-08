/*
<MODULE_CONTRACT>
<purpose>RFC-1242: validate that the live root docs/*.xml corpus describes the repository as it exists — every path token, workspace id, and knowledge-graph link target must resolve to a real file, directory, or declared node.</purpose>
<non-goals>
  <item>Do not scan archived trees, vendored specs, sessions/metrics, or authored RFC/ADR/plan bodies — frozen history and forward-looking prose legitimately name paths that do not exist.</item>
  <item>Do not validate markdown link targets — only the XML semantic layer is gated (markdown sweep is manual).</item>
  <item>Do not mutate anything — this handler is read-only; pruning lives on compass.audit.validate --prune.</item>
</non-goals>
<KEY_DECISIONS>
  <item>Tag-stack tokenizer instead of an XML dependency — the corpus is small authored XML; a balance check catches the literal-tag breakage class (COMPASS-DOC-00) without pulling fast-xml-parser.</item>
  <item>DOC-03 link targets resolve to declared node ids OR file/dir conventions — dangling-by-convention stays a warning, never an error.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1242: created — scan docs/*.xml for unresolvable paths, workspace ids, and link targets (COMPASS-DOC-00..03).</item>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { resolveIo } from "../../../src/utils/io.ts";
import type { Diagnostic, WorkspaceIO } from "../../../src/types.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const DOCS_GLOB = "*.xml";

// Well-formedness: minimal tag-stack check. Skips comments, CDATA, PIs and
// declarations; a literal `<name` inside prose opens a tag that never balances
// → COMPASS-DOC-00. The corpus is authored XML without < in attribute values.
function checkWellFormed(file: string, source: string): { line: number; message: string } | null {
  const stack: Array<{ name: string; line: number }> = [];
  let i = 0;
  let line = 1;
  const advanceLine = (chunk: string) => {
    for (const c of chunk) if (c === "\n") line++;
  };
  while (i < source.length) {
    const open = source.indexOf("<", i);
    if (open === -1) break;
    advanceLine(source.slice(i, open));
    const rest = source.slice(open);
    // comments / CDATA / PI / declarations
    if (rest.startsWith("<!--")) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) return { line, message: "unterminated comment" };
      advanceLine(source.slice(open, end + 3));
      i = end + 3;
      continue;
    }
    if (rest.startsWith("<![CDATA[")) {
      const end = source.indexOf("]]>", open + 9);
      if (end === -1) return { line, message: "unterminated CDATA" };
      advanceLine(source.slice(open, end + 3));
      i = end + 3;
      continue;
    }
    if (rest.startsWith("<?")) {
      const end = source.indexOf("?>", open + 2);
      if (end === -1) return { line, message: "unterminated processing instruction" };
      advanceLine(source.slice(open, end + 2));
      i = end + 2;
      continue;
    }
    if (rest.startsWith("<!")) {
      const end = source.indexOf(">", open + 2);
      if (end === -1) return { line, message: "unterminated declaration" };
      advanceLine(source.slice(open, end + 1));
      i = end + 1;
      continue;
    }
    const tagMatch = /^<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)?(\/?)>/.exec(rest);
    if (!tagMatch) {
      // `<` not starting a tag — literal text, tolerated.
      advanceLine(source.slice(open, open + 1));
      i = open + 1;
      continue;
    }
    const [, closing, name, attrs = "", selfClose] = tagMatch;
    advanceLine(tagMatch[0]);
    i = open + tagMatch[0].length;
    if (closing === "/") {
      const top = stack.pop();
      if (!top || top.name !== name) {
        return {
          line,
          message: `mismatched closing tag </${name}>${top ? ` — expected </${top.name}> opened at line ${top.line}` : " — no open tag"}`,
        };
      }
      continue;
    }
    if (selfClose !== "/" && !attrs.trimEnd().endsWith("/")) {
      stack.push({ name, line });
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    return { line: top.line, message: `unclosed tag <${top.name}>` };
  }
  return null;
}

interface ExtractedRefs {
  paths: Array<{ value: string; line: number }>;
  workspaceIds: Array<{ id: string; line: number }>;
  linkTargets: Array<{ target: string; line: number }>;
}

function extractRefs(source: string): ExtractedRefs {
  const refs: ExtractedRefs = { paths: [], workspaceIds: [], linkTargets: [] };
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const m of source.matchAll(/<path>([\s\S]*?)<\/path>/g)) {
    refs.paths.push({ value: m[1] ?? "", line: lineOf(m.index) });
  }
  for (const m of source.matchAll(/<workspace\s[^>]*?id="([^"]+)"/g)) {
    refs.workspaceIds.push({ id: m[1]!, line: lineOf(m.index) });
  }
  for (const m of source.matchAll(/<node\s[^>]*>/g)) {
    // DOC-02 only applies to ids that claim a workspace: <workspace> entries
    // and workspace-typed nodes. Layer/symbolic ids (apps.rules,
    // packages.rules, changelog.*) name semantic handles, not directories.
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const type = /\btype="([^"]+)"/.exec(m[0])?.[1];
    if (id && type === "workspace") {
      refs.workspaceIds.push({ id, line: lineOf(m.index) });
    }
  }
  for (const m of source.matchAll(/<link\s[^>]*?target="([^"]+)"/g)) {
    refs.linkTargets.push({ target: m[1]!, line: lineOf(m.index) });
  }
  return refs;
}

// Normalize a <path> payload into checkable path tokens. Each backticked
// fragment is one candidate — splitting on commas inside would shred brace
// expansions (`{a,b}`) and ellipsis ranges (`docs/x/…` … `leaf`). A bare tail
// fragment after an `…` outside the backticks resolves under the previous
// fragment's directory (range shorthand for two versions of the same dir).
function pathTokens(raw: string): string[] {
  const tokens: string[] = [];
  const fragments = [...raw.matchAll(/`([^`]*)`/g)].map((m) => m[1]!.trim());
  if (fragments.length === 0) {
    return raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !t.startsWith("<") && t !== "…" && t !== "+");
  }
  const joinsWithEllipsis = raw.replace(/`[^`]*`/g, "").includes("…");
  let parentDir: string | null = null;
  for (const frag of fragments) {
    const cleaned = frag.replace(/(?:…|\.\.\.).*$/, "").replace(/\/+$/, "");
    if (!cleaned || cleaned === "+") continue;
    if (joinsWithEllipsis && !cleaned.includes("/") && parentDir) {
      tokens.push(`${parentDir}/${cleaned}`);
      continue;
    }
    tokens.push(cleaned);
    parentDir = cleaned.split("/").slice(0, -1).join("/") || parentDir;
  }
  return tokens;
}

/** Directory prefix that must exist for a path token (glob tails trimmed). */
function pathCheckTarget(token: string): string {
  const globIdx = token.search(/[*{[]/);
  if (globIdx === -1) return token;
  const prefix = token.slice(0, globIdx);
  return prefix.replace(/\/[^/]*$/, "") || ".";
}

/** Resolve a workspace-style id to the package/service directory it names. */
function workspaceIdTarget(id: string): string | null {
  const pkg = /^pkg-([a-z0-9-]+)$/.exec(id);
  if (pkg) return `packages/${pkg[1]}`;
  const svc = /^svc-([a-z0-9-]+)$/.exec(id);
  if (svc) return `services/${svc[1]}`;
  const app = /^app-([a-z0-9-]+)$/.exec(id);
  if (app) return `apps/${app[1]}`;
  const dotted = /^(packages|apps|services)\.([a-z0-9-]+)/.exec(id);
  if (dotted) return `${dotted[1]}/${dotted[2]}`;
  return null;
}

/**
 * DOC-03 resolution for dotted link targets: declared node id (checked by the
 * caller) or a file/dir convention — docs.<dir>.<slug> → docs/<dir>/<slug>*,
 * packages./apps./services. → workspace dir, spec.<x> → docs/specs/<x>*,
 * dna-N → docs/architecture-dna.md, dotted command names → command manifest.
 */
async function linkTargetResolves(
  target: string,
  declaredIds: Set<string>,
  io: WorkspaceIO,
  docsDir: string,
  commandNames: Set<string>,
): Promise<"node" | "file" | "none"> {
  if (declaredIds.has(target)) return "node";
  if (commandNames.has(target)) return "file";
  if (/^dna-\d+$/.test(target)) {
    return (await io.exists(resolve(docsDir, "architecture-dna.md"))) ? "file" : "none";
  }
  const docsId = /^docs\.([a-z-]+)\..*?([a-z]+-\d{3,}.*)$/.exec(target);
  if (docsId) {
    const [, dir, slug] = docsId;
    const hits = await io.glob(`${docsId[1]}/**/${slug}*.md`, { cwd: docsDir }).catch(() => []);
    if (hits.length > 0) return "file";
    // generic fallback: any file whose basename starts with the slug under docs/
    const broad = await io.glob(`**/${slug}*`, { cwd: docsDir }).catch(() => []);
    if (broad.length > 0) return "file";
    return "none";
  }
  const ws = workspaceIdTarget(target);
  if (ws) return (await io.exists(ws)) ? "file" : "none";
  const spec = /^spec\.([a-z0-9-]+)$/.exec(target);
  if (spec) {
    const hits = await io.glob(`specs/${spec[1]}*/**`, { cwd: docsDir }).catch(() => []);
    const dirs = await io.glob(`specs/${spec[1]}*`, { cwd: docsDir }).catch(() => []);
    return hits.length + dirs.length > 0 ? "file" : "none";
  }
  return "none";
}

export async function runCompassDocsValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    scanned: { xmlFiles: number; pathsChecked: number; idsChecked: number };
    diagnostics: Diagnostic[];
  }>
> {
  const io = resolveIo(context.io);
  const docsDir = resolve(context.workspaceRoot, "docs");
  const diagnostics: Diagnostic[] = [];
  let pathsChecked = 0;
  let idsChecked = 0;

  // Command-name convention for DOC-03: dotted targets like ratgeber.hub.validate
  // resolve when the command registry lists them.
  const commandNames = new Set<string>();
  const manifestPath = resolve(docsDir, "command-manifest.generated.yaml");
  if (await io.exists(manifestPath)) {
    const manifest = await io.readFile(manifestPath);
    for (const m of manifest.matchAll(/^\s*- name: ([\w.-]+)\s*$/gm)) {
      commandNames.add(m[1]!);
    }
  }

  const xmlFiles = (await io.glob(DOCS_GLOB, { cwd: docsDir })).sort();
  const declaredNodeIds = new Set<string>();

  // Pass 1: collect declared node ids so link targets can resolve across files.
  const sources = new Map<string, string>();
  for (const rel of xmlFiles) {
    const abs = resolve(docsDir, rel);
    const source = await io.readFile(abs);
    sources.set(rel, source);
    for (const m of source.matchAll(/<node\s[^>]*?id="([^"]+)"/g)) {
      declaredNodeIds.add(m[1]!);
    }
  }

  for (const rel of xmlFiles) {
    const file = `docs/${rel}`;
    const source = sources.get(rel)!;

    const malformed = checkWellFormed(file, source);
    if (malformed) {
      diagnostics.push({
        ruleId: "COMPASS-DOC-00",
        severity: "error",
        file,
        line: malformed.line,
        message: `file is not well-formed XML: ${malformed.message}`,
      });
      continue; // refs from a broken file are noise
    }

    const refs = extractRefs(source);

    for (const { value, line } of refs.paths) {
      for (const token of pathTokens(value)) {
        pathsChecked++;
        const target = pathCheckTarget(token);
        if (!(await io.exists(resolve(context.workspaceRoot, target)))) {
          diagnostics.push({
            ruleId: "COMPASS-DOC-01",
            severity: "error",
            file,
            line,
            message: `<path> references '${token}' — does not exist under the workspace root`,
            fixHint: "Repoint to the live path or remove the stale reference",
          });
        }
      }
    }

    for (const { id, line } of refs.workspaceIds) {
      const target = workspaceIdTarget(id);
      if (!target) continue;
      idsChecked++;
      if (!(await io.exists(resolve(context.workspaceRoot, target)))) {
        diagnostics.push({
          ruleId: "COMPASS-DOC-02",
          severity: "error",
          file,
          line,
          message: `id '${id}' names workspace path '${target}' — does not exist`,
          fixHint: "Repoint to the live package or remove the stale entry",
        });
      }
    }

    for (const { target, line } of refs.linkTargets) {
      idsChecked++;
      const resolved = await linkTargetResolves(target, declaredNodeIds, io, docsDir, commandNames);
      if (resolved === "none") {
        diagnostics.push({
          ruleId: "COMPASS-DOC-03",
          severity: "warning",
          file,
          line,
          message: `link target '${target}' resolves to no declared node and no file`,
        });
      }
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  for (const d of diagnostics) {
    context.logger[d.severity === "error" ? "error" : "warn"](
      `[compass.docs.validate] ${d.ruleId}: ${d.file}${d.line ? `:${d.line}` : ""}: ${d.message}`,
    );
  }

  return {
    data: {
      scanned: { xmlFiles: xmlFiles.length, pathsChecked, idsChecked },
      diagnostics,
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary:
      errors.length === 0
        ? `[compass.docs.validate] OK (${xmlFiles.length} files, ${pathsChecked} paths, ${idsChecked} ids)`
        : `[compass.docs.validate] ${errors.length} error(s)`,
  };
}
