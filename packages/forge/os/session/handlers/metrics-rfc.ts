/*
<MODULE_CONTRACT>
<purpose>
RFC-1053: Generate per-RFC skill effectiveness metrics as structured YAML.
Reconstructs the RFC pipeline (audit, enhance, plan, implement, review, fix)
from git commit history, review reports, and verification evidence.
Writes to docs/metrics/rfcs/<rfc-id>.metrics.yaml via writeFileAtomic.
</purpose>
<non-goals>
  <item>Does not execute kernel commands — reads existing artifacts only.</item>
  <item>Does not extract quantitative results from acceptance criteria.</item>
  <item>Does not block the stamp on metrics failure — caller wraps in try/catch.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1053: initial generateRfcMetrics pure function.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { METRICS_DIR, type RfcMetrics, type RfcPipelineStep, type ReviewMetrics, type FixMetrics, type VerificationMetrics, type ResultMetrics, type RfcTimings } from "../types.ts";

// ─── Git helper ──────────────────────────────────────────────────────────────

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

// ─── Pipeline step classification ────────────────────────────────────────────

const STEP_PREFIXES: Record<string, { step: string; skill: string | null }> = {
  "audit:": { step: "audit", skill: "fo-idea-audit" },
  "enhance:": { step: "enhance", skill: "fo-idea-enhance" },
  "plan:": { step: "plan", skill: "fo-idea-plan" },
  "implement:": { step: "implement", skill: "fo-idea-implement" },
  "review:": { step: "review", skill: "fo-review" },
  "fix:": { step: "fix", skill: "fo-fix" },
  "evidence:": { step: "evidence", skill: null },
  "test:": { step: "test", skill: null },
  "docs:": { step: "docs", skill: null },
  "trace:": { step: "trace", skill: null },
};

interface GitLogEntry {
  sha: string;
  message: string;
  timestamp: string;
}

async function getRfcCommits(workspaceRoot: string, rfcId: string): Promise<GitLogEntry[]> {
  const format = "%H%x1f%B%x1f%cI";
  const raw = await execGit(workspaceRoot, [
    "log",
    "--no-merges",
    `--grep=${rfcId}`,
    `--format=${format}`,
  ]);
  if (!raw) return [];

  const entries: GitLogEntry[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const parts = line.split("\x1f");
    if (parts.length >= 3) {
      entries.push({
        sha: parts[0]!.trim(),
        message: parts[1]!.trim(),
        timestamp: parts[2]!.trim(),
      });
    }
  }
  return entries;
}

function classifyCommit(message: string): { step: string; skill: string | null } | null {
  const firstLine = message.split("\n")[0] ?? "";
  for (const [prefix, mapping] of Object.entries(STEP_PREFIXES)) {
    if (firstLine.startsWith(prefix)) {
      return mapping;
    }
  }
  return null;
}

// ─── Review report parsing ───────────────────────────────────────────────────

async function findReviewReport(workspaceRoot: string, rfcId: string): Promise<string | null> {
  const reviewDir = join(workspaceRoot, "docs", "reviews", "code");
  let files: string[];
  try {
    files = await readdir(reviewDir, { recursive: true });
  } catch {
    return null;
  }

  const rfcLower = rfcId.toLowerCase();
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    if (file.toLowerCase().includes(rfcLower)) {
      try {
        const content = await readFile(join(reviewDir, file), "utf-8");
        return content;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function parseReviewReport(content: string): ReviewMetrics {
  const findingsByAxis: Record<string, number> = {};
  let findingsCount = 0;
  let verdict: string | null = null;

  const verdictMatch = content.match(/##\s*Verdict[:\s]+(.+)/i);
  if (verdictMatch) {
    verdict = verdictMatch[1]!.trim().toLowerCase();
  }

  const axisRegex = /##\s*Axis\s+[A-Z]\s*—\s*(.+)/gi;
  let match;
  while ((match = axisRegex.exec(content)) !== null) {
    const axisName = match[1]!.trim();
    const sectionStart = match.index! + match[0].length;
    const nextAxisMatch = content.slice(sectionStart).match(/##\s*Axis\s+[A-Z]\s*—/i);
    const sectionEnd = nextAxisMatch ? sectionStart + nextAxisMatch.index! : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const failMatches = section.match(/\*\*FAIL\*\*/g);
    const failCount = failMatches ? failMatches.length : 0;
    if (failCount > 0) {
      findingsByAxis[axisName] = failCount;
      findingsCount += failCount;
    }
  }

  return { findingsCount, findingsByAxis, verdict };
}

// ─── Verification evidence parsing ───────────────────────────────────────────

async function parseVerificationEvidence(
  workspaceRoot: string,
  rfcId: string,
): Promise<VerificationMetrics | null> {
  const rfcNum = rfcId.replace(/^RFC-/, "").toLowerCase();
  const evidencePath = join(workspaceRoot, "docs", "rfcs", "verification", `rfc-${rfcNum}.generated.yaml`);
  let content: string;
  try {
    content = await readFile(evidencePath, "utf-8");
  } catch {
    return null;
  }

  try {
    const data = yamlParse(content) as Record<string, unknown>;
    const probes = Array.isArray(data["probes"]) ? (data["probes"] as Array<Record<string, unknown>>) : [];
    const probesTotal = probes.length;
    const probesPassed = probes.filter((p) => p["ok"] === true).length;
    return {
      probesTotal,
      probesPassed,
      evidencePath: `docs/rfcs/verification/rfc-${rfcNum}.generated.yaml`,
    };
  } catch {
    return null;
  }
}

