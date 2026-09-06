import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { generateRfcMetrics } from "../../os/session/handlers/metrics-rfc.ts";
import { generateSessionMetrics } from "../../os/session/handlers/metrics-session.ts";
import { runMetricsAggregate } from "../../os/session/handlers/metrics-aggregate.ts";
import type { AtifMessage } from "../../os/session/atif-parser.ts";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeLogger } from "../../src/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const noopLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: noopLogger,
    dryRun: false,
    outputFormat: "json",
  };
}

function gitInit(workspaceRoot: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceRoot });
}

function gitCommit(workspaceRoot: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: workspaceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", message, "--allow-empty"], { cwd: workspaceRoot });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot }).toString().trim();
  return sha;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RFC-1053: generateRfcMetrics", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "metrics-rfc-XXXXXX-"));
    gitInit(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes metrics YAML to docs/metrics/rfcs/<rfc-id>.metrics.yaml", async () => {
    const rfcId = "RFC-9999";
    const rfcDir = join(tmpDir, "docs", "rfcs");
    await mkdir(rfcDir, { recursive: true });
    await writeFile(
      join(rfcDir, "rfc-9999-test.md"),
      `---
id: ${rfcId}
title: "Test RFC"
status: implemented
kind: architecture
scope: workspace
owners:
  - architecture
---

# ${rfcId}: Test RFC

## Acceptance criteria

- [x] Criterion 1 (evidence: test:foo)
- [x] Criterion 2 (evidence: test:bar)
- [ ] Criterion 3
`,
    );

    gitCommit(tmpDir, `audit: ${rfcId} — test audit`);
    gitCommit(tmpDir, `enhance: ${rfcId} — test enhance`);
    gitCommit(tmpDir, `plan: ${rfcId} — test plan`);
    gitCommit(tmpDir, `implement: ${rfcId} — test implement`);

    const metricsPath = await generateRfcMetrics(tmpDir, rfcId, noopLogger);

    expect(metricsPath).toBe("docs/metrics/rfcs/rfc-9999.metrics.yaml");
    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");
    expect(fileContent).toContain("rfcId: RFC-9999");
    expect(fileContent).toContain("pipeline:");
    expect(fileContent).toContain("step: audit");
    expect(fileContent).toContain("step: enhance");
    expect(fileContent).toContain("step: plan");
    expect(fileContent).toContain("step: implement");
    expect(fileContent).toContain("skill: fo-idea-audit");
    expect(fileContent).toContain("skill: fo-idea-implement");
  });

  it("classifies commit prefixes into pipeline steps with correct skills", async () => {
    const rfcId = "RFC-8888";
    const rfcDir = join(tmpDir, "docs", "rfcs");
    await mkdir(rfcDir, { recursive: true });
    await writeFile(
      join(rfcDir, "rfc-8888-test.md"),
      `---
id: ${rfcId}
title: "Test"
status: implemented
kind: architecture
scope: workspace
owners:
  - architecture
---

# ${rfcId}

## Acceptance criteria

- [x] AC1
`,
    );

    gitCommit(tmpDir, `review: ${rfcId} — code review`);
    gitCommit(tmpDir, `fix: ${rfcId} — fix issue`);

    const metricsPath = await generateRfcMetrics(tmpDir, rfcId, noopLogger);
    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");

    expect(fileContent).toContain("step: review");
    expect(fileContent).toContain("skill: fo-review");
    expect(fileContent).toContain("step: fix");
    expect(fileContent).toContain("skill: fo-fix");
  });

  it("handles RFC with no commits gracefully", async () => {
    const rfcId = "RFC-7777";
    const metricsPath = await generateRfcMetrics(tmpDir, rfcId, noopLogger);

    expect(metricsPath).toBe("docs/metrics/rfcs/rfc-7777.metrics.yaml");
    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");
    expect(fileContent).toContain("rfcId: RFC-7777");
    expect(fileContent).toContain("pipeline: []");
  });
});

describe("RFC-1053: generateSessionMetrics", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "metrics-session-XXXXXX-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts skill invocations from ATIF messages", async () => {
    const messages: AtifMessage[] = [
      { role: "user", timestamp: "2026-09-06T10:00:00Z", content: "Please run fo-idea-audit on RFC-1053" },
      { role: "assistant", timestamp: "2026-09-06T10:05:00Z", content: "Running fo-idea-audit now" },
      { role: "user", timestamp: "2026-09-06T10:10:00Z", content: "Now run fo-review" },
      { role: "assistant", timestamp: "2026-09-06T10:15:00Z", content: "Running fo-review" },
    ];

    const metricsPath = await generateSessionMetrics(
      tmpDir,
      "2026-09-06-10-00-00-abc123",
      messages,
      { date: "2026-09-06", relatedRfcs: ["RFC-1053"], commits: ["abc1234"] },
      noopLogger,
    );

    expect(metricsPath).toBe("docs/metrics/sessions/2026-09-06-10-00-00-abc123.metrics.yaml");
    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");
    expect(fileContent).toContain("sessionId: 2026-09-06-10-00-00-abc123");
    expect(fileContent).toContain("approximateDurations: true");
    expect(fileContent).toContain("fo-idea-audit");
    expect(fileContent).toContain("fo-review");
  });

  it("computes approximate duration from message timestamps", async () => {
    const messages: AtifMessage[] = [
      { role: "user", timestamp: "2026-09-06T10:00:00Z", content: "Run fo-review" },
      { role: "assistant", timestamp: "2026-09-06T10:30:00Z", content: "fo-review done" },
    ];

    const metricsPath = await generateSessionMetrics(
      tmpDir,
      "test-session-001",
      messages,
      { date: "2026-09-06" },
      noopLogger,
    );

    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");
    expect(fileContent).toContain("approximateDurationMs:");
    // 30 minutes = 1,800,000 ms
    expect(fileContent).toContain("1800000");
  });

  it("handles empty messages gracefully", async () => {
    const metricsPath = await generateSessionMetrics(
      tmpDir,
      "empty-session",
      [],
      { date: "2026-09-06" },
      noopLogger,
    );

    const fileContent = await readFile(join(tmpDir, metricsPath), "utf-8");
    expect(fileContent).toContain("sessionId: empty-session");
    expect(fileContent).toContain("skills: []");
  });
});

