/*
<MODULE_CONTRACT>
<purpose>
  yaml.scalars.validate — RFC-1478 (F-0006): lint authored YAML for plain
  scalars carrying colon-space traps. A value written as `key: v1: v2` is a
  loud parse error (YAML-PARSE-01 territory); the same token reaching a
  deeper-indented continuation line silently reinterprets a flat scalar as
  a nested map — generators then read a different shape and skip the file
  quietly. This scan flags the unquoted `": "` fingerprint in both shapes
  before either consumer sees it.
</purpose>
<non-goals>
  <item>Do not duplicate YAML-PARSE-01/02 — parse errors and duplicate keys stay with yaml.parse.validate; this lint covers the reinterpretation class only.</item>
  <item>Do not rewrite files — diagnostics only; quoting is the author's fix.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1478: initial collector + handler — line-scan over the YAML region (.md frontmatter or whole .yaml), unquoted `": "` flagged as YAML-SCALAR-01 with file/line/key; quoted scalars, block scalars, comments, and flow collections excluded.</item>
  <item>RFC-1478: yaml.scalars.validate + EC-25 colon-space staged lint (F-0006)</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  CheckResult,
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ScalarTrap {
  file: string;
  line: number;
  key: string;
  preview: string;
}

export interface YamlScalarsValidateResult extends CheckResult {
  filesScanned: number;
}

interface LineScan {
  /** 1-based line number in the FILE (frontmatter offset applied). */
  index: number;
  indent: number;
  text: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const KEY_VALUE_RE = /^(\s*)(?:-\s+)?([^\s"'#][^:]*?):\s+(.*)$/;
const QUOTED_RE = /^(['"]).*\1\s*(?:#.*)?$/;
const BLOCK_SCALAR_RE = /:\s*[|>]/;
const COMMENT_RE = /^\s*#/;
const DOC_MARKER_RE = /^\s*---\s*$/;
const SEQ_ITEM_RE = /^\s*-\s/;
const FLOW_VALUE_RE = /^[{[]/;

function firstColonSpaceOutsideQuotes(value: string): number {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || value[i - 1] === " ")) return -1;
    if (ch === ":" && value[i + 1] === " ") return i;
  }
  return -1;
}

/**
 * RFC-1478: flag unquoted `": "` inside plain scalar values and the silent
 * continuation shape — a `key: scalar` line whose next line is a deeper-
 * indented `word: rest` (the scalar ends and a phantom key materializes).
 * .md inputs scan the leading frontmatter block only; body prose is never
 * YAML. Block scalars (| and >), comment lines, quoted values, and flow
 * collections are excluded structurally.
 */
export function collectScalarTraps(relPath: string, raw: string): ScalarTrap[] {
  let region: string;
  let lineOffset: number;
  if (relPath.endsWith(".md")) {
    const fm = raw.match(FM_RE);
    if (!fm) return [];
    region = fm[1]!;
    lineOffset = 1; // opening --- occupies line 1
  } else if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) {
    region = raw;
    lineOffset = 0;
  } else {
    return [];
  }

  const lines: LineScan[] = region.split("\n").map((text, i) => ({
    index: i + 1 + lineOffset,
    indent: text.match(/^\s*/)![0].replace(/\t/g, "  ").length,
    text,
  }));

  const traps: ScalarTrap[] = [];
  let blockScalarFloor = -1; // lines deeper than this indent belong to a | / > scalar
  let quoteFloor = -1; // lines deeper than this indent continue a multi-line quoted scalar
  let quoteChar: "'" | '"' | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.text.trim();
    if (trimmed === "") continue;
    if (blockScalarFloor >= 0 && line.indent > blockScalarFloor) continue;
    blockScalarFloor = -1;
    // A multi-line quoted scalar folds deeper-indented lines into itself —
    // they are scalar content, not keys. The closer ends the continuation.
    if (quoteChar && line.indent > quoteFloor) {
      if (trimmed.includes(quoteChar)) quoteChar = null;
      continue;
    }
    quoteChar = null;
    if (COMMENT_RE.test(line.text) || DOC_MARKER_RE.test(line.text)) continue;

    // A line whose content begins a flow collection is flow content, not a
    // key/value pair — `- { a: b }` and multi-line `{...}` continuations.
    const content = line.text.replace(/^\s*(?:-\s+)?/, "");
    if (FLOW_VALUE_RE.test(content)) continue;
    // A sequence item that is itself a scalar (`- "text"`, `- text`) is not a
    // key/value pair either — quoted scalars skip via the first char.
    if (/^['"]/.test(content)) continue;

    const m = KEY_VALUE_RE.exec(content);
    if (!m) continue;
    const key = m[2]!;
    const value = m[3]!;
    if (BLOCK_SCALAR_RE.test(line.text)) {
      blockScalarFloor = line.indent;
      continue;
    }
    // Empty values (nested map start), quoted scalars, flow collections, and
    // anchor/alias/tag markers (&a1, *ref, !tag — the value node is elsewhere)
    // are unambiguous — no plain-scalar trap.
    if (!value || QUOTED_RE.test(value) || FLOW_VALUE_RE.test(value) || /^[&*!]/.test(value)) {
      continue;
    }
    // A value opening with a quote that does not close on this line starts a
    // multi-line quoted scalar — deeper lines fold into it until the closer.
    const opening = value[0];
    if ((opening === '"' || opening === "'") && value.lastIndexOf(opening) === 0) {
      quoteFloor = line.indent;
      quoteChar = opening;
      continue;
    }

    if (firstColonSpaceOutsideQuotes(value) !== -1) {
      traps.push({
        file: relPath,
        line: line.index,
        key,
        preview: `${key}: ${value}`.slice(0, 120),
      });
      continue;
    }

    // Silent shape: `key: scalar` followed by a deeper-indented `word: rest`
    // — the scalar ends and the continuation becomes a phantom mapping key.
    // Sequence items are exempt: `- key: v` + deeper `k2: v2` is a legal
    // two-key map inside the item.
    const next = lines[i + 1];
    if (
      next &&
      !SEQ_ITEM_RE.test(line.text) &&
      next.text.trim() !== "" &&
      !COMMENT_RE.test(next.text) &&
      next.indent > line.indent &&
      KEY_VALUE_RE.test(next.text)
    ) {
      traps.push({
        file: relPath,
        line: line.index,
        key,
        preview: `${key}: ${value} …`.slice(0, 120),
      });
    }
  }
  return traps;
}

function toDiagnostic(trap: ScalarTrap, severity: "error" | "warning"): Diagnostic {
  return {
    ruleId: "YAML-SCALAR-01",
    severity,
    file: trap.file,
    line: trap.line,
    message: `Unquoted plain scalar "${trap.preview}" carries a colon-space — YAML reinterprets it (nested map or parse error); quote the value.`,
    fixHint: `Quote the scalar in ${trap.file}:${trap.line} ("${trap.key}: \\"...\\"") or fold it into a block scalar.`,
  };
}

/**
 * Governance surfaces error; everything else warns under --all. --files is
 * error-tier: an ad-hoc check is deliberate. Mirrors the RFC-1478 severity
 * ladder consumed by the ecosystem.commit staged-YAML gate (always error).
 */
const GOVERNANCE_SURFACE_RE =
  /^(docs\/(rfcs|adrs|plans|audits|queues|reviews)\/|docs\/frictions\.yaml$|.*\.decisions\.yaml$)/;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "releases",
  "coverage",
  "templates",
  "tmp",
  "out",
  "missions",
  "onboarding",
  "scripts",
  "logs",
]);

/**
 * Mirrors yamlCandidateSkipped (RFC-0493) with RFC-1478 additions: machine-
 * emitted files (.generated.*), dot-segment trees (.index, .cache), mission
 * workpieces, and onboarding inputs are not authored YAML — the lint targets
 * files a human writes by hand.
 */
export function yamlScalarCandidateSkipped(relPath: string): boolean {
  if (
    relPath.includes("/templates/") ||
    relPath.includes(".template.") ||
    relPath.includes(".generated.")
  ) {
    return true;
  }
  return relPath
    .split("/")
    .some((seg) => SKIP_DIRS.has(seg) || seg.startsWith("-") || seg.startsWith("."));
}

async function collectCandidateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory) {
        if (!yamlScalarCandidateSkipped(`${rel}/`)) await walk(abs);
      } else if (/\.(ya?ml|md)$/.test(entry.name) && !yamlScalarCandidateSkipped(rel)) {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out;
}

