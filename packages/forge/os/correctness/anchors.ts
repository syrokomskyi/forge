/*
<MODULE_CONTRACT>
<purpose>RFC-1578: the anchor index — every tagged `@ai-invariant[INV-…]`
in the workspace with its normalized statement and `checked-by` binding refs.
Uses `docs/invariants.generated.yaml` (RFC-1390) as a hint: every anchor the
manifest names is re-verified by parsing its recorded file; any miss (absent
id, moved or deleted file, changed binding) falls back to a full scan of code
files with the forge RFC-1390 parser.</purpose>
<non-goals>
  <item>Do not parse `@ai-invariant` markers here — `src/compass/invariant-parser.ts` is the only parser.</item>
  <item>Do not resolve whether a binding target exists — compass.validate owns binding resolution.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial anchor index for CORR-04/CORR-05.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-09 findings

N1 index-hint rows count only for files in the workspace listing; N2 forge create leaves exempt repositories unbound; N3 listing test stages a file. Record DEV-3/DEV-4 amendments (CORR-07 future/escaping captures, index as re-verified hint) in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
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

/**
 * Code files only. Markdown/HTML are excluded on purpose: a `// @ai-invariant`
 * line inside a documentation code fence is an example, not a code anchor, and
 * would otherwise satisfy CORR-04/CORR-05 without any code site.
 */
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|astro|svelte|vue|gd|py|rs|go|sh|css|scss)$/;

export function isAnchorSourceCandidate(rel: string): boolean {
  if (rel === INVARIANT_INDEX_REL) return false;
  if (rel.endsWith(".generated.yaml") || rel.endsWith(".generated.md")) return false;
  return SOURCE_EXT_RE.test(rel);
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

function parseFile(workspaceRoot: string, rel: string): AnchorRecord[] | null {
  let text: string;
  try {
    text = readFileSync(path.join(workspaceRoot, rel), "utf8");
  } catch {
    return null;
  }
  if (!text.includes("@ai-invariant[")) return [];
  return anchorsFromSource(rel, text);
}

function group(records: AnchorRecord[]): Map<string, AnchorRecord[]> {
  const anchors = new Map<string, AnchorRecord[]>();
  for (const r of records) {
    const list = anchors.get(r.id) ?? [];
    list.push(r);
    anchors.set(r.id, list);
  }
  return anchors;
}

/**
 * Resolve the anchors a manifest names. The generated index is a hint only:
 * each named id is re-parsed from the file the index records, and the result
 * is used only when every named id is found there as a code anchor. Any miss
 * falls back to scanning every code file in `files`.
 */
export function buildAnchorIndex(
  workspaceRoot: string,
  files: string[],
  named: string[],
): AnchorIndex {
  const wanted = [...new Set(named)];
  const hint = fromIndex(workspaceRoot);
  if (hint !== null && wanted.length > 0) {
    // Only files the scan would read count — an index row naming an ignored
    // or untracked-ignored file must not satisfy CORR-04 in index mode.
    const listed = new Set(files);
    const fileOf = new Map<string, Set<string>>();
    for (const r of hint) {
      if (!wanted.includes(r.id) || !isAnchorSourceCandidate(r.file) || !listed.has(r.file))
        continue;
      const set = fileOf.get(r.id) ?? new Set<string>();
      set.add(r.file);
      fileOf.set(r.id, set);
    }
    if (wanted.every((id) => fileOf.has(id))) {
      const parsed = new Map<string, AnchorRecord[]>();
      const records: AnchorRecord[] = [];
      let complete = true;
      for (const id of wanted) {
        let found = false;
        for (const rel of fileOf.get(id)!) {
          if (!parsed.has(rel)) parsed.set(rel, parseFile(workspaceRoot, rel) ?? []);
          const hits = parsed.get(rel)!.filter((r) => r.id === id);
          if (hits.length > 0) {
            found = true;
            records.push(...hits);
          }
        }
        if (!found) {
          complete = false;
          break;
        }
      }
      if (complete) return { source: "index", anchors: group(records) };
    }
  }
  const records: AnchorRecord[] = [];
  for (const rel of files.filter(isAnchorSourceCandidate)) {
    records.push(...(parseFile(workspaceRoot, rel) ?? []));
  }
  return { source: "scan", anchors: group(records) };
}
