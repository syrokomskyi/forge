/*
<MODULE_CONTRACT>
<purpose>
RFC-0476: rfc.implement.stamp — the exclusive atomic path for every
accepted → implemented RFC transition. Validates preconditions, records
verification evidence, and atomically mutates RFC frontmatter.
</purpose>
<non-goals>
  <item>Does not transition non-accepted RFCs.</item>
  <item>Does not bypass V-26/V-27 criterion semantics — reuses evaluateAcceptanceCriteria.</item>
  <item>Does not call the GitHub API or require network access.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1310: governance-id parity guards on ecosystem.commit and rfc.implement.stamp</item>
  <item>RFC-1321: commitReferencesRfc compares case-insensitively — --id rfc-NNNN satisfies an RFC-NNNN subject (RFC-IMP-03 false-fail closed)</item>
  <item>RFC-1321: review-r2: stringLiteralValue — comment-aware literal extractor keys COMMAND_PROVENANCE cleanly (adjacent comments no longer corrupt the key or evade CMDGEN-03); (?!\d) boundary in commitCarriesGovernanceProvenance; non-string --id guard</item>
  <item>RFC-1322: steps 1-3 — --check-criteria flag, auto-check pass, atomic flip+stamp</item>
  <item>RFC-1322: step 4 — --check-criteria resolvable/unresolvable matrix + dry-run residual-unchecked fix</item>
  <history>RFC-0268, RFC-0476, RFC-0756, RFC-0795, RFC-0997, RFC-1053, RFC-1097, RFC-1249, RFC-1271, RFC-1306, RFC-IMP-07</history>
</CHANGE_SUMMARY>
*/

import { execFile, writeFileSync } from "../../../src/utils/sync-fs.ts";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";

import { join, dirname } from "node:path";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { parse as yamlParse } from "yaml";
import { generateRfcMetrics } from "../../session/handlers/metrics-rfc.ts";

import {
  listRfcFiles,
  readAndParseRfc,
  rfcFileMatchesId,
  loadRfcStatusMap,
} from "../frontmatter-io.ts";
import { evaluateAcceptanceCriteria } from "./validate-rules.ts";
import { toIsoDate } from "./shared.ts";
import { byteHashHex, normalizeProbes, runRfcVerificationEmit } from "../verification-evidence.ts";
import { RFC_DIR, RFC_METADATA_CUTOFF, RFC_PROBE_BINDING_CUTOFF } from "../types.ts";
import type {
  RfcStatus,
  RfcImplementStampViolation,
  RfcImplementStampResult,
  AcceptanceProbe,
  VerificationEvidence,
} from "../types.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const VERIFICATION_DIR = join(RFC_DIR, "verification");

// ─── Git helpers ─────────────────────────────────────────────────────────────

// Pipeline convention: the implementation commit's subject carries an
// `implement:` (or `feat:`) conventional prefix — audit/enhance/plan/docs/
// review/fix/chore commits referencing the same RFC id never claim it.
const IMPLEMENTATION_SUBJECT_RE = /^(implement|feat)(\([^)]*\))?!?:/i;

function execGit(workspaceRoot: string, args: string[]): Promise<string> {
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

async function isRfcFileClean(workspaceRoot: string, rfcRelPath: string): Promise<boolean> {
  const status = await execGit(workspaceRoot, ["status", "--porcelain", "--", rfcRelPath]);
  return status.length === 0;
}

async function commitReachableFromHead(workspaceRoot: string, commitSha: string): Promise<boolean> {
  const _result = await execGit(workspaceRoot, ["merge-base", "--is-ancestor", commitSha, "HEAD"]);
  // merge-base --is-ancestor exits 0 if ancestor, 1 if not, >1 on error
  // execGit returns "" on error (non-zero exit), trimmed stdout on success
  // So we need a different approach: check exit code directly
  return new Promise((resolve) => {
    execFile(
      "git",
      ["merge-base", "--is-ancestor", commitSha, "HEAD"],
      { cwd: workspaceRoot, timeout: 10000 },
      (err) => {
        resolve(!err);
      },
    );
  });
}

async function autoDetectImplementationCommit(
  workspaceRoot: string,
  rfcId: string,
): Promise<
  { sha: string } | { multiple: Array<{ sha: string; message: string }> } | { none: true }
> {
  const hashes = await execGit(workspaceRoot, [
    "log",
    "--fixed-strings",
    "--regexp-ignore-case",
    "--no-merges",
    `--grep=${rfcId}`,
    "--format=%H",
  ]);

  const hashList = hashes.split("\n").filter(Boolean);

  if (hashList.length === 0) return { none: true };
  if (hashList.length === 1) return { sha: hashList[0]! };

  const details = await execGit(workspaceRoot, [
    "log",
    "--fixed-strings",
    "--regexp-ignore-case",
    "--no-merges",
    `--grep=${rfcId}`,
    "--format=%h %s",
  ]);

  const candidates = details
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      const sha = spaceIdx >= 0 ? line.slice(0, spaceIdx) : line;
      const message = spaceIdx >= 0 ? line.slice(spaceIdx + 1) : "";
      return { sha, message };
    });

  return { multiple: candidates };
}

/**
 * RFC-1310 STAMP-GOV-01: provenance, not mere reference — the commit carries
 * an `X-RFC:`/`X-ADR:` trailer naming the id (ecosystem.commit --rfc/--adr)
 * or its diff adds a CHANGE_SUMMARY `<item>` naming the id (the injection
 * itself, e.g. commits made before the trailer existed).
 */
