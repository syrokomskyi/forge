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
  <item>RFC-1306: --sync flag runs rfc.evidence.sync via context.invoke before the stale-evidence gate; EVIDENCE-SYNC-01 when no kernel host, sync failure aborts before any mutation.</item>
  <item>RFC-1306: review-r1 — io-native writes, cacheable off on chain generators, EVIDENCE-SYNC-02 on invoke throws</item>
  <item>RFC-1310: governance-id parity guards on ecosystem.commit and rfc.implement.stamp</item>
  <item>RFC-1321: commitReferencesRfc compares case-insensitively — --id rfc-NNNN satisfies an RFC-NNNN subject (RFC-IMP-03 false-fail closed)</item>
  <item>RFC-1321: review-r2: stringLiteralValue — comment-aware literal extractor keys COMMAND_PROVENANCE cleanly (adjacent comments no longer corrupt the key or evade CMDGEN-03); (?!\d) boundary in commitCarriesGovernanceProvenance; non-string --id guard</item>
  <history>RFC-0268, RFC-0476, RFC-0756, RFC-0795, RFC-0997, RFC-1053, RFC-1097, RFC-1249, RFC-1271, RFC-IMP-07</history>
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
  const criteriaEval = evaluateAcceptanceCriteria(body);
  if (criteriaEval.totalUnchecked > 0) {
    violations.push({
      rule: "RFC-IMP-02",
      message: `${criteriaEval.totalUnchecked} acceptance criteria are unchecked. All criteria must be checked before stamping: ${criteriaEval.uncheckedLines.join("; ")}`,
    });
  }
  if (criteriaEval.checkedWithoutEvidence.length > 0) {
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
  const evidenceCheck = await checkExistingEvidence(workspaceRoot, targetId);

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

  // ── RFC-IMP-09: stale evidence gate (RFC-1271) ────────────────────────────
  // Hashes are recomputed from the working tree; combined with RFC-IMP-04
  // (the RFC file must be committed-clean to stamp) the compared bytes are
  // effectively the committed bytes — deliberate, keeps the gate honest
  // without a second git read. Fires before any frontmatter mutation.
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

    const today = toIsoDate(new Date());
    const stampedAt = new Date().toISOString();
    const mutatedSource = mutateFrontmatter(rfcSource, "implemented", today, today);

    if (isDryRun) {
      if (outputFormat === "pretty") {
        logger.success(`[dry-run] ${targetId} would be stamped as implemented`);
        logger.info(`  implementation commit: ${implementationCommit}`);
        logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
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
            criteriaChecked: criteriaEval.totalChecked,
            ...(evidenceRelPath ? { evidencePath: evidenceRelPath } : {}),
          },
          violations: [],
        },
        exitCode: 0,
        summary: `rfc.implement.stamp: dry-run — ${targetId} would be stamped`,
      };
    }

    // Write the mutated RFC file atomically
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
      logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
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
          criteriaChecked: criteriaEval.totalChecked,
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
