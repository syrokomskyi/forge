/*
<MODULE_CONTRACT>
<purpose>Per-RFC validation rules (V-01..V-32) extracted from the validate handler for modularity.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303 Phase 3: extracted from validate.ts as part of the handler split.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

import { parse as yamlParse } from "yaml";
import { validateAcceptanceShape } from "../acceptance.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import type { RfcStatus, RfcKind, RfcScope, RfcValidationViolation, Marker } from "../types.ts";
import {
  RFC_DIR,
  RFC_ID_PATTERN,
  RFC_STATUSES,
  RFC_KINDS,
  RFC_SCOPES,
  RFC_FULL_REQUIRED_SECTIONS,
  RFC_KNOWN_KEYS,
  RFC_METADATA_CUTOFF,
  RFC_VERSION_BUMP_CUTOFF,
} from "../types.ts";
import { DNA_DOCS, AP_DOCS } from "./shared.ts";

const DNA_DOC = DNA_DOCS[0]!;
const AP_DOC = AP_DOCS[0]!;

// RFC-0335: reviewer identity validation constants
const REVIEWER_IDENTITY_PATTERN = /^(human|agent):[a-z0-9][a-z0-9-]*$/;
const DECIDED_STATUSES: readonly RfcStatus[] = [
  "accepted",
  "implemented",
  "rejected",
  "superseded",
];

export type AddViolationFn = (
  rfcId: string,
  file: string,
  rule: string,
  message: string,
  severity?: "error" | "warning",
) => void;

// ─── RFC-0476: reusable acceptance-criteria evaluation ──────────────────────
// Extracted from V-26/V-27 inline logic so the stamp command and validation
// share a single criterion-evaluation source.

export interface AcceptanceCriteriaEvaluation {
  totalChecked: number;
  totalUnchecked: number;
  uncheckedLines: string[];
  checkedWithoutEvidence: string[];
}

/**
 * Extract the raw acceptance-criteria section text from an RFC body.
 * Returns `undefined` when the section is absent.
 */
export function extractAcceptanceCriteriaSection(body: string): string | undefined {
  const match = body.match(/## Acceptance criteria\s*\n([\s\S]*?)(?=\n## |\n*$)/);
  return match?.[1];
}

/**
 * Evaluate acceptance criteria checkboxes and inline evidence annotations.
 * Pure function — no I/O, no side effects. Used by both V-26/V-27 validation
 * and the `rfc.implement.stamp` precondition checks (RFC-0476).
 */
export function evaluateAcceptanceCriteria(body: string): AcceptanceCriteriaEvaluation {
  const section = extractAcceptanceCriteriaSection(body);
  if (!section) {
    return {
      totalChecked: 0,
      totalUnchecked: 0,
      uncheckedLines: [],
      checkedWithoutEvidence: [],
    };
  }

  const uncheckedLines = section
    .split("\n")
    .filter((line) => /^- \[ \]/.test(line))
    .map((line) => line.trim());
  const totalUnchecked = uncheckedLines.length;

  const checkedLines = section.split("\n").filter((line) => /^- \[x\]/.test(line));
  const checkedWithoutEvidence: string[] = [];
  for (const line of checkedLines) {
    if (!/\(evidence:\s*.+\)/.test(line)) {
      checkedWithoutEvidence.push(line.trim());
    }
  }

  return {
    totalChecked: checkedLines.length,
    totalUnchecked,
    uncheckedLines,
    checkedWithoutEvidence,
  };
}

// ─── RFC-0625: V-32 implementation commit drift detection ──────────────────

function execGitLog(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workspaceRoot, timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function checkImplementationCommitDrift(
  workspaceRoot: string,
  rfcId: string,
  createdAt: string,
  currentStatus: string,
): Promise<{ found: boolean; commitCount: number }> {
  if (currentStatus === "implemented") {
    return { found: false, commitCount: 0 };
  }

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(createdAt)) {
    return { found: false, commitCount: 0 };
  }

  const log = await execGitLog(workspaceRoot, ["log", `--since=${createdAt}`, "--oneline"]);

  if (!log) {
    return { found: false, commitCount: 0 };
  }

  const pattern = new RegExp(`implement:\\s+${rfcId}\\b`, "i");
  const matchingLines = log.split("\n").filter((line) => pattern.test(line.trim()));

  return { found: matchingLines.length > 0, commitCount: matchingLines.length };
}

// ─── RFC-0709: V-NC-01 NEEDS CLARIFICATION marker detection ────────────────

const NC_MARKER_CUTOFF = "2026-08-06";
const NC_MARKER_PATTERN = /^>\s*NEEDS CLARIFICATION:\s*(.+)$/;

/**
 * Collect NEEDS CLARIFICATION markers from an RFC body.
 * Skips lines inside fenced code blocks. Pure function — no I/O.
 */
export function collectMarkers(body: string, status: string, createdAt: string): Marker[] {
  if (createdAt < NC_MARKER_CUTOFF) return [];

  const severity: Marker["severity"] = status === "draft" ? "warn" : "error";
  const markers: Marker[] = [];
  const lines = body.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(NC_MARKER_PATTERN);
    if (match) {
      markers.push({
        line: i + 1,
        text: match[1]!.trim(),
        severity,
      });
    }
  }

  return markers;
}

