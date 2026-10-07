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
  <item>RFC-1232: fence-aware heading mechanics — private fencedLineIndexes (CommonMark-subset ``` / ~~~ map) consumed by parseHeadings, extractDesignSection, namespaceHeadings, removeNamespacedSections, and applyDeltasToSpecBody (regex lookaheads replaced with line-slice boundaries).</item>
  <item>RFC-1235: extracted docs.archive merge-outcome accounting — classifyLiveMergeOutcome, liveMergeFailureEntry, formatLiveMergeFailure, buildLiveMergeBlock — so exit-nonzero merges record to failed[] instead of merged[].</item>
  <item>RFC-1235: record failed live-spec merges in docs.archive results (RFC-1235)

The post-loop pushed mergeData into merged[] without checking mergeResult.exitCode — an exit-1-with-data merge (RFC-1230 fail-fast on corrupt spec frontmatter) was reported as merged. Outcome recording is extracted to live-spec-shared.ts (classifyLiveMergeOutcome / liveMergeFailureEntry / formatLiveMergeFailure / buildLiveMergeBlock): exit-nonzero and thrown merges land in failed[] with the reason, the spec.live.merge block emits whenever anything was attempted, and the top-level result gains liveSpecFailures. Archive stays non-fatal — failed[] is data, V-LS-08 reports the coverage gap.</item>
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

// RFC-1232: CommonMark-subset fence map — line indexes inside fenced code
// blocks. A run of ` or ~ of length >=3 with <=3 leading spaces opens a fence;
// the same-or-longer run of the same character closes it. Opener and closer
// lines count as interior. An unterminated fence makes the rest of the input
// interior (CommonMark behavior). Indented code blocks are out of scope.
const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})/;
// CommonMark: a closing fence carries no info string — only trailing
// whitespace. A same-char run followed by text is interior content, so the
// map over-masks rather than exposing a would-be heading (safe direction).
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
function fencedLineIndexes(lines: string[]): ReadonlySet<number> {
  const inside = new Set<number>();
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(FENCE_OPEN_REGEX);
    if (fenceChar === null) {
      if (match) {
        fenceChar = match[1]![0] as "`" | "~";
        fenceLength = match[1]!.length;
        inside.add(i);
      }
      continue;
    }
    inside.add(i);
    const closeMatch = lines[i]!.match(FENCE_CLOSE_REGEX);
    if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLength) {
      fenceChar = null;
      fenceLength = 0;
    }
  }
  return inside;
}

