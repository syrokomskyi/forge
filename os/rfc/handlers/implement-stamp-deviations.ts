/*
<MODULE_CONTRACT>
<purpose>
RFC-1454: RFC-IMP-15 deviation gate — a review report's `amend` design
deviation must be recorded in the stamped RFC's `## Deviations` section.
Committed review reports (`<reviewsDir>/code/**` via `git ls-tree HEAD`)
are scanned for frontmatter `designDeviations[]`; a deviation applies to
the RFC when its `rfc` field matches, or when `rfc` is absent and the
report's `rfcId` matches. Malformed records (missing id/resolution,
unknown resolution) block — a corrupt record grants nothing. V-49
reuses the same committed-report index to resolve `(review <id>)`
provenance in `## Deviations` entries.
</purpose>
<non-goals>
  <item>Does not classify deviations — fo-review authors them; the gate enforces bookkeeping only.</item>
  <item>Does not read uncommitted reports — only files committed at HEAD count.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1454: deviation gate — committed-review index, RFC-IMP-15, deviations-section parser for V-49.</item>
  <item>RFC-1454: review deviations recorded in the RFC — IMP-15 gate, V-49 provenance, skill contract</item>
</CHANGE_SUMMARY>
*/

import { parse as yamlParse } from "yaml";
import type { OriginGit } from "../verification-origin.ts";

export interface ReviewDeviation {
  id?: string;
  rfc?: string;
  summary?: string;
  resolution?: string;
}

export interface CommittedReview {
  path: string;
  reviewId: string;
  rfcId?: string;
  deviations: ReviewDeviation[];
}

const DEVIATION_ENTRY_PATTERN = /^-\s+([A-Za-z0-9._-]+)\s+\(review\s+([A-Za-z0-9._-]+)\)\s*:/;
const DEVIATIONS_HEADING = /^## Deviations\s*$/m;
const RESOLUTIONS = new Set(["fix", "amend"]);

function frontmatterOf(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const parsed = yamlParse(match[1]!) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function deviationList(fm: Record<string, unknown>): ReviewDeviation[] {
  const raw = fm["designDeviations"];
  return Array.isArray(raw) ? (raw as ReviewDeviation[]) : [];
}

/**
 * Committed review reports under `<reviewsDir>/code` at HEAD —
 * index-only (reviewId, rfcId, designDeviations) per report.
 */
export async function collectCommittedReviews(
  git: OriginGit,
  reviewsDir: string | null,
): Promise<CommittedReview[]> {
  if (!reviewsDir) return [];
  const listed = await git.run(["ls-tree", "-r", "--name-only", "HEAD", "--", `${reviewsDir}/code`]);
  const paths = (listed ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p.endsWith(".md"));
  const reviews: CommittedReview[] = [];
  for (const path of paths) {
    const content = await git.run(["show", `HEAD:${path}`]);
    if (content === null) continue;
    const fm = frontmatterOf(content);
    if (!fm) continue;
    const reviewId = typeof fm["reviewId"] === "string" ? fm["reviewId"] : "";
    if (!reviewId) continue;
    reviews.push({
      path,
      reviewId,
      rfcId: typeof fm["rfcId"] === "string" ? fm["rfcId"] : undefined,
      deviations: deviationList(fm),
    });
  }
  return reviews;
}

/**
 * `(id, reviewId)` pairs from the RFC's `## Deviations` section.
 * `strippedBody` must already be fence-stripped (the fenced grammar
 * example is documentation, not an entry). List lines in the section
 * that do not match the entry grammar surface via `malformed`.
 */
export function parseDeviationsSection(strippedBody: string): {
  entries: Array<{ id: string; reviewId: string }>;
  malformed: string[];
} {
  const match = strippedBody.match(DEVIATIONS_HEADING);
  if (!match || match.index === undefined) return { entries: [], malformed: [] };
  const rest = strippedBody.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);

  const entries: Array<{ id: string; reviewId: string }> = [];
  const malformed: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const m = trimmed.match(DEVIATION_ENTRY_PATTERN);
    if (m) entries.push({ id: m[1]!, reviewId: m[2]! });
    else malformed.push(trimmed);
  }
  return { entries, malformed };
}

export interface DeviationGateInput {
  rfcId: string;
  /** RFC body with fenced code blocks already stripped by the caller. */
  strippedRfcBody: string;
  git: OriginGit;
  /** `bindings.paths.reviewsDir` — null means no committed reports can exist. */
  reviewsDir: string | null;
}

export interface DeviationGateResult {
  errors: Array<{ rule: "RFC-IMP-15"; message: string }>;
}

export async function evaluateDeviationGate(
  input: DeviationGateInput,
): Promise<DeviationGateResult> {
  const errors: DeviationGateResult["errors"] = [];
  if (!input.reviewsDir) return { errors };

  const reviews = await collectCommittedReviews(input.git, input.reviewsDir);
  const bound = reviews.filter(
    (r) => r.rfcId === input.rfcId || r.deviations.some((d) => d.rfc === input.rfcId),
  );
  if (bound.length === 0) return { errors };

  const { entries } = parseDeviationsSection(input.strippedRfcBody);
  const recorded = new Set(entries.map((e) => `${e.id}::${e.reviewId}`));

  for (const review of bound) {
    for (const dev of review.deviations) {
      const applies = dev.rfc === input.rfcId || (dev.rfc === undefined && review.rfcId === input.rfcId);
      if (!applies) continue;
      if (
        typeof dev.id !== "string" ||
        dev.id.trim() === "" ||
        typeof dev.resolution !== "string" ||
        !RESOLUTIONS.has(dev.resolution)
      ) {
        errors.push({
          rule: "RFC-IMP-15",
          message:
            `${input.rfcId}: review ${review.reviewId} (${review.path}) carries a malformed designDeviations ` +
            `entry (id + resolution ∈ {fix, amend} required) — a corrupt record grants nothing (RFC-1454).`,
        });
        continue;
      }
      if (dev.resolution !== "amend") continue;
      if (!recorded.has(`${dev.id}::${review.reviewId}`)) {
        errors.push({
          rule: "RFC-IMP-15",
          message:
            `${input.rfcId}: review ${review.reviewId} (${review.path}) records amend deviation ${dev.id} ` +
            `absent from "## Deviations" — add "- ${dev.id} (review ${review.reviewId}): <what changed>" ` +
            `and edit the affected criterion/probe in the same change (RFC-1454).`,
        });
      }
    }
  }
  return { errors };
}