export async function runYamlScalarsValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<YamlScalarsValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const filesFlag = input.flags?.["files"];
  const allFlag = input.flags?.["all"] === true;

  let relPaths: string[];
  if (typeof filesFlag === "string" && filesFlag.length > 0) {
    relPaths = filesFlag.split(",").map((p) => p.trim()).filter(Boolean);
  } else if (allFlag) {
    relPaths = await collectCandidateFiles(workspaceRoot);
  } else {
    const diagnostic: Diagnostic = {
      ruleId: "YAML-SCALAR-01",
      severity: "error",
      message: "Pass --files <glob list> or --all — no scan scope given.",
      fixHint: "Run yaml.scalars.validate --all for the workspace corpus.",
    };
    return {
      data: {
        command: "yaml.scalars.validate",
        status: "fail",
        filesScanned: 0,
        diagnostics: [diagnostic],
        summary: { error: 1, warning: 0, info: 0 },
      },
      exitCode: 1,
      summary: "[yaml.scalars.validate] no scan scope — pass --files or --all",
    };
  }

  const diagnostics: Diagnostic[] = [];
  let filesScanned = 0;
  const errorTier = typeof filesFlag === "string" && filesFlag.length > 0;
  for (const rel of relPaths) {
    if (yamlScalarCandidateSkipped(rel)) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspaceRoot, rel));
    } catch {
      continue;
    }
    filesScanned += 1;
    const severity = errorTier || GOVERNANCE_SURFACE_RE.test(rel) ? "error" : "warning";
    for (const trap of collectScalarTraps(rel, raw)) {
      diagnostics.push(toDiagnostic(trap, severity));
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const status = errors.length === 0 ? "pass" : "fail";

  if (outputFormat === "pretty") {
    logger.section("YAML scalar lint");
    logger.info(`  ${filesScanned} file(s) scanned`);
    for (const d of diagnostics) {
      const where = d.line !== undefined ? `${d.file}:${d.line}` : `${d.file}`;
      if (d.severity === "error") logger.error(`  ${d.ruleId} ${where}: ${d.message}`);
      else logger.warn(`  ${d.ruleId} ${where}: ${d.message}`);
    }
  }

  return {
    data: {
      command: "yaml.scalars.validate",
      status,
      filesScanned,
      diagnostics,
      summary: { error: errors.length, warning: warnings.length, info: 0 },
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `[yaml.scalars.validate] ${filesScanned} file(s) scanned — ${errors.length} colon-space trap error(s), ${warnings.length} warning(s)`,
  };
}