async function commitCarriesGovernanceProvenance(
  workspaceRoot: string,
  commitSha: string,
  rfcId: string,
): Promise<boolean> {
  const idUpper = rfcId.toUpperCase();
  // RFC-1321 review-r2: same (?!\d) boundary as commitReferencesRfc —
  // X-RFC: RFC-00011 must not satisfy provenance for RFC-0001.
  const idRe = new RegExp(`${idUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
  const commitMsg = await execGit(workspaceRoot, ["log", "-1", "--format=%B", commitSha]);
  if (
    commitMsg.split("\n").some((l) => /^X-(?:RFC|ADR):\s*\S/i.test(l) && idRe.test(l.toUpperCase()))
  ) {
    return true;
  }
  const diff = await execGit(workspaceRoot, ["show", "-U0", "--format=", commitSha]);
  return diff
    .split("\n")
    .some(
      (l) =>
        l.startsWith("+") &&
        !l.startsWith("+++") &&
        l.includes("<item>") &&
        idRe.test(l.toUpperCase()),
    );
}

async function commitReferencesRfc(
  workspaceRoot: string,
  commitSha: string,
  rfcId: string,
): Promise<boolean> {
  // Check the commit message and the diff for the RFC ID
  const commitMsg = await execGit(workspaceRoot, ["log", "-1", "--format=%B", commitSha]);
  // RFC-1321: governance ids compare case-insensitively — `--id rfc-1310` must
  // satisfy an `RFC-1310` subject (the RFC-IMP-03 false-fail). The (?!\d)
  // boundary keeps RFC-0001 from matching RFC-00011.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${esc(rfcId.toUpperCase())}(?!\\d)`).test(commitMsg.toUpperCase())) return true;

  // Also check if the commit touched a file whose name contains the RFC id
  const changedFiles = await execGit(workspaceRoot, [
    "show",
    "--name-only",
    "--format=",
    commitSha,
  ]);
  const slug = rfcId.toLowerCase();
  if (new RegExp(`${esc(slug)}(?!\\d)`).test(changedFiles.toLowerCase())) return true;

  return false;
}

// ─── RFC-specific exclusive lock ─────────────────────────────────────────────

function lockFilePath(workspaceRoot: string, rfcId: string): string {
  const slug = rfcId.toLowerCase();
  return join(workspaceRoot, ".rfc-locks", `${slug}.lock`);
}

async function acquireRfcLock(
  workspaceRoot: string,
  rfcId: string,
): Promise<{ acquired: boolean; lockPath: string }> {
  const lockPath = lockFilePath(workspaceRoot, rfcId);
  const lockDir = dirname(lockPath);
  await io.mkdir(lockDir);

  // Atomic lock acquisition via O_EXCL file creation
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      { flag: "wx" },
    );
    return { acquired: true, lockPath };
  } catch {
    return { acquired: false, lockPath };
  }
}

async function releaseRfcLock(lockPath: string): Promise<void> {
  try {
    await io.rm(lockPath);
  } catch {
    // Lock file already removed — safe
  }
}

// ─── Evidence helpers ────────────────────────────────────────────────────────

async function checkExistingEvidence(
  workspaceRoot: string,
  rfcId: string,
): Promise<{
  exists: boolean;
  overall: string;
  envelope: VerificationEvidence | null;
  malformed: boolean;
}> {
  const slug = rfcId.toLowerCase();
  const evidencePath = join(workspaceRoot, VERIFICATION_DIR, `${slug}.generated.yaml`);
  let content: string;
  try {
    content = await io.readFile(evidencePath);
  } catch {
    return { exists: false, overall: "missing", envelope: null, malformed: false };
  }
  let parsed: unknown;
  try {
    parsed = yamlParse(content);
  } catch {
    return { exists: true, overall: "malformed", envelope: null, malformed: true };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Fail closed: a committed envelope that parses to a scalar/array is
    // malformed evidence, not absent evidence.
    return { exists: true, overall: "malformed", envelope: null, malformed: true };
  }
  const evidence = parsed as VerificationEvidence;
  return {
    exists: true,
    overall: String(evidence.overall ?? ""),
    envelope: evidence,
    malformed: false,
  };
}

// ─── Frontmatter mutation ────────────────────────────────────────────────────

function mutateFrontmatter(
  source: string,
  status: "implemented",
  implementedAt: string,
  updatedAt: string,
): string {
  let content = source;

  // Replace status
  content = content.replace(/^status: \w+$/m, `status: ${status}`);

  // Replace implementedAt (may be empty or already set)
  if (/^implementedAt:.*$/m.test(content)) {
    content = content.replace(/^implementedAt:.*$/m, `implementedAt: ${implementedAt}`);
  } else {
    // Insert after updatedAt
    content = content.replace(
      /^updatedAt: .*$/m,
      `updatedAt: ${updatedAt}\nimplementedAt: ${implementedAt}`,
    );
  }

  // Replace updatedAt
  content = content.replace(/^updatedAt: .*$/m, `updatedAt: ${updatedAt}`);

  return content;
}

// ─── RFC-1322: --check-criteria ──────────────────────────────────────────────

/** Extract the inline `(evidence: ...)` annotation text from a criterion line. */
function extractEvidenceAnnotation(line: string): string | undefined {
  return line.match(/\(evidence:\s*(.+?)\)/)?.[1]?.trim();
}

/**
 * The AC-N identifier of a checklist line, or a truncated line excerpt when it
 * carries no id — STAMP-CHECK-01 diagnostics and criteriaAutoChecked key on it.
 */
function criterionLabelOf(line: string): string {
  const id = line.match(/- \[[ x]\]\s*(AC-\d+):/)?.[1];
  if (id) return id;
  const trimmed = line.trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed;
}

/**
 * Resolvable-annotation contract (RFC-1322 — deliberately stricter than V-37,
 * which validates the `probe:` binding only and lets `file:` annotations fall
 * through unvalidated): `test:<path>`, `file:<path>`, and `<path>:<line>`
 * resolve when the path exists on disk; `probe:AC-N` resolves when the
 * evidence envelope carries a probe record bound to AC-N with ok === true.
 * Every other form is unresolvable — the stamp certifies, so it resolves
 * evidence, not just references.
 */
