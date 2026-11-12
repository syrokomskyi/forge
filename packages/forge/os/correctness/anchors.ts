/*
<MODULE_CONTRACT>
<purpose>RFC-1578: the anchor index — every tagged `@ai-invariant[INV-…]`
in the workspace with its normalized statement and `checked-by` binding refs.
Reads `docs/invariants.generated.yaml` (RFC-1390) when it is fresh (not older
than any scanned candidate source file) and otherwise scans source files with
the forge RFC-1390 parser.</purpose>
<non-goals>
  <item>Do not parse `@ai-invariant` markers here — `src/compass/invariant-parser.ts` is the only parser.</item>
  <item>Do not resolve whether a binding target exists — compass.validate owns binding resolution.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial anchor index for CORR-04/CORR-05.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { extractInvariants } from "../../src/compass/invariant-parser.ts";
import { normalizeCheckRef } from "./workspace.ts";

export interface AnchorRecord {
  id: string;
  file: string;
  line: number;
  statement: string;
  /** Normalized `kind:target` refs from the `checked-by` binding. */
  checkedBy: string[];
}

export const INVARIANT_INDEX_REL = "docs/invariants.generated.yaml";

/** Source files the RFC-1390 parser understands (comment syntaxes it tracks). */
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|astro|svelte|vue|gd|py|rs|go|sh|md|mdx|html|css|scss)$/;

export function isAnchorSourceCandidate(rel: string): boolean {
  if (rel === INVARIANT_INDEX_REL) return false;
  if (rel.endsWith(".generated.yaml") || rel.endsWith(".generated.md")) return false;
  return SOURCE_EXT_RE.test(rel);
}

function mtimeMs(abs: string): number | null {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return null;
  }
}

function fromIndex(workspaceRoot: string): AnchorRecord[] | null {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path.join(workspaceRoot, INVARIANT_INDEX_REL), "utf8"));
  } catch {
    return null;
  }
  const list = (raw as { invariants?: unknown })?.invariants;
  if (!Array.isArray(list)) return null;
  const out: AnchorRecord[] = [];
  for (const item of list) {
    const inv = item as {
      id?: unknown;
      file?: unknown;
      line?: unknown;
      statement?: unknown;
      bindings?: { kind?: unknown; target?: unknown }[];
    };
    if (typeof inv.id !== "string") continue;
    out.push({
      id: inv.id,
      file: String(inv.file ?? ""),
      line: Number(inv.line ?? 0),
      statement: String(inv.statement ?? ""),
      checkedBy: (inv.bindings ?? []).map((b) =>
        normalizeCheckRef(`${String(b.kind ?? "")}:${String(b.target ?? "")}`),
      ),
    });
  }
  return out;
}

/** Parse one source text into anchor records (tagged invariants only). */
export function anchorsFromSource(file: string, source: string): AnchorRecord[] {
  return extractInvariants(source)
    .filter((inv) => inv.id !== null)
    .map((inv) => ({
      id: inv.id!,
      file,
      line: inv.line,
      statement: inv.statement,
      checkedBy: inv.rawBindings.map((b) => normalizeCheckRef(`${b.kind}:${b.target}`)),
    }));
}

export interface AnchorIndex {
  source: "index" | "scan";
  anchors: Map<string, AnchorRecord[]>;
}

/** Build the anchor index from the fresh generated index, or by scanning `files`. */
export function buildAnchorIndex(workspaceRoot: string, files: string[]): AnchorIndex {
  const candidates = files.filter(isAnchorSourceCandidate);
  const indexMtime = mtimeMs(path.join(workspaceRoot, INVARIANT_INDEX_REL));
  let records: AnchorRecord[] | null = null;
  let source: AnchorIndex["source"] = "scan";
  if (indexMtime !== null) {
    const stale = candidates.some((rel) => {
      const m = mtimeMs(path.join(workspaceRoot, rel));
      return m !== null && m > indexMtime;
    });
    if (!stale) {
      records = fromIndex(workspaceRoot);
      if (records !== null) source = "index";
    }
  }
  if (records === null) {
    records = [];
    for (const rel of candidates) {
      let text: string;
      try {
        text = readFileSync(path.join(workspaceRoot, rel), "utf8");
      } catch {
        continue;
      }
      if (!text.includes("@ai-invariant[")) continue;
      records.push(...anchorsFromSource(rel, text));
    }
  }
  const anchors = new Map<string, AnchorRecord[]>();
  for (const r of records) {
    const list = anchors.get(r.id) ?? [];
    list.push(r);
    anchors.set(r.id, list);
  }
  return { source, anchors };
}