export function extractDesignSection(rfcBody: string): string {
  const lines = rfcBody.split("\n");
  const fenced = fencedLineIndexes(lines);
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && /^##\s+Design\s*$/.test(lines[i]!)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return "";
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (!fenced.has(i) && /^##\s/.test(lines[i]!)) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine + 1, endLine).join("\n").trim();
}

export function parseHeadings(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const fenced = fencedLineIndexes(lines);
  const headings: ParsedHeading[] = [];
  let currentHeading: ParsedHeading | null = null;
  let currentBody: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = fenced.has(i) ? null : line.match(/^(#{3,})\s+(.+)$/);
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
  const lines = specBody.split("\n");
  for (const delta of deltas) {
    const op = operations.find((o) => o.heading === delta.text);
    if (!op) continue;

    if (op.type === "added") {
      lines.push("", `${"#".repeat(delta.level)} ${delta.text}`, "", ...delta.body.split("\n"));
      continue;
    }

    // RFC-1232: line-slice boundaries instead of `(?=#{3,}|$)` regex lookaheads —
    // those were unanchored and matched `###` inside fenced code blocks.
    const fenced = fencedLineIndexes(lines);
    let start = -1;
    let next = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (fenced.has(i)) continue;
      const m = lines[i]!.match(/^(#{3,})\s+(.+)$/);
      if (!m) continue;
      if (start === -1) {
        if (m[1]!.length === delta.level && m[2]!.trim() === delta.text) start = i;
      } else {
        next = i;
        break;
      }
    }
    if (start === -1) continue;

    if (op.type === "modified") {
      lines.splice(start + 1, next - start - 1, "", ...delta.body.split("\n"));
    } else {
      // removed — absorb the blank lines separating the heading from the
      // preceding content (old `\n*` regex prefix), then collapse the section
      // to a single empty line.
      let removeFrom = start;
      while (removeFrom > 0 && lines[removeFrom - 1]!.trim() === "") removeFrom--;
      lines.splice(removeFrom, next - removeFrom, "");
    }
  }
  return lines.join("\n").trim();
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namespaceHeadings(content: string, rfcId: string): string {
  const lines = content.split("\n");
  const fenced = fencedLineIndexes(lines);
  return lines
    .map((line, i) => {
      if (fenced.has(i)) return line;
      const m = line.match(/^(#{3,})\s+(.+)$/);
      if (!m) return line;
      // parseHeadings trims heading text — normalize here too so a heading like
      // "### Foo " round-trips to "### Foo (RFC-XXXX)", not "### Foo  (RFC-XXXX)".
      const normalized = m[2]!.trim();
      if (/\(RFC-\d{4}\)$/.test(normalized)) return `${m[1]} ${normalized}`;
      return `${m[1]} ${normalized} (${rfcId})`;
    })
    .join("\n");
}

// RFC-1230: strip every ###+ section whose heading carries the ` (RFC-XXXX)`
// marker. Line-based and byte-preserving for kept sections — parseHeadings is
// lossy on whitespace, so surgical replacement filters lines instead.
export function removeNamespacedSections(body: string, rfcId: string): string {
  const suffix = ` (${rfcId})`;
  const lines = body.split("\n");
  const fenced = fencedLineIndexes(lines);
  const out: string[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = fenced.has(i) ? null : line.match(/^(#{3,})\s+(.+)$/);
    if (headingMatch) {
      skipping = headingMatch[2]!.trim().endsWith(suffix);
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

// ── RFC-1235: docs.archive post-loop merge-outcome accounting ────────────────
// spec.live.merge can return exitCode !== 0 with a populated data object
// (RFC-1230 fail-fast on corrupt spec frontmatter) — the post-loop must record
// those distinctly instead of inflating merged[]. Helper-local shapes only;
// spec.live.merge's own result contract is untouched.

export interface LiveMergeEntry {
  id: string;
  domain: string;
  operation: string;
  conflicts: number;
}

export interface LiveMergeFailure {
  id: string;
  exitCode?: number;
  error: string;
}

export type LiveMergeOutcome =
  | { kind: "merged"; entry: LiveMergeEntry }
  | { kind: "failed"; entry: LiveMergeFailure };

export function classifyLiveMergeOutcome(
  rfcId: string,
  result: { exitCode: number; data?: unknown; summary?: string },
): LiveMergeOutcome {
  const data = result.data as
    | { domain?: unknown; operation?: unknown; conflicts?: unknown }
    | undefined;
  if (result.exitCode === 0 && data) {
    return {
      kind: "merged",
      entry: {
        id: rfcId,
        domain: String(data.domain ?? ""),
        operation: String(data.operation ?? ""),
        conflicts: Array.isArray(data.conflicts) ? data.conflicts.length : 0,
      },
    };
  }
  return {
    kind: "failed",
    entry: {
      id: rfcId,
      exitCode: result.exitCode,
      error: result.summary ?? `spec.live.merge exited ${result.exitCode}`,
    },
  };
}

export function liveMergeFailureEntry(rfcId: string, error: unknown): LiveMergeFailure {
  return { id: rfcId, error: String(error instanceof Error ? error.message : error) };
}

export function formatLiveMergeFailure(entry: LiveMergeFailure): string {
  return `spec.live.merge: failed for ${entry.id}: ${entry.error}`;
}

/** Emission gate + block assembly for results["spec.live.merge"] — undefined
 * when nothing was attempted, so an all-failed run still surfaces. */
export function buildLiveMergeBlock(
  merged: LiveMergeEntry[],
  failed: LiveMergeFailure[],
  skipped: number,
  dryRun: boolean,
): { merged: LiveMergeEntry[]; failed: LiveMergeFailure[]; skipped: number; dryRun: boolean } | undefined {
  if (merged.length === 0 && failed.length === 0 && skipped === 0) return undefined;
  return { merged, failed, skipped, dryRun };
}
