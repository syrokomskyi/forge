/*
<MODULE_CONTRACT>
<purpose>Shared pure helpers for living feature specs — heading parsing, RFC-namespaced
section mechanics, spec (de)serialization, domain derivation, and the docs.archive
this-run merge-target selection (RFC-0711, RFC-0957, RFC-1230).</purpose>
<non-goals>
  <item>Do not implement command handlers — spec.live.merge/validate/rebuild handlers live in their own files.</item>
  <item>Do not touch the filesystem — these helpers are pure; IO stays in handlers.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1230: extracted shared helpers from live-spec-merge.ts; added removeNamespacedSections, seedSpecPrefix, and collectLiveMergeTargets for the idempotent-merge + rebuild design.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";
import { listRfcFiles } from "../rfc/frontmatter-io.ts";
import type {
  LivingSpec,
  DeltaOperation,
} from "./live-spec-types.ts";

export const LIVE_SPECS_DIR = "docs/specs/live";

export interface ParsedHeading {
  level: number;
  text: string;
  body: string;
}

export function extractDesignSection(rfcBody: string): string {
  const designMatch = rfcBody.match(/^##\s+Design\s*$/m);
  if (!designMatch) return "";
  const startIndex = designMatch.index! + designMatch[0].length;
  const nextH2Match = rfcBody.slice(startIndex).match(/^##\s+/m);
  if (!nextH2Match) {
    return rfcBody.slice(startIndex).trim();
  }
  return rfcBody.slice(startIndex, startIndex + nextH2Match.index!).trim();
}

export function parseHeadings(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const headings: ParsedHeading[] = [];
  let currentHeading: ParsedHeading | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{3,})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        currentHeading.body = currentBody.join("\n").trim();
        headings.push(currentHeading);
      }
      currentHeading = {
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
        body: "",
      };
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    currentHeading.body = currentBody.join("\n").trim();
    headings.push(currentHeading);
  }
  return headings;
}

export function deriveDomain(frontmatter: Record<string, unknown>): string | null {
  const liveSpec = frontmatter["liveSpec"];
  if (typeof liveSpec === "string" && liveSpec.length > 0) {
    return liveSpec;
  }
  if (liveSpec === true) {
    const packagesImpacted = frontmatter["packagesImpacted"];
    if (Array.isArray(packagesImpacted) && packagesImpacted.length > 0) {
      const firstPkg = String(packagesImpacted[0]);
      return firstPkg.replace(/^packages\//, "").replace(/^@[^/]+\//, "");
    }
    return null;
  }
  return null;
}

export function parseLivingSpec(content: string): LivingSpec | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  return {
    domain: String(fm["domain"] ?? ""),
    title: String(fm["title"] ?? ""),
    lastMergedRfc: String(fm["lastMergedRfc"] ?? ""),
    updatedAt: String(fm["updatedAt"] ?? ""),
    createdAt: String(fm["createdAt"] ?? ""),
    history: (Array.isArray(fm["history"]) ? fm["history"] : []) as LivingSpec["history"],
    body: match[2] ?? "",
  };
}

export function serializeLivingSpec(spec: LivingSpec): string {
  const fm: Record<string, unknown> = {
    domain: spec.domain,
    title: spec.title,
    lastMergedRfc: spec.lastMergedRfc,
    updatedAt: spec.updatedAt,
    createdAt: spec.createdAt,
    history: spec.history,
  };
  const fmStr = YAML.stringify(fm).trimEnd();
  return `---\n${fmStr}\n---\n\n${spec.body}`;
}

export function findHeadingInSpec(spec: LivingSpec, headingText: string): ParsedHeading | null {
  const headings = parseHeadings(spec.body);
  return headings.find((h) => h.text === headingText) ?? null;
}

export function applyDeltasToSpecBody(
  specBody: string,
  deltas: ParsedHeading[],
  operations: DeltaOperation[],
): string {
  let body = specBody;
  for (const delta of deltas) {
    const op = operations.find((o) => o.heading === delta.text);
    if (!op) continue;

    if (op.type === "added") {
      body = `${body}\n\n${"#".repeat(delta.level)} ${delta.text}\n\n${delta.body}`;
    } else if (op.type === "modified") {
      const headingRegex = new RegExp(
        `(${"#".repeat(delta.level)}\\s+${escapeRegex(delta.text)}\\s*\\n)([\\s\\S]*?)(?=#{3,}|$)`,
      );
      body = body.replace(headingRegex, `$1\n${delta.body}\n`);
    } else if (op.type === "removed") {
      const headingRegex = new RegExp(
        `\\n*${"#".repeat(delta.level)}\\s+${escapeRegex(delta.text)}\\s*\\n[\\s\\S]*?(?=#{3,}|$)`,
      );
      body = body.replace(headingRegex, "\n");
    }
  }
  return body.trim();
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namespaceHeadings(content: string, rfcId: string): string {
  return content.replace(/^(#{3,})\s+(.+)$/gm, (_match, hashes: string, text: string) => {
    // parseHeadings trims heading text — normalize here too so a heading like
    // "### Foo " round-trips to "### Foo (RFC-XXXX)", not "### Foo  (RFC-XXXX)".
    const normalized = text.trim();
    if (/\(RFC-\d{4}\)$/.test(normalized)) return `${hashes} ${normalized}`;
    return `${hashes} ${normalized} (${rfcId})`;
  });
}

// RFC-1230: strip every ###+ section whose heading carries the ` (RFC-XXXX)`
// marker. Line-based and byte-preserving for kept sections — parseHeadings is
// lossy on whitespace, so surgical replacement filters lines instead.
export function removeNamespacedSections(body: string, rfcId: string): string {
  const suffix = ` (${rfcId})`;
  const lines = body.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{3,})\s+(.+)$/);
    if (headingMatch) {
      skipping = headingMatch[2].trim().endsWith(suffix);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function findRfcFile(rfcDir: string, rfcId: string): Promise<string | null> {
  return (async () => {
    const files = await listRfcFiles(rfcDir);
    for (const file of files) {
      const basename = path.basename(file);
      if (basename.toLowerCase().startsWith(rfcId.toLowerCase())) {
        return file;
      }
    }
    return null;
  })();
}

// Canonical spec seed — identical to what the spec.live.merge creation path
// emits, so rebuild and first-merge produce the same skeleton.
export function seedSpecPrefix(domain: string, generatedHeader: string): string {
  return `${generatedHeader}# Living Spec: ${domain}\n\n## Overview\n\n`;
}

export interface LiveMergeTargetSelection {
  // RFCs moved into archive/implemented/ this run — merge candidates (still
  // gated on a liveSpec frontmatter check by the caller).
  candidates: string[];
  // RFCs moved into archive/rejected/ this run — counted as skipped when they
  // carry liveSpec (a rejected RFC must never merge).
  rejected: string[];
}

// RFC-1230: the docs.archive post-loop merges only RFCs moved this run — the
// selection derives from rfc.archive's `moved` result, not a rescan of the
// whole docs/rfcs tree (which is what caused the duplicate-merge corruption).
export function collectLiveMergeTargets(
  moved: ReadonlyArray<{ id: string; status: string; direction: string }>,
): LiveMergeTargetSelection {
  const candidates: string[] = [];
  const rejected: string[] = [];
  for (const m of moved) {
    if (m.direction !== "into-archive") continue;
    if (m.status === "implemented") candidates.push(m.id);
    else if (m.status === "rejected") rejected.push(m.id);
  }
  return { candidates, rejected };
}