// ─── Acceptance criteria parsing ─────────────────────────────────────────────

async function parseAcceptanceCriteria(
  workspaceRoot: string,
  rfcId: string,
): Promise<ResultMetrics> {
  const rfcDir = join(workspaceRoot, "docs", "rfcs");
  let files: string[];
  try {
    files = await readdir(rfcDir);
  } catch {
    return { acceptanceCriteriaTotal: 0, acceptanceCriteriaMet: 0 };
  }

  const rfcLower = rfcId.toLowerCase();
  const rfcFile = files.find((f) => f.toLowerCase().startsWith(rfcLower + "-") || f.toLowerCase().startsWith(rfcLower + "_"));
  if (!rfcFile) {
    return { acceptanceCriteriaTotal: 0, acceptanceCriteriaMet: 0 };
  }

  let content: string;
  try {
    content = await readFile(join(rfcDir, rfcFile), "utf-8");
  } catch {
    return { acceptanceCriteriaTotal: 0, acceptanceCriteriaMet: 0 };
  }

  const acSectionMatch = content.match(/##\s*Acceptance\s+criteria[\s\S]*?(?=\n##\s|$)/i);
  if (!acSectionMatch) {
    return { acceptanceCriteriaTotal: 0, acceptanceCriteriaMet: 0 };
  }

  const acSection = acSectionMatch[0]!;
  const totalMatches = acSection.match(/-\s*\[x\]/gi);
  const uncheckedMatches = acSection.match(/-\s*\[\s\]/g);
  const acceptanceCriteriaMet = totalMatches ? totalMatches.length : 0;
  const acceptanceCriteriaUnmet = uncheckedMatches ? uncheckedMatches.length : 0;
  return {
    acceptanceCriteriaTotal: acceptanceCriteriaMet + acceptanceCriteriaUnmet,
    acceptanceCriteriaMet,
  };
}

// ─── Fix metrics parsing ─────────────────────────────────────────────────────

function extractFixMetrics(commits: GitLogEntry[]): FixMetrics | null {
  const fixCommits = commits.filter((c) => c.message.split("\n")[0]!.startsWith("fix:"));
  if (fixCommits.length === 0) return null;
  return {
    fixesApplied: fixCommits.length,
    commitSha: fixCommits[fixCommits.length - 1]!.sha,
    iterations: fixCommits.length,
  };
}

// ─── Timings ─────────────────────────────────────────────────────────────────

function computeTimings(commits: GitLogEntry[]): RfcTimings {
  if (commits.length === 0) {
    return { firstCommitAt: null, lastCommitAt: null, totalDurationMs: null };
  }
  const sorted = [...commits].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const durationMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  return {
    firstCommitAt: first.timestamp,
    lastCommitAt: last.timestamp,
    totalDurationMs: isNaN(durationMs) ? null : durationMs,
  };
}

// ─── Main function ───────────────────────────────────────────────────────────

export async function generateRfcMetrics(
  workspaceRoot: string,
  rfcId: string,
  logger: { warn: (msg: string) => void },
): Promise<string> {
  const commits = await getRfcCommits(workspaceRoot, rfcId);

  const pipeline: RfcPipelineStep[] = [];
  for (const commit of commits) {
    const classified = classifyCommit(commit.message);
    if (classified) {
      pipeline.push({
        step: classified.step,
        skill: classified.skill,
        commitSha: commit.sha,
        timestamp: commit.timestamp,
      });
    }
  }

  let review: ReviewMetrics | null = null;
  try {
    const reviewContent = await findReviewReport(workspaceRoot, rfcId);
    if (reviewContent) {
      review = parseReviewReport(reviewContent);
    }
  } catch {
    logger.warn(`[metrics] Could not parse review report for ${rfcId}`);
  }

  if (!review) {
    review = { findingsCount: 0, findingsByAxis: {}, verdict: null };
  }

  const fix = extractFixMetrics(commits);
  const verification = await parseVerificationEvidence(workspaceRoot, rfcId);
  const result = await parseAcceptanceCriteria(workspaceRoot, rfcId);
  const timings = computeTimings(commits);

  const metrics: RfcMetrics = {
    rfcId,
    generatedAt: new Date().toISOString(),
    pipeline,
    review,
    fix,
    verification,
    result,
    timings,
  };

  const yamlContent = yamlStringify(metrics, { lineWidth: 120 });
  const metricsFilePath = join(workspaceRoot, METRICS_DIR, "rfcs", `${rfcId.toLowerCase()}.metrics.yaml`);
  await mkdir(dirname(metricsFilePath), { recursive: true });
  await writeFileAtomic(metricsFilePath, yamlContent);

  return `${METRICS_DIR}/rfcs/${rfcId.toLowerCase()}.metrics.yaml`;
}