describe("RFC-1053: metrics.aggregate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "metrics-agg-XXXXXX-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result when no metrics files exist", async () => {
    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runMetricsAggregate(input, makeContext(tmpDir));

    expect(result.data?.status).toBe("ok");
    expect(result.data?.perSkill).toEqual([]);
    expect(result.data?.totalRfcs).toBe(0);
    expect(result.data?.totalSessions).toBe(0);
  });

  it("aggregates skill data from RFC and session metrics files", async () => {
    // Create RFC metrics
    const rfcMetricsDir = join(tmpDir, "docs", "metrics", "rfcs");
    await mkdir(rfcMetricsDir, { recursive: true });
    await writeFile(
      join(rfcMetricsDir, "rfc-9999.metrics.yaml"),
      `rfcId: RFC-9999
generatedAt: 2026-09-06T10:00:00Z
pipeline:
  - step: audit
    skill: fo-idea-audit
    commitSha: abc123
    timestamp: "2026-09-06T09:00:00Z"
  - step: implement
    skill: fo-idea-implement
    commitSha: def456
    timestamp: "2026-09-06T10:00:00Z"
review:
  findingsCount: 3
  findingsByAxis:
    Structural correctness: 2
    DNA alignment: 1
  verdict: approved
fix:
  fixesApplied: 2
  commitSha: ghi789
  iterations: 2
verification: null
result:
  acceptanceCriteriaTotal: 5
  acceptanceCriteriaMet: 5
timings:
  firstCommitAt: "2026-09-06T09:00:00Z"
  lastCommitAt: "2026-09-06T10:00:00Z"
  totalDurationMs: 3600000
`,
    );

    // Create session metrics
    const sessionMetricsDir = join(tmpDir, "docs", "metrics", "sessions");
    await mkdir(sessionMetricsDir, { recursive: true });
    await writeFile(
      join(sessionMetricsDir, "test-session.metrics.yaml"),
      `sessionId: test-session
generatedAt: 2026-09-06T11:00:00Z
date: "2026-09-06"
durationMs: 1800000
approximateDurations: true
documents:
  - rfcId: RFC-9999
    status: implemented
    metricsFile: docs/metrics/rfcs/rfc-9999.metrics.yaml
skills:
  - skill: fo-idea-audit
    approximateDurationMs: 300000
  - skill: fo-review
    approximateDurationMs: 600000
insights: null
commits:
  - abc123
`,
    );

    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runMetricsAggregate(input, makeContext(tmpDir));

    expect(result.data?.totalRfcs).toBe(1);
    expect(result.data?.totalSessions).toBe(1);

    const auditSkill = result.data?.perSkill.find((s) => s.skill === "fo-idea-audit");
    expect(auditSkill).toBeDefined();
    expect(auditSkill?.invocations).toBeGreaterThanOrEqual(1);

    const reviewSkill = result.data?.perSkill.find((s) => s.skill === "fo-review");
    expect(reviewSkill).toBeDefined();
    expect(reviewSkill?.avgFindings).toBe(3);
  });

  it("filters by skill name when --skill is provided", async () => {
    const rfcMetricsDir = join(tmpDir, "docs", "metrics", "rfcs");
    await mkdir(rfcMetricsDir, { recursive: true });
    await writeFile(
      join(rfcMetricsDir, "rfc-9999.metrics.yaml"),
      `rfcId: RFC-9999
generatedAt: 2026-09-06T10:00:00Z
pipeline:
  - step: audit
    skill: fo-idea-audit
    commitSha: abc123
    timestamp: "2026-09-06T09:00:00Z"
  - step: review
    skill: fo-review
    commitSha: def456
    timestamp: "2026-09-06T10:00:00Z"
review: null
fix: null
verification: null
result:
  acceptanceCriteriaTotal: 0
  acceptanceCriteriaMet: 0
timings:
  firstCommitAt: null
  lastCommitAt: null
  totalDurationMs: null
`,
    );

    const input: ForgeCommandInput = { argv: [], flags: { skill: "fo-review" } };
    const result = await runMetricsAggregate(input, makeContext(tmpDir));

    expect(result.data?.perSkill.length).toBe(1);
    expect(result.data?.perSkill[0]?.skill).toBe("fo-review");
  });
});