export async function validateSingleRfc(
  fileName: string,
  parsed: ParsedRfc,
  allParsed: Map<string, { fileName: string; parsed: ParsedRfc }>,
  seenIds: Map<string, string>,
  validDnaIds: Set<number>,
  validApIds: Set<number>,
  knownKeys: Set<string>,
  workspaceRoot: string,
  addViolation: AddViolationFn,
  seenFilenameNumbers?: Map<number, string>,
): Promise<Marker[]> {
  const fm = parsed.frontmatter;
  const body = parsed.body;
  const relFile = path.join(RFC_DIR, fileName);
  const rfcId = String(fm["id"] ?? "UNKNOWN");

  // V-01: id format
  if (!RFC_ID_PATTERN.test(rfcId)) {
    addViolation(rfcId, relFile, "V-01", `id "${rfcId}" does not match format RFC-XXXX`);
  }

  // RFC-DIR-01: directory structure convention (RFC-0722)
  // Warn when RFC files are found in subdirectories other than archive/ and verification/
  const slashIdx = fileName.indexOf("/");
  if (slashIdx > 0) {
    const subDir = fileName.slice(0, slashIdx);
    if (subDir !== "archive" && subDir !== "verification") {
      addViolation(
        rfcId,
        relFile,
        "RFC-DIR-01",
        `${relFile} is in an unsanctioned subdirectory. Only archive/ and verification/ are allowed. Move the file to docs/rfcs/ root or write an ADR to formalize the subdirectory.`,
        "warning",
      );
    }
  }

  // V-02: id uniqueness
  const prevFile = seenIds.get(rfcId);
  if (prevFile) {
    addViolation(
      rfcId,
      relFile,
      "V-02",
      `Duplicate id "${rfcId}" — also in ${prevFile}. ` +
        `This happens when an RFC is created by scanning only the top-level docs/rfcs/ directory, missing archived RFCs under docs/rfcs/archive/. ` +
        `Fix: renumber this RFC by deleting it and re-running rfc.create (or spec.materialize) which scans the full tree recursively.`,
    );
  } else {
    seenIds.set(rfcId, relFile);
  }

  // V-03: valid status
  const status = String(fm["status"] ?? "");
  if (!RFC_STATUSES.includes(status as RfcStatus)) {
    addViolation(
      rfcId,
      relFile,
      "V-03",
      `Invalid status "${status}". Must be one of: ${RFC_STATUSES.join(", ")}`,
    );
  }

  // V-04: valid kind
  const kind = String(fm["kind"] ?? "");
  if (!RFC_KINDS.includes(kind as RfcKind)) {
    addViolation(
      rfcId,
      relFile,
      "V-04",
      `Invalid kind "${kind}". Must be one of: ${RFC_KINDS.join(", ")}`,
    );
  }

  // V-05: valid scope
  const scope = String(fm["scope"] ?? "");
  if (!RFC_SCOPES.includes(scope as RfcScope)) {
    addViolation(
      rfcId,
      relFile,
      "V-05",
      `Invalid scope "${scope}". Must be one of: ${RFC_SCOPES.join(", ")}`,
    );
  }

  // V-06: owners non-empty
  const owners = fm["owners"];
  if (!Array.isArray(owners) || owners.length === 0) {
    addViolation(rfcId, relFile, "V-06", "owners must be a non-empty array");
  }

  // V-07: valid dates
  const createdAt = String(fm["createdAt"] ?? "");
  const updatedAt = String(fm["updatedAt"] ?? "");
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(createdAt)) {
    addViolation(
      rfcId,
      relFile,
      "V-07",
      `createdAt "${createdAt}" is not a valid ISO 8601 date (YYYY-MM-DD)`,
    );
  }
  if (!datePattern.test(updatedAt)) {
    addViolation(
      rfcId,
      relFile,
      "V-07",
      `updatedAt "${updatedAt}" is not a valid ISO 8601 date (YYYY-MM-DD)`,
    );
  }
  const enhancedAt = fm["enhancedAt"] as string | undefined;
  if (enhancedAt && !datePattern.test(enhancedAt)) {
    addViolation(
      rfcId,
      relFile,
      "V-07",
      `enhancedAt "${enhancedAt}" is not a valid ISO 8601 date (YYYY-MM-DD)`,
    );
  }

  // V-08: implementedAt >= createdAt
  const implementedAt = fm["implementedAt"] as string | undefined;
  if (implementedAt && datePattern.test(implementedAt) && datePattern.test(createdAt)) {
    if (implementedAt < createdAt) {
      addViolation(
        rfcId,
        relFile,
        "V-08",
        `implementedAt (${implementedAt}) precedes createdAt (${createdAt})`,
      );
    }
  }

  // V-08b: enhancedAt >= createdAt
  if (enhancedAt && datePattern.test(enhancedAt) && datePattern.test(createdAt)) {
    if (enhancedAt < createdAt) {
      addViolation(
        rfcId,
        relFile,
        "V-08",
        `enhancedAt (${enhancedAt}) precedes createdAt (${createdAt})`,
      );
    }
  }

  // V-09: closedAt >= createdAt
  const closedAt = fm["closedAt"] as string | undefined;
  if (closedAt && datePattern.test(closedAt) && datePattern.test(createdAt)) {
    if (closedAt < createdAt) {
      addViolation(
        rfcId,
        relFile,
        "V-09",
        `closedAt (${closedAt}) precedes createdAt (${createdAt})`,
      );
    }
  }

  // V-10: supersedes point to existing RFCs (+ V-12 forward back-link check)
  const supersedes = fm["supersedes"];
  if (Array.isArray(supersedes)) {
    for (const ref of supersedes) {
      const refStr = String(ref);
      if (!refStr) continue;
      if (!allParsed.has(refStr)) {
        addViolation(
          rfcId,
          relFile,
          "V-10",
          `supersedes "${refStr}" does not match any existing RFC`,
        );
      } else {
        const otherBy = String(allParsed.get(refStr)!.parsed.frontmatter["supersededBy"] ?? "");
        if (otherBy !== rfcId) {
          addViolation(
            rfcId,
            relFile,
            "V-12",
            `${rfcId}.supersedes includes ${refStr}, but ${refStr}.supersededBy is "${otherBy || "(empty)"}" (expected ${rfcId})`,
            "warning",
          );
        }
      }
    }
  }

  // V-11: supersededBy points to existing RFC
  const supersededBy = fm["supersededBy"] as string | undefined;
  if (supersededBy && !allParsed.has(supersededBy)) {
    addViolation(
      rfcId,
      relFile,
      "V-11",
      `supersededBy "${supersededBy}" does not match any existing RFC`,
    );
  }

  // V-12 (reverse): supersededBy target must list this RFC in its supersedes
  if (supersededBy && allParsed.has(supersededBy)) {
    const otherFm = allParsed.get(supersededBy)!.parsed.frontmatter;
    const otherSupersedes = otherFm["supersedes"];
    if (!Array.isArray(otherSupersedes) || !otherSupersedes.map(String).includes(rfcId)) {
      addViolation(
        rfcId,
        relFile,
        "V-12",
        `${rfcId} is supersededBy ${supersededBy}, but ${supersededBy}.supersedes does not include ${rfcId}`,
        "warning",
      );
    }
  }

  // V-17: strict supersession lifecycle
  if (supersededBy && status !== "superseded") {
    addViolation(
      rfcId,
      relFile,
      "V-17",
      `supersededBy is set (${supersededBy}) but status is "${status}" (expected "superseded")`,
      "warning",
    );
  }

  // V-13: required H2 sections (all RFCs use the full template)
  const requiredSections = RFC_FULL_REQUIRED_SECTIONS;
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());

  for (const section of requiredSections) {
    if (!headings.includes(section)) {
      addViolation(
        rfcId,
        relFile,
        "V-13",
        `Missing required section "## ${section}"`,
        status === "draft" ? "warning" : "error",
      );
    }
  }

  // V-14: acceptance criteria must have at least 3 checklist items
  const acceptanceMatch = body.match(/## Acceptance criteria\s*\n([\s\S]*?)(?=\n## |\n*$)/);
  if (acceptanceMatch) {
    const checklistItems = acceptanceMatch[1]!.match(/^- \[[ x]\]/gm);
    const count = checklistItems?.length ?? 0;
    if (count < 3) {
      addViolation(
        rfcId,
        relFile,
        "V-14",
        `Acceptance criteria has ${count} checklist items; minimum is 3`,
        status === "draft" ? "warning" : "error",
      );
    }
  }

  // V-26: implemented RFCs must have all acceptance criteria checked (RFC-0463)
  // V-27: every checked criterion must carry inline (evidence: ...) annotation (RFC-0463)
  // RFC-0476: both use the shared evaluateAcceptanceCriteria function.
  if (acceptanceMatch) {
    const criteriaEval = evaluateAcceptanceCriteria(body);
    if (status === "implemented" && criteriaEval.totalUnchecked > 0) {
      addViolation(
        rfcId,
        relFile,
        "V-26",
        `status is "implemented" but ${criteriaEval.totalUnchecked} acceptance criteria are unchecked. ` +
          `Complete the work or split deferred criteria into a follow-up RFC via supersede.`,
      );
    }
    for (const line of criteriaEval.checkedWithoutEvidence) {
      addViolation(
        rfcId,
        relFile,
        "V-27",
        `checked acceptance criterion lacks inline (evidence: ...) annotation: "${line}"`,
      );
    }
  }

  // V-15: title consistency
  const titleStr = String(fm["title"] ?? "");
  const headingMatch = body.match(/^#\s+(?:RFC-\d{4}:\s*)?(.+)$/m);
  if (headingMatch && titleStr) {
    const headingTitle = headingMatch[1]!.trim();
    if (headingTitle !== titleStr) {
      addViolation(
        rfcId,
        relFile,
        "V-15",
        `Frontmatter title "${titleStr}" does not match body heading "${headingTitle}"`,
        "warning",
      );
    }
  }

  // V-16: status <-> date coupling
  const implementedAtStr = String(fm["implementedAt"] ?? "");
  const closedAtStr = String(fm["closedAt"] ?? "");
  const isTerminalStatus = status === "superseded" || status === "rejected";
  if (status === "implemented" && !implementedAtStr) {
    addViolation(
      rfcId,
      relFile,
      "V-16",
      `status is "implemented" but implementedAt is empty`,
      "error",
    );
  }
  if ((status === "accepted" || status === "draft") && implementedAtStr) {
    addViolation(
      rfcId,
      relFile,
      "V-16",
      `status is "${status}" but implementedAt is set (${implementedAtStr})`,
      "error",
    );
  }
  if (isTerminalStatus && !closedAtStr) {
    addViolation(rfcId, relFile, "V-16", `status is "${status}" but closedAt is empty`, "warning");
  }
  if (!isTerminalStatus && closedAtStr) {
    addViolation(
      rfcId,
      relFile,
      "V-16",
      `closedAt is set (${closedAtStr}) but status "${status}" is not terminal (superseded/rejected)`,
      "warning",
    );
  }

  // V-18: referential integrity of related[]
  const related = fm["related"];
  if (Array.isArray(related)) {
    for (const ref of related) {
      const refStr = String(ref).trim();
      if (!refStr) continue;
      if (/^RFC-\d{4}$/.test(refStr)) {
        if (!allParsed.has(refStr)) {
          addViolation(
            rfcId,
            relFile,
            "V-18",
            `related "${refStr}" does not match any existing RFC`,
            "warning",
          );
        }
      } else if (/^DNA-\d+$/i.test(refStr) && validDnaIds.size > 0) {
        if (!validDnaIds.has(parseInt(refStr.slice(4), 10))) {
          addViolation(
            rfcId,
            relFile,
            "V-18",
            `related "${refStr}" is not defined in ${DNA_DOC}`,
            "warning",
          );
        }
      } else if (/^AP-\d+$/i.test(refStr) && validApIds.size > 0) {
        if (!validApIds.has(parseInt(refStr.slice(3), 10))) {
          addViolation(
            rfcId,
            relFile,
            "V-18",
            `related "${refStr}" is not defined in ${AP_DOC}`,
            "warning",
          );
        }
      }
    }
  }

  // V-19: amends/amendedBy referential + bidirectional integrity
  const amends = fm["amends"];
  if (Array.isArray(amends)) {
    for (const ref of amends) {
      const refStr = String(ref);
      if (!refStr) continue;
      if (!allParsed.has(refStr)) {
        addViolation(rfcId, relFile, "V-19", `amends "${refStr}" does not match any existing RFC`);
      } else {
        const otherAmendedBy = allParsed.get(refStr)!.parsed.frontmatter["amendedBy"];
        const arr = Array.isArray(otherAmendedBy) ? otherAmendedBy.map(String) : [];
        if (!arr.includes(rfcId)) {
          addViolation(
            rfcId,
            relFile,
            "V-19",
            `${rfcId}.amends includes ${refStr}, but ${refStr}.amendedBy does not include ${rfcId}`,
            "warning",
          );
        }
      }
    }
  }
  const amendedBy = fm["amendedBy"];
  if (Array.isArray(amendedBy)) {
    for (const ref of amendedBy) {
      const refStr = String(ref);
      if (!refStr) continue;
      if (!allParsed.has(refStr)) {
        addViolation(
          rfcId,
          relFile,
          "V-19",
          `amendedBy "${refStr}" does not match any existing RFC`,
        );
      } else {
        const otherAmends = allParsed.get(refStr)!.parsed.frontmatter["amends"];
        const arr = Array.isArray(otherAmends) ? otherAmends.map(String) : [];
        if (!arr.includes(rfcId)) {
          addViolation(
            rfcId,
            relFile,
            "V-19",
            `${rfcId}.amendedBy includes ${refStr}, but ${refStr}.amends does not include ${rfcId}`,
            "warning",
          );
        }
      }
    }
  }

  // V-21: filename must be lowercase kebab-case
  const lowerRfcId = rfcId.toLowerCase();
  const fileBasename = fileName.split("/").pop()!.split("\\").pop()!;
  if (!fileBasename.startsWith(lowerRfcId)) {
    addViolation(
      rfcId,
      relFile,
      "V-21",
      `Filename "${fileBasename}" must start with lowercase "${lowerRfcId}"`,
    );
  } else if (!/^[a-z0-9-]+\.md$/.test(fileBasename)) {
    addViolation(
      rfcId,
      relFile,
      "V-21",
      `Filename "${fileName}" is not lowercase kebab-case (only a-z, 0-9, hyphens allowed)`,
    );
  }

  // V-20: no unknown frontmatter keys
  for (const key of Object.keys(fm)) {
    if (!knownKeys.has(key)) {
      addViolation(
        rfcId,
        relFile,
        "V-20",
        `unknown frontmatter key "${key}" (not in the RFC schema)`,
        "warning",
      );
    }
  }

  // V-22: well-formed acceptance probe shape
  for (const issue of validateAcceptanceShape(fm["acceptance"])) {
    addViolation(rfcId, relFile, "V-22", issue.message, "warning");
  }

  // V-23: verification evidence for post-cutoff, probe-bearing, implemented RFCs
  const createdAtStr = String(fm["createdAt"] ?? "");
  const hasProbes = Array.isArray(fm["acceptance"]) && (fm["acceptance"] as unknown[]).length > 0;
  if (createdAtStr >= RFC_METADATA_CUTOFF && hasProbes && status === "implemented") {
    const slug = rfcId.toLowerCase();
    const evidenceRelPath = path.join(RFC_DIR, "verification", `${slug}.generated.yaml`);
    const evidenceAbsPath = path.join(workspaceRoot, evidenceRelPath);
    let evidenceOk = false;
    let evidenceOverall = "";
    try {
      const evidenceContent = await readFile(evidenceAbsPath, "utf-8");
      const evidence = yamlParse(evidenceContent) as { overall?: string };
      evidenceOverall = String(evidence.overall ?? "");
      evidenceOk = evidenceOverall === "pass";
    } catch {
      // file missing or unparseable
    }
    if (!evidenceOk) {
      addViolation(
        rfcId,
        relFile,
        "V-23",
        `status is "implemented" with acceptance probes and createdAt >= ${RFC_METADATA_CUTOFF}, ` +
          `but evidence file ${evidenceRelPath} is missing, unparseable, or overall is not "pass" ` +
          `(got "${evidenceOverall || "missing"}"). Run: site-kernel run rfc.verification.emit --id ${rfcId}`,
      );
    }
  }

  // V-25: reviewer identity on newly decided RFCs (RFC-0335)
  {
    const reviewers = fm["reviewers"];
    const reviewerArr = Array.isArray(reviewers) ? (reviewers as unknown[]).map(String) : [];
    const isDecided = DECIDED_STATUSES.includes(status as RfcStatus);
    const isPostCutoff = createdAtStr >= RFC_METADATA_CUTOFF;

    if (isPostCutoff && isDecided && reviewerArr.length === 0) {
      addViolation(
        rfcId,
        relFile,
        "V-25",
        `${status} RFC created ${createdAtStr} has empty reviewers — the deciding human must record their identity (RFC-0335).`,
      );
    }

    for (const entry of reviewerArr) {
      if (!REVIEWER_IDENTITY_PATTERN.test(entry)) {
        addViolation(
          rfcId,
          relFile,
          "V-25",
          `reviewer "${entry}" does not match the identity format ^(human|agent):[a-z0-9][a-z0-9-]*$ (RFC-0335).`,
        );
      } else if (entry.startsWith("agent:")) {
        addViolation(
          rfcId,
          relFile,
          "V-25",
          `agent reviewer identities are reserved until an RFC grants AI reviewer authority over RFC governance (see RFC-0279 for the pattern) (RFC-0335).`,
        );
      }
    }
  }

  // V-24: satisfies DNA-trace frontmatter (RFC-0331)
  {
    const satisfies = fm["satisfies"];
    const satisfiesArr = Array.isArray(satisfies) ? (satisfies as unknown[]).map(String) : [];
    const satisfiesPresent = satisfiesArr.length > 0;
    const kind = String(fm["kind"] ?? "");
    const requiresSatisfies =
      createdAtStr >= RFC_METADATA_CUTOFF && (kind === "architecture" || kind === "contract");

    // Format: all RFCs, any age — each entry must match ^DNA-\d+$
    if (satisfiesPresent) {
      for (const entry of satisfiesArr) {
        if (!/^DNA-\d+$/.test(entry)) {
          addViolation(
            rfcId,
            relFile,
            "V-24",
            `satisfies entry "${entry}" does not match the format ^DNA-\\d+$ (RFC-0331).`,
          );
        }
      }
    }

    // Presence: post-cutoff architecture/contract RFCs must have non-empty satisfies
    if (requiresSatisfies && !satisfiesPresent) {
      addViolation(
        rfcId,
        relFile,
        "V-24",
        `${kind} RFC created ${createdAtStr} (>= ${RFC_METADATA_CUTOFF}) must declare at least one DNA invariant in satisfies (RFC-0331).`,
      );
    }
  }

  // V-28: RFC-id monotonicity (RFC-0478) — no RFC may have an id lower
  // than the maximum id among RFCs with a strictly earlier createdAt.
  // Same-day RFCs (equal createdAt) are unconstrained relative to each other.
  // Only applies to RFCs created strictly after RFC_VERSION_BUMP_CUTOFF;
  // pre-cutoff and same-day RFCs predate the rule and are exempt.
  // All RFCs (including pre-cutoff) participate in the comparison set.
  {
    const currentIdNum = parseInt(rfcId.replace(/^RFC-/, ""), 10);
    const currentCreatedAt = String(fm["createdAt"] ?? "");
    if (currentCreatedAt > RFC_VERSION_BUMP_CUTOFF) {
      let maxEarlierId = 0;
      for (const [otherId, other] of allParsed) {
        if (otherId === rfcId) continue;
        const otherCreatedAt = String(other.parsed.frontmatter["createdAt"] ?? "");
        if (otherCreatedAt < currentCreatedAt) {
          const otherIdNum = parseInt(otherId.replace(/^RFC-/, ""), 10);
          if (otherIdNum > maxEarlierId) {
            maxEarlierId = otherIdNum;
          }
        }
      }
      if (currentIdNum < maxEarlierId) {
        addViolation(
          rfcId,
          relFile,
          "V-28",
          `RFC-id ${rfcId} (createdAt ${currentCreatedAt}) is lower than RFC-${maxEarlierId} which has a strictly earlier createdAt. RFC-ids must be monotonically non-decreasing with respect to createdAt (RFC-0478).`,
        );
      }
    }
  }

  // V-29: versionBump required for post-cutoff accepted/implemented RFCs (RFC-0478)
  {
    const versionBump = fm["versionBump"];
    const isPostCutoff = createdAtStr >= RFC_VERSION_BUMP_CUTOFF;
    const requiresVersionBump = status === "implemented" || status === "accepted";

    if (isPostCutoff && requiresVersionBump && versionBump === undefined) {
      addViolation(
        rfcId,
        relFile,
        "V-29",
        `status is "${status}" and createdAt >= ${RFC_VERSION_BUMP_CUTOFF}, but versionBump is absent. Post-cutoff accepted/implemented RFCs must declare versionBump (RFC-0478).`,
      );
    }

    if (versionBump === "none") {
      const commands = fm["commands"] as Record<string, unknown> | undefined;
      const added = Array.isArray(commands?.added) ? (commands!.added as unknown[]) : [];
      const changed = Array.isArray(commands?.changed) ? (commands!.changed as unknown[]) : [];
      if (added.length > 0 || changed.length > 0) {
        addViolation(
          rfcId,
          relFile,
          "V-29",
          `versionBump is "none" but commands.added or commands.changed is non-empty. Commands imply code changes; use "patch" or "minor" instead (RFC-0478).`,
          "warning",
        );
      }
    }
  }

  // V-30: breaksC field consistency (RFC-0480)
  // If breaksC: true — @warpgogol/ontology must be in packagesImpacted.
  // If breaksC absent/false but @warpgogol/ontology in packagesImpacted — warning.
  {
    const breaksC = fm["breaksC"];
    const packagesImpacted = Array.isArray(fm["packagesImpacted"])
      ? (fm["packagesImpacted"] as unknown[]).map(String)
      : [];
    const hasOntology = packagesImpacted.some((p) => p.includes("@warpgogol/ontology"));

    if (breaksC === true && !hasOntology) {
      addViolation(
        rfcId,
        relFile,
        "V-30",
        `breaksC is true but @warpgogol/ontology is not in packagesImpacted. RFCs that break Layer C must update the declarative C-contract in packages/ontology/src/external-surfaces/ (RFC-0480).`,
      );
    }

    if (breaksC !== true && hasOntology) {
      addViolation(
        rfcId,
        relFile,
        "V-30",
        `@warpgogol/ontology is in packagesImpacted but breaksC is not true. If this RFC modifies packages/ontology/src/external-surfaces/, declare breaksC: true (RFC-0480).`,
        "warning",
      );
    }
  }

  // V-31: filename-number uniqueness and filename/id consistency (RFC-0491)
  if (seenFilenameNumbers) {
    const fileBasename = fileName.split("/").pop()!.split("\\").pop()!;
    const fileNumMatch = fileBasename.match(/^rfc-(\d{4})/);
    if (fileNumMatch) {
      const fileNum = parseInt(fileNumMatch[1]!, 10);
      const idNum = parseInt(rfcId.replace(/^RFC-/, ""), 10);

      // Sub-check A: filename number must match frontmatter id number
      if (!Number.isNaN(idNum) && fileNum !== idNum) {
        addViolation(
          rfcId,
          relFile,
          "V-31",
          `Filename number ${String(fileNum).padStart(4, "0")} does not match frontmatter id ${rfcId}`,
        );
      }

      // Sub-check B: filename number must be unique across the full tree
      const prevNumFile = seenFilenameNumbers.get(fileNum);
      if (prevNumFile) {
        addViolation(
          rfcId,
          relFile,
          "V-31",
          `Duplicate filename number ${String(fileNum).padStart(4, "0")} — also in ${prevNumFile}`,
        );
      } else {
        seenFilenameNumbers.set(fileNum, relFile);
      }
    }
  }

  // V-32: implementation commit drift detection (RFC-0625)
  // Warns when implement: RFC-XXXX commits exist in git history since createdAt
  // but the RFC status is not yet "implemented".
  {
    const driftResult = await checkImplementationCommitDrift(
      workspaceRoot,
      rfcId,
      createdAt,
      status,
    );
    if (driftResult.found) {
      addViolation(
        rfcId,
        relFile,
        "V-32",
        `${rfcId} has ${driftResult.commitCount} implement: commit(s) in git history since ${createdAt} but status is still "${status}". Run rfc.implement.stamp to transition to implemented.`,
        "warning",
      );
    }
  }

  // V-NC-01: NEEDS CLARIFICATION marker detection (RFC-0709)
  const ncMarkers = collectMarkers(body, status, createdAt);
  for (const marker of ncMarkers) {
    addViolation(
      rfcId,
      relFile,
      "V-NC-01",
      `Unresolved NEEDS CLARIFICATION marker at line ${marker.line}: "${marker.text}"`,
      marker.severity === "error" ? "error" : "warning",
    );
  }

  return ncMarkers;
}
