/*
<MODULE_CONTRACT>
<purpose>RFC-1578: resolve the roots of the anchor chain — compass requirement
ids (the `<requirement id>` attributes of the compass document whose
`<document-id>` is `requirements`), DNA ids (`## DNA-N` headings of the
invariants file), and RFC acceptance-criterion / fixed-input refs
(`RFC-NNNN/AC-N`, `RFC-NNNN/FI-N`) searched in the RFC directory and its
`archive/**` subtree.</purpose>
<non-goals>
  <item>Do not impose an id pattern on requirement ids — the compass schema imposes none.</item>
  <item>Do not parse RFC frontmatter — only the criteria checklist and the fixed-inputs table.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial reference resolution for correctness.manifest.validate.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseFixedInputs } from "../rfc/handlers/fixed-inputs.ts";
import {
  evaluateAcceptanceCriteria,
  stripFencedCodeBlocks,
} from "../rfc/handlers/validate-rules.ts";

const DOCUMENT_ID_RE = /<document-id>\s*([^<\s]+)\s*<\/document-id>/;
const REQUIREMENT_ID_RE = /<requirement\b[^>]*?\bid\s*=\s*"([^"]+)"/g;
const DNA_HEADING_RE = /^##\s+DNA-(\d+)\b/gm;
const RFC_REF_RE = /^(RFC-\d{4})\/(AC|FI)-(\d+)$/;

export interface RequirementsDocument {
  /** Workspace-relative path, or null when no compass doc is the requirements document. */
  path: string | null;
  ids: string[];
}

function readText(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Find the compass requirements document among the bound compass docs and list its ids. */
export function readRequirementsDocument(
  workspaceRoot: string,
  compassDocs: string[],
): RequirementsDocument {
  for (const rel of compassDocs) {
    const text = readText(path.join(workspaceRoot, rel));
    if (text === null) continue;
    const docId = DOCUMENT_ID_RE.exec(text)?.[1];
    if (docId !== "requirements") continue;
    const ids: string[] = [];
    for (const m of text.matchAll(REQUIREMENT_ID_RE)) {
      if (!ids.includes(m[1]!)) ids.push(m[1]!);
    }
    return { path: rel, ids };
  }
  return { path: null, ids: [] };
}

/** DNA ids declared as `## DNA-N` headings in the invariants file (empty when unbound/absent). */
export function readDnaIds(workspaceRoot: string, invariantsFile: string | null): string[] {
  if (!invariantsFile) return [];
  const text = readText(path.join(workspaceRoot, invariantsFile));
  if (text === null) return [];
  const ids: string[] = [];
  for (const m of text.matchAll(DNA_HEADING_RE)) {
    const id = `DNA-${m[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function findRfcFile(dir: string, rfcId: string): string | null {
  if (!existsSync(dir)) return null;
  const prefix = `${rfcId.toLowerCase()}-`;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const abs = path.join(current, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Only the archive subtree is searched below the RFC directory root.
        if (current === dir && name !== "archive") continue;
        stack.push(abs);
      } else if (name.startsWith(prefix) && name.endsWith(".md")) {
        return abs;
      }
    }
  }
  return null;
}

export type RfcRefResolution = { ok: true; rfcFile: string } | { ok: false; reason: string };

/**
 * Resolve `RFC-NNNN/AC-N` or `RFC-NNNN/FI-N` against the RFC file under
 * `rfcsDir` (or `rfcsDir/archive/**`). `kind` restricts the accepted shape.
 */
export function resolveRfcRef(
  workspaceRoot: string,
  rfcsDir: string,
  ref: string,
  kind: "AC" | "FI",
): RfcRefResolution {
  const m = RFC_REF_RE.exec(ref);
  if (!m || m[2] !== kind) {
    return { ok: false, reason: `ref "${ref}" is not of the form RFC-NNNN/${kind}-N` };
  }
  const rfcId = m[1]!;
  const itemId = `${kind}-${m[3]}`;
  const file = findRfcFile(path.join(workspaceRoot, rfcsDir), rfcId);
  if (!file) return { ok: false, reason: `${rfcId} not found in ${rfcsDir} or ${rfcsDir}/archive` };
  const body = stripFencedCodeBlocks(readText(file) ?? "");
  const ids =
    kind === "AC"
      ? evaluateAcceptanceCriteria(body).criterionIds
      : parseFixedInputs(body).rows.map((r) => r.id);
  if (!ids.includes(itemId)) {
    return { ok: false, reason: `${rfcId} declares no ${itemId}` };
  }
  return { ok: true, rfcFile: path.relative(workspaceRoot, file).replace(/\\/g, "/") };
}