async function resolveCriterionEvidence(
  annotation: string,
  envelope: VerificationEvidence | null,
  workspaceRoot: string,
): Promise<boolean> {
  if (annotation.startsWith("probe:")) {
    const refId = annotation.slice("probe:".length).trim();
    return envelope?.probes.some((r) => r.probe.criterion === refId && r.ok) === true;
  }
  if (annotation.startsWith("test:") || annotation.startsWith("file:")) {
    const filePath = annotation.slice(annotation.indexOf(":") + 1).trim();
    try {
      await io.stat(join(workspaceRoot, filePath));
      return true;
    } catch {
      return false;
    }
  }
  if (/^[^:]+:\d+$/.test(annotation)) {
    const filePath = annotation.slice(0, annotation.lastIndexOf(":")).trim();
    try {
      await io.stat(join(workspaceRoot, filePath));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The committed envelope needs an in-process refresh when it is absent,
 * malformed, lacks the hash fields IMP-09 binds, or its hashes diverge from
 * the committed RFC bytes / acceptance list — the same comparisons IMP-09
 * performs, evaluated pre-write so the auto-check pass sees probe: evidence.
 */
function envelopeNeedsRefresh(
  evidenceCheck: {
    exists: boolean;
    malformed: boolean;
    envelope: VerificationEvidence | null;
  },
  rfcMarkdown: string,
  acceptance: unknown,
): boolean {
  if (!evidenceCheck.exists || evidenceCheck.malformed || !evidenceCheck.envelope) {
    return true;
  }
  const env = evidenceCheck.envelope;
  if (!env.rfcFileHash || !env.acceptanceHash) return true;
  const currentFileHash = byteHashHex(rfcMarkdown);
  const currentAcceptanceHash = byteHashHex(
    normalizeProbes(Array.isArray(acceptance) ? (acceptance as AcceptanceProbe[]) : []),
  );
  return env.rfcFileHash !== currentFileHash || env.acceptanceHash !== currentAcceptanceHash;
}

interface AutoCheckOutcome {
  /** Trimmed unchecked lines whose evidence resolved — flip targets. */
  flippable: string[];
  /** Criterion labels of flippable lines — the criteriaAutoChecked surface. */
  flippedIds: string[];
  /** Unresolvable/absent annotations — STAMP-CHECK-01 payloads. */
  failures: Array<{ criterion: string; annotation: string }>;
  /**
   * Dry-run only: `probe:` annotations that cannot resolve because the
   * envelope would be refreshed first. Not failures — the real run resolves
   * them against the freshly emitted envelope.
   */
  pendingRefresh: string[];
}

/** In-memory auto-check pass over the unchecked criteria of the committed body. */
async function autoCheckCriteria(opts: {
  uncheckedLines: string[];
  envelope: VerificationEvidence | null;
  /** False in dry-run when the envelope would be re-emitted before resolving. */
  probesUsable: boolean;
  workspaceRoot: string;
}): Promise<AutoCheckOutcome> {
  const outcome: AutoCheckOutcome = {
    flippable: [],
    flippedIds: [],
    failures: [],
    pendingRefresh: [],
  };
  for (const line of opts.uncheckedLines) {
    const label = criterionLabelOf(line);
    const annotation = extractEvidenceAnnotation(line);
    if (!annotation) {
      outcome.failures.push({
        criterion: label,
        annotation: "<no (evidence: ...) annotation>",
      });
      continue;
    }
    if (!opts.probesUsable && annotation.startsWith("probe:")) {
      // Store the trimmed line so the post-flip gate can exclude pending
      // criteria from the residual-unchecked check (they flip post-emit in
      // the real run); labels derive via criterionLabelOf when reported.
      outcome.pendingRefresh.push(line);
      continue;
    }
    if (await resolveCriterionEvidence(annotation, opts.envelope, opts.workspaceRoot)) {
      outcome.flippable.push(line);
      outcome.flippedIds.push(label);
    } else {
      outcome.failures.push({ criterion: label, annotation });
    }
  }
  return outcome;
}

/**
 * Flip `- [ ]` → `- [x]` for the given unchecked criterion lines inside the
 * source's `## Acceptance criteria` section only — fenced code blocks are
 * skipped so a section example inside ``` fences never becomes a flip target
 * (the same guard the section extractors apply), and `## Document readiness`
 * DR-N items are out of scope by construction.
 */
function flipCriteriaInSource(source: string, uncheckedTargets: ReadonlySet<string>): string {
  const lines = source.split("\n");
  let inFence = false;
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^## /.test(line)) {
      inSection = /^## Acceptance criteria\s*$/.test(line);
      continue;
    }
    if (inSection && /^\s*- \[ \]/.test(line) && uncheckedTargets.has(line.trim())) {
      lines[i] = line.replace(/- \[ \]/, "- [x]");
    }
  }
  return lines.join("\n");
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function runRfcImplementStamp(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcImplementStampResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot, logger, outputFormat, dryRun } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);

  // RFC-1321: canonicalize the governance id at parse — every stored surface
  // (result rfcId, post-stamp re-emit flags, metrics ids) carries the
  // canonical uppercase spelling regardless of flag casing. A non-string flag
  // (repeated --id forms an array) degrades to absent rather than crashing.
  const rawId = input.flags["id"];
  const targetId = typeof rawId === "string" ? rawId.toUpperCase() : undefined;
  let implementationCommit = input.flags["implementation-commit"] as string | undefined;

  // ── Flag validation ───────────────────────────────────────────────────────
  if (!targetId) {
    throw new Error("rfc.implement.stamp requires --id flag (e.g. --id RFC-0476).");
  }

  const violations: RfcImplementStampViolation[] = [];
  const isDryRun = dryRun || input.flags["dry-run"] === true;
  // RFC-1322: the stamp performs the checkbox flips itself — but only for
  // criteria whose (evidence: ...) annotation resolves — and refreshes a
  // missing/stale envelope in-process before the gates evaluate it.
  const checkCriteria = input.flags["check-criteria"] === true;

  // ── Find the target RFC ───────────────────────────────────────────────────
  const files = await listRfcFiles(rfcDirPath);
  const targetFile = files.find((f) => rfcFileMatchesId(f, targetId));

  if (!targetFile) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `RFC ${targetId} not found in ${RFC_DIR}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const targetParsed = await readAndParseRfc(rfcDirPath, targetFile);
  if (!targetParsed) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `Could not parse target RFC ${targetId}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }
  if ("error" in targetParsed) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `Could not parse target RFC ${targetId}: ${targetParsed.error}`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const fm = targetParsed.parsed.frontmatter;
  const body = targetParsed.parsed.body;
  const currentStatus = String(fm["status"] ?? "") as RfcStatus;

  // ── RFC-IMP-01: must be in accepted status ────────────────────────────────
  if (currentStatus !== "accepted") {
    violations.push({
      rule: "RFC-IMP-01",
      message: `RFC ${targetId} has status "${currentStatus}" — only "accepted" RFCs can be stamped to "implemented".`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── RFC-1306: --sync runs the evidence-resync chain before stamping ────────
  // Positioned after the target RFC resolves (so --id is real) and before any
  // criteria/commit/evidence read, so the IMP-06/09 gates see fresh artifacts.
  // The chain is delegated by name through the kernel host's invoke port — the
  // standalone forge CLI has no host and fails closed like rfc.evidence.sync.
  if (input.flags["sync"] === true) {
    if (!context.invoke) {
      violations.push({
        rule: "EVIDENCE-SYNC-01",
        message:
          "--sync requires the werkstatt kernel host (context.invoke is absent). Run via `pnpm exec werkstatt run rfc.implement.stamp --id <id> --sync`, or resync manually.",
      });
      return stampFailResult(violations, isDryRun, outputFormat, logger);
    }
    let syncReport: Awaited<ReturnType<NonNullable<typeof context.invoke>>>;
    try {
      syncReport = await context.invoke("rfc.evidence.sync", { id: targetId });
    } catch (err) {
      violations.push({
        rule: "EVIDENCE-SYNC-02",
        message: `rfc.evidence.sync threw before stamping: ${err instanceof Error ? err.message : String(err)}. Resolve the failing step and re-run the stamp.`,
      });
      return stampFailResult(violations, isDryRun, outputFormat, logger);
    }
    if (syncReport.exitCode !== 0) {
      violations.push({
        rule: "EVIDENCE-SYNC-02",
        message: `rfc.evidence.sync failed before stamping${syncReport.summary ? `: ${syncReport.summary}` : ""}. Resolve the failing step and re-run the stamp.`,
      });
      return stampFailResult(violations, isDryRun, outputFormat, logger);
    }
    logger.info(`[rfc.implement.stamp] --sync: ${syncReport.summary ?? "resync chain completed"}`);
  }

  // ── RFC-IMP-02: criterion checks (V-26/V-27 semantics) ────────────────────
  // Under --check-criteria both branches defer: unchecked lines become flip
  // candidates for the auto-check pass, and checkedWithoutEvidence re-runs on
  // the post-flip body — a flipped line always keeps its annotation.
  const criteriaEval = evaluateAcceptanceCriteria(body);
  if (!checkCriteria && criteriaEval.totalUnchecked > 0) {
    violations.push({
      rule: "RFC-IMP-02",
      message: `${criteriaEval.totalUnchecked} acceptance criteria are unchecked. All criteria must be checked before stamping: ${criteriaEval.uncheckedLines.join("; ")}`,
    });
  }
  if (!checkCriteria && criteriaEval.checkedWithoutEvidence.length > 0) {
    violations.push({
      rule: "RFC-IMP-02",
      message: `${criteriaEval.checkedWithoutEvidence.length} checked criteria lack inline (evidence: ...) annotation: ${criteriaEval.checkedWithoutEvidence.join("; ")}`,
    });
  }

  // ── RFC-IMP-07: dependsOn dependency gate (RFC-0795) ──────────────────────
  const dependsOn = fm["dependsOn"];
  if (Array.isArray(dependsOn) && dependsOn.length > 0) {
    const statusMap = await loadRfcStatusMap(rfcDirPath);
    for (const depRef of dependsOn) {
      const depId = String(depRef);
      if (!depId) continue;
      const depStatus = statusMap.get(depId);
      if (!depStatus) {
        violations.push({
          rule: "RFC-IMP-07",
          message: `RFC ${targetId} depends on ${depId}, which does not exist in ${RFC_DIR}.`,
        });
      } else if (depStatus !== "implemented") {
        violations.push({
          rule: "RFC-IMP-07",
          message: `RFC ${targetId} depends on ${depId}, which is not implemented (status: ${depStatus}). Implement ${depId} first.`,
        });
      }
    }
  }

  // ── RFC-0756: auto-detect implementation commit when --implementation-commit is omitted ──
  // RFC-1310 STAMP-GOV-01: auto-detect candidates join the provenance scan
  // set — a trailer on any implementation-shaped commit counts.
  const provenanceCandidateShas: string[] = [];
  if (!implementationCommit) {
    const detected = await autoDetectImplementationCommit(workspaceRoot, targetId);
    if ("sha" in detected) {
      implementationCommit = detected.sha;
      provenanceCandidateShas.push(detected.sha);
    } else if ("none" in detected) {
      violations.push({
        rule: "RFC-IMP-03",
        message: `No commit referencing ${targetId} found in git history. Pass --implementation-commit <SHA> explicitly.`,
      });
    } else {
      // Auto-resolve when exactly one candidate looks like an implementation
      // commit — a multi-commit RFC pipeline (audit → plan → implement → docs →
      // review) references the id at every step, but only one step implements.
      provenanceCandidateShas.push(...detected.multiple.map((c) => c.sha));
      const implCandidates = detected.multiple.filter((c) =>
        IMPLEMENTATION_SUBJECT_RE.test(c.message),
      );
      if (implCandidates.length === 1) {
        implementationCommit = implCandidates[0]!.sha;
        logger.info(
          `[rfc.implement.stamp] auto-selected implementation commit ${implCandidates[0]!.sha} (sole implement/feat-prefixed candidate)`,
        );
      } else {
        const candidateList = detected.multiple
          .map(
            (c) =>
              `  ${c.sha} — ${c.message}${IMPLEMENTATION_SUBJECT_RE.test(c.message) ? "  [implementation-shaped]" : ""}`,
          )
          .join("\n");
        // git log lists newest first — the earliest implementation-shaped
        // commit is the most likely canonical pick for a step-wise wave.
        const earliest = implCandidates[implCandidates.length - 1];
        const suggestion = earliest
          ? `\nLikely: ${earliest.sha} (earliest implementation-shaped commit).`
          : "";
        violations.push({
          rule: "RFC-IMP-03",
          message: `Multiple commits reference ${targetId}:\n${candidateList}\nPass --implementation-commit <SHA> to specify which one.${suggestion}`,
        });
      }
    }
  }

  // ── RFC-IMP-04: RFC file must be clean (no uncommitted edits to the target RFC) ──
  // Only the RFC file being stamped is checked, not the entire working tree.
  // This allows multi-agent workflows where other agents may have uncommitted
  // changes in unrelated files.
  const rfcRelPath = join(RFC_DIR, targetFile);
  const rfcFileClean = await isRfcFileClean(workspaceRoot, rfcRelPath);
  if (!rfcFileClean) {
    violations.push({
      rule: "RFC-IMP-04",
      message: `RFC file ${rfcRelPath} has uncommitted changes. Commit the RFC file before stamping.`,
    });
  }

  // ── RFC-IMP-03: implementation commit validation ──────────────────────────
  if (implementationCommit) {
    const reachable = await commitReachableFromHead(workspaceRoot, implementationCommit);
    if (!reachable) {
      violations.push({
        rule: "RFC-IMP-03",
        message: `Implementation commit ${implementationCommit} is not reachable from HEAD. The commit must be an ancestor of the current HEAD.`,
      });
    } else {
      const referencesRfc = await commitReferencesRfc(
        workspaceRoot,
        implementationCommit,
        targetId,
      );
      if (!referencesRfc) {
        violations.push({
          rule: "RFC-IMP-03",
          message: `Implementation commit ${implementationCommit} does not reference ${targetId} in its message or changed files.`,
        });
      } else {
        // ── RFC-1310 STAMP-GOV-01: commit-time governance provenance ──────
        // A subject mention is not provenance — the implementation commit
        // (or an auto-detected sibling candidate) must carry the X-RFC
        // trailer or an injected CHANGE_SUMMARY item, else the stamp would
        // certify a provenance-broken implementation (DNA-59).
        const scanShas = [...new Set([implementationCommit, ...provenanceCandidateShas])];
        logger.info(
          `[rfc.implement.stamp] STAMP-GOV-01 scanning ${scanShas.length} commit(s): ${scanShas.join(", ")}`,
        );
        let provenance = false;
        for (const sha of scanShas) {
          if (await commitCarriesGovernanceProvenance(workspaceRoot, sha, targetId)) {
            provenance = true;
            break;
          }
        }
        if (!provenance) {
          violations.push({
            rule: "STAMP-GOV-01",
            message: `Implementation commit(s) for ${targetId} carry no governance provenance (no X-RFC: ${targetId} trailer, no injected CHANGE_SUMMARY item) — scanned: ${scanShas.join(", ")}. Retro-fix: hand-edit CHANGE_SUMMARY <item>${targetId}: …</item> entries into the touched files' headers in the worktree, then land a follow-up ecosystem.commit --rfc ${targetId} --message "docs(${targetId.toLowerCase()}): retrofit governance provenance" and re-stamp.`,
          });
        }
      }
    }
  }

  // ── RFC-IMP-06: probe-bearing RFCs require passing evidence ───────────────
  const acceptance = fm["acceptance"];
  const hasProbes = Array.isArray(acceptance) && (acceptance as unknown[]).length > 0;
  const createdAtStr = String(fm["createdAt"] ?? "");
  const requiresEvidence = createdAtStr >= RFC_METADATA_CUTOFF && hasProbes;
  const rfcFilePath = join(rfcDirPath, targetFile);

  let evidenceRelPath: string | undefined;

  // RFC-1271: the envelope is fetched unconditionally — a committed envelope
  // must also be evaluated when hasProbes is now false, because probe
  // deletion IS a criteria change and would otherwise slip past
  // requiresEvidence entirely (RFC-IMP-08 exempts policy/deprecation kinds).
  // let — --check-criteria re-reads the envelope after the emit-if-needed pass.
  let evidenceCheck = await checkExistingEvidence(workspaceRoot, targetId);

  if (!checkCriteria && requiresEvidence) {
    if (!evidenceCheck.exists || evidenceCheck.overall !== "pass") {
      violations.push({
        rule: "RFC-IMP-06",
        message: `RFC ${targetId} declares acceptance probes but evidence file is missing or overall is not "pass" (got "${evidenceCheck.overall}"). Run: site-kernel run rfc.verification.emit --id ${targetId}`,
      });
    } else {
      const slug = targetId.toLowerCase();
      evidenceRelPath = join(VERIFICATION_DIR, `${slug}.generated.yaml`);
    }
  }

  // ── RFC-IMP-09: stale evidence gate (RFC-1271) ────────────────────────────
  // Hashes are recomputed from the working tree; combined with RFC-IMP-04
  // (the RFC file must be committed-clean to stamp) the compared bytes are
  // effectively the committed bytes — deliberate, keeps the gate honest
  // without a second git read. Fires before any frontmatter mutation.
  // Under --check-criteria this gate moves inside the lock, evaluated against
  // the envelope the emit-if-needed pass may have just refreshed.
  if (!checkCriteria && evidenceCheck.exists) {
    if (evidenceCheck.malformed || !evidenceCheck.envelope) {
      violations.push({
        rule: "RFC-IMP-09",
        message: `RFC ${targetId} evidence envelope is malformed (unreadable YAML or non-object content). Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope — or delete the stale envelope file.`,
      });
    } else if (!hasProbes) {
      violations.push({
        rule: "RFC-IMP-09",
        message: `RFC ${targetId} has a committed evidence envelope but no acceptance: list — probes were deleted after emission, which is a criteria change. Either restore the probes and re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope — or delete the stale envelope file (rfc.verification.emit skips probe-less RFCs, so re-emit alone cannot clear this).`,
      });
    } else {
      const rfcMarkdown = await io.readFile(rfcFilePath);
      const currentFileHash = byteHashHex(rfcMarkdown);
      const currentAcceptanceHash = byteHashHex(normalizeProbes(acceptance as AcceptanceProbe[]));
      const env = evidenceCheck.envelope;
      if (!env.rfcFileHash || !env.acceptanceHash) {
        violations.push({
          rule: "RFC-IMP-09",
          message: `RFC ${targetId} evidence envelope lacks hash fields (pre-RFC-0330 format). Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope.`,
        });
      } else if (
        env.rfcFileHash !== currentFileHash ||
        env.acceptanceHash !== currentAcceptanceHash
      ) {
        const staleFields = [
          env.rfcFileHash !== currentFileHash ? "rfcFileHash" : "",
          env.acceptanceHash !== currentAcceptanceHash ? "acceptanceHash" : "",
        ]
          .filter(Boolean)
          .join(" + ");
        violations.push({
          rule: "RFC-IMP-09",
          message: `RFC ${targetId} evidence is stale: ${staleFields} mismatch — the RFC file or its acceptance list changed after emission. Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope.`,
        });
      }
    }
  }

  // ── RFC-IMP-08: minimum-one-probe gate (RFC-0997) ─────────────────────────
  // Post-cutoff architecture/contract/command RFCs must declare at least one
  // acceptance probe. Policy and deprecation kinds are exempt.
  const rfcKind = String(fm["kind"] ?? "");
  const probeGateKinds = new Set(["architecture", "contract", "command"]);
  if (createdAtStr >= RFC_PROBE_BINDING_CUTOFF && probeGateKinds.has(rfcKind) && !hasProbes) {
    violations.push({
      rule: "RFC-IMP-08",
      message: `RFC ${targetId} (kind: ${rfcKind}) has no acceptance probes. Post-cutoff architecture/contract/command RFCs require at least one probe (RFC-0997). See RFC-0996 for the authoring standard.`,
    });
  }

  // If any violations found, return without mutation
  if (violations.length > 0) {
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── RFC-IMP-05: acquire RFC-specific exclusive lock ───────────────────────
  // Under --check-criteria the lock must precede the FIRST write — which is
  // the emit-if-needed envelope refresh, not the stamp mutation — so all
  // envelope-independent gates above abort before this point.
  const { acquired, lockPath } = await acquireRfcLock(workspaceRoot, targetId);
  if (!acquired) {
    violations.push({
      rule: "RFC-IMP-05",
      message: `A concurrent stamp operation is in progress for ${targetId}. Wait for it to complete and retry.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  try {
    // ── Atomic mutation ──────────────────────────────────────────────────────
    const rfcSource = await io.readFile(rfcFilePath);
    // RFC-1322: the mutation-bound source — under --check-criteria it carries
    // the auto-check flips; without the flag it is the committed file text.
    let stampSource = rfcSource;
    let criteriaAutoChecked: string[] | undefined;
    let criteriaPendingRefresh: string[] = [];
    let evidenceWouldRefresh = false;
    let effectiveCriteriaChecked = criteriaEval.totalChecked;

    if (checkCriteria) {
      // Emit-if-needed (RFC-1322 order step 4): a missing, malformed, or
      // hash-stale envelope is refreshed in-process through the same direct
      // runRfcVerificationEmit call the post-stamp re-emit uses — on the
      // committed bytes, so IMP-09 keeps evaluating a real file state. The
      // freshness precheck (RFC-1320) gates this emit exactly as a manual one.
      const needsEmit = hasProbes && envelopeNeedsRefresh(evidenceCheck, rfcSource, acceptance);
      evidenceWouldRefresh = needsEmit;
      if (needsEmit && !isDryRun) {
        let emitOk = false;
        let emitSummary = "";
        try {
          const emitResult = await runRfcVerificationEmit(
            { argv: [], flags: { id: targetId } },
            context,
          );
          emitOk = emitResult.exitCode === 0;
          emitSummary = emitResult.summary ?? "";
        } catch (emitErr) {
          violations.push({
            rule: "EVIDENCE-SYNC-02",
            message: `pre-stamp evidence emit for ${targetId} threw: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}. Resolve the failing step and re-run the stamp.`,
          });
          return stampFailResult(violations, isDryRun, outputFormat, logger);
        }
        if (!emitOk) {
          violations.push({
            rule: "EVIDENCE-SYNC-02",
            message: `pre-stamp evidence emit for ${targetId} failed${emitSummary ? `: ${emitSummary}` : ""}. Resolve the failing step and re-run the stamp.`,
          });
          return stampFailResult(violations, isDryRun, outputFormat, logger);
        }
        logger.info(`[rfc.implement.stamp] --check-criteria: refreshed stale/missing envelope`);
        evidenceCheck = await checkExistingEvidence(workspaceRoot, targetId);
      }

      // Auto-check pass (RFC-1322 order step 5, in-memory): each unchecked
      // criterion resolves its (evidence: ...) annotation; unresolvable ones
      // abort before any RFC mutation. In dry-run with a pending refresh the
      // probe: annotations are not yet resolvable — pending, not failures.
      const auto = await autoCheckCriteria({
        uncheckedLines: criteriaEval.uncheckedLines,
        envelope: evidenceCheck.envelope,
        probesUsable: !(isDryRun && needsEmit),
        workspaceRoot,
      });
      criteriaAutoChecked = auto.flippedIds;
      criteriaPendingRefresh = auto.pendingRefresh.map(criterionLabelOf);
      if (auto.failures.length > 0) {
        violations.push({
          rule: "STAMP-CHECK-01",
          message:
            `${auto.failures.length} unchecked acceptance criteria lack resolvable (evidence: ...) annotations — ` +
            `supply a resolvable reference (test:<path>, file:<path>, <path>:<line>, or probe:AC-N bound to a passing envelope probe): ` +
            auto.failures.map((f) => `${f.criterion} [${f.annotation}]`).join("; "),
        });
      }

      if (auto.flippable.length > 0) {
        stampSource = flipCriteriaInSource(rfcSource, new Set(auto.flippable));
      }

      // Post-flip criteria gates on the mutation-bound bytes (step 6): a
      // still-unchecked line means the flip failed to land — fail closed
      // rather than write a partially checked document; checked lines must
      // keep their annotation (a flipped line always does). Dry-run pending
      // criteria (probe: awaiting the skipped emit) are excluded — the real
      // run resolves them against the refreshed envelope.
      const pendingSet = new Set(auto.pendingRefresh);
      const postFlipEval = evaluateAcceptanceCriteria(stampSource);
      const residualUnchecked = postFlipEval.uncheckedLines.filter((l) => !pendingSet.has(l));
      if (residualUnchecked.length > 0) {
        violations.push({
          rule: "RFC-IMP-02",
          message: `${residualUnchecked.length} acceptance criteria remain unchecked after the --check-criteria pass: ${residualUnchecked.join("; ")}`,
        });
      }
      if (postFlipEval.checkedWithoutEvidence.length > 0) {
        violations.push({
          rule: "RFC-IMP-02",
          message: `${postFlipEval.checkedWithoutEvidence.length} checked criteria lack inline (evidence: ...) annotation: ${postFlipEval.checkedWithoutEvidence.join("; ")}`,
        });
      }
      effectiveCriteriaChecked = postFlipEval.totalChecked;

      // IMP-06 + IMP-09 against the (possibly just-refreshed) envelope —
      // skipped in dry-run when a refresh would run, since committed-bytes
      // verdicts are not predictive of the post-emit state the real stamp
      // evaluates.
      if (!(isDryRun && needsEmit)) {
        if (requiresEvidence) {
          if (!evidenceCheck.exists || evidenceCheck.overall !== "pass") {
            violations.push({
              rule: "RFC-IMP-06",
              message: `RFC ${targetId} declares acceptance probes but evidence file is missing or overall is not "pass" (got "${evidenceCheck.overall}"). Run: site-kernel run rfc.verification.emit --id ${targetId}`,
            });
          } else {
            const slug = targetId.toLowerCase();
            evidenceRelPath = join(VERIFICATION_DIR, `${slug}.generated.yaml`);
          }
        }
        if (evidenceCheck.exists) {
          if (evidenceCheck.malformed || !evidenceCheck.envelope) {
            violations.push({
              rule: "RFC-IMP-09",
              message: `RFC ${targetId} evidence envelope is malformed (unreadable YAML or non-object content). Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope — or delete the stale envelope file.`,
            });
          } else if (!hasProbes) {
            violations.push({
              rule: "RFC-IMP-09",
              message: `RFC ${targetId} has a committed evidence envelope but no acceptance: list — probes were deleted after emission, which is a criteria change. Either restore the probes and re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope — or delete the stale envelope file (rfc.verification.emit skips probe-less RFCs, so re-emit alone cannot clear this).`,
            });
          } else {
            const rfcMarkdown = await io.readFile(rfcFilePath);
            const currentFileHash = byteHashHex(rfcMarkdown);
            const currentAcceptanceHash = byteHashHex(
              normalizeProbes(acceptance as AcceptanceProbe[]),
            );
            const env = evidenceCheck.envelope;
            if (!env.rfcFileHash || !env.acceptanceHash) {
              violations.push({
                rule: "RFC-IMP-09",
                message: `RFC ${targetId} evidence envelope lacks hash fields (pre-RFC-0330 format). Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope.`,
              });
            } else if (
              env.rfcFileHash !== currentFileHash ||
              env.acceptanceHash !== currentAcceptanceHash
            ) {
              const staleFields = [
                env.rfcFileHash !== currentFileHash ? "rfcFileHash" : "",
                env.acceptanceHash !== currentAcceptanceHash ? "acceptanceHash" : "",
              ]
                .filter(Boolean)
                .join(" + ");
              violations.push({
                rule: "RFC-IMP-09",
                message: `RFC ${targetId} evidence is stale: ${staleFields} mismatch — the RFC file or its acceptance list changed after emission. Re-run: site-kernel run rfc.verification.emit --id ${targetId}, then commit the envelope.`,
              });
            }
          }
        }
      }

      if (violations.length > 0) {
        return stampFailResult(violations, isDryRun, outputFormat, logger);
      }
    }

    const today = toIsoDate(new Date());
    const stampedAt = new Date().toISOString();
    const mutatedSource = mutateFrontmatter(stampSource, "implemented", today, today);

    if (isDryRun) {
      if (outputFormat === "pretty") {
        logger.success(`[dry-run] ${targetId} would be stamped as implemented`);
        logger.info(`  implementation commit: ${implementationCommit}`);
        logger.info(`  criteria checked: ${effectiveCriteriaChecked}`);
        if (criteriaAutoChecked && criteriaAutoChecked.length > 0) {
          logger.info(`  criteria auto-checked: ${criteriaAutoChecked.join(", ")}`);
        }
        if (criteriaPendingRefresh.length > 0) {
          logger.info(`  criteria pending envelope refresh: ${criteriaPendingRefresh.join(", ")}`);
        }
        if (evidenceWouldRefresh) {
          logger.info(`  evidence envelope would be refreshed (missing or stale)`);
        }
        if (evidenceRelPath) {
          logger.info(`  evidence: ${evidenceRelPath}`);
        }
      }
      return {
        data: {
          command: "rfc.implement.stamp",
          status: "pass",
          data: {
            rfcId: targetId,
            implementationCommit: implementationCommit!,
            stampedAt,
            criteriaChecked: effectiveCriteriaChecked,
            ...(checkCriteria ? { criteriaAutoChecked: criteriaAutoChecked ?? [] } : {}),
            ...(evidenceRelPath ? { evidencePath: evidenceRelPath } : {}),
          },
          violations: [],
        },
        exitCode: 0,
        summary: `rfc.implement.stamp: dry-run — ${targetId} would be stamped`,
      };
    }

    // Write the mutated RFC file atomically — under --check-criteria this
    // single write carries the checkbox flips AND the frontmatter mutation.
    await writeFileAtomic(rfcFilePath, mutatedSource);

    // ── RFC-1053: Generate per-RFC metrics (non-fatal, guarded by !isDryRun) ─
    let metricsPath: string | undefined;
    if (!isDryRun) {
      try {
        metricsPath = await generateRfcMetrics(workspaceRoot, targetId, logger);
      } catch (metricsErr) {
        logger.warn(
          `[metrics] Failed to generate metrics for ${targetId}: ${(metricsErr as Error).message}`,
        );
      }
    }

    // ── RFC-1271: post-stamp evidence re-emit ────────────────────────────────
    // The frontmatter mutation above changes the bytes RFC-IMP-09 binds via
    // rfcFileHash — without re-emission every successful stamp manufactures a
    // stale envelope. Re-emit inside the stamp for probe-bearing RFCs so the
    // committed envelope describes the implemented-state file. Non-fatal:
    // the mutation is already written; a failed re-emit leaves a stale
    // envelope the operator re-emits manually.
    let evidenceReEmitted = false;
    if (hasProbes) {
      try {
        const emitResult = await runRfcVerificationEmit(
          { argv: [], flags: { id: targetId } },
          context,
        );
        evidenceReEmitted = emitResult.exitCode === 0;
        if (evidenceReEmitted) {
          evidenceRelPath = join(VERIFICATION_DIR, `${targetId.toLowerCase()}.generated.yaml`);
        } else {
          logger.warn(
            `[evidence] post-stamp re-emit failed for ${targetId} — re-run: site-kernel run rfc.verification.emit --id ${targetId}`,
          );
        }
      } catch (emitErr) {
        logger.warn(
          `[evidence] post-stamp re-emit failed for ${targetId}: ${(emitErr as Error).message}`,
        );
      }
    }

    if (outputFormat === "pretty") {
      logger.success(`${targetId} stamped as implemented`);
      logger.info(`  implementation commit: ${implementationCommit}`);
      logger.info(`  criteria checked: ${effectiveCriteriaChecked}`);
      if (criteriaAutoChecked && criteriaAutoChecked.length > 0) {
        logger.info(`  criteria auto-checked: ${criteriaAutoChecked.join(", ")}`);
      }
      if (evidenceRelPath) {
        logger.info(`  evidence: ${evidenceRelPath}`);
      }
      logger.info(`  stamped at: ${stampedAt}`);
    }

    return {
      data: {
        command: "rfc.implement.stamp",
        status: "pass",
        data: {
          rfcId: targetId,
          implementationCommit: implementationCommit!,
          stampedAt,
          criteriaChecked: effectiveCriteriaChecked,
          ...(checkCriteria ? { criteriaAutoChecked: criteriaAutoChecked ?? [] } : {}),
          ...(evidenceRelPath ? { evidencePath: evidenceRelPath } : {}),
          ...(hasProbes ? { evidenceReEmitted } : {}),
          ...(metricsPath ? { metricsPath } : {}),
        },
        violations: [],
      },
      exitCode: 0,
      summary: `rfc.implement.stamp: ${targetId} stamped as implemented`,
      nextSteps: [
        {
          action: `Commit the stamp: pnpm exec forge run ecosystem.commit`,
          kind: "optional",
        },
      ],
    };
  } finally {
    await releaseRfcLock(lockPath);
  }
}

function stampFailResult(
  violations: RfcImplementStampViolation[],
  isDryRun: boolean,
  outputFormat: string,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): ForgeCommandResult<RfcImplementStampResult> {
  const prefix = isDryRun ? "[dry-run] " : "";
  if (outputFormat === "pretty") {
    for (const v of violations) {
      logger.warn(`${prefix}${v.rule}: ${v.message}`);
    }
  }
  return {
    data: {
      command: "rfc.implement.stamp",
      status: "fail",
      violations,
    },
    exitCode: 1,
    summary: `${prefix}rfc.implement.stamp: ${violations.length} violation${violations.length === 1 ? "" : "s"}`,
  };
}
