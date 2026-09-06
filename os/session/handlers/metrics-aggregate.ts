/*
<MODULE_CONTRACT>
<purpose>
RFC-1053: metrics.aggregate command handler — scans docs/metrics/ files and
produces per-skill statistics (invocations, avgFindings, avgFixIterations,
avgDurationMs). Supports --skill, --since, --until filters. Returns empty
result when no metrics files exist.
</purpose>
<non-goals>
  <item>Does not write files — read-only aggregation.</item>
  <item>Does not index metrics files — scans on each invocation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1053: initial metrics.aggregate command handler.</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { METRICS_DIR, type MetricsAggregateResult, type SkillAggregate, type RfcMetrics, type SessionMetrics } from "../types.ts";
import type { ForgeCommandInput, ForgeCommandResult, ForgeRuntimeContext } from "../../../src/types.ts";

async function readYamlFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return yamlParse(content) as T;
  } catch {
    return null;
  }
}

export async function runMetricsAggregate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<MetricsAggregateResult>> {
  const { workspaceRoot, outputFormat } = context;
  const skillFilter = input.flags["skill"] as string | undefined;
  const since = input.flags["since"] as string | undefined;
  const until = input.flags["until"] as string | undefined;

  const rfcMetricsDir = join(workspaceRoot, METRICS_DIR, "rfcs");
  const sessionMetricsDir = join(workspaceRoot, METRICS_DIR, "sessions");

  let rfcFiles: string[] = [];
  let sessionFiles: string[] = [];

  try {
    rfcFiles = await readdir(rfcMetricsDir);
  } catch {
    // No RFC metrics directory yet
  }

  try {
    sessionFiles = await readdir(sessionMetricsDir);
  } catch {
    // No session metrics directory yet
  }

  const rfcMetricsList: RfcMetrics[] = [];
  for (const file of rfcFiles) {
    if (!file.endsWith(".metrics.yaml")) continue;
    const metrics = await readYamlFile<RfcMetrics>(join(rfcMetricsDir, file));
    if (metrics) rfcMetricsList.push(metrics);
  }

  const sessionMetricsList: SessionMetrics[] = [];
  for (const file of sessionFiles) {
    if (!file.endsWith(".metrics.yaml")) continue;
    const metrics = await readYamlFile<SessionMetrics>(join(sessionMetricsDir, file));
    if (metrics) sessionMetricsList.push(metrics);
  }

  // Apply date filters
  const sinceDate = since ? new Date(since) : null;
  const untilDate = until ? new Date(until) : null;

  const filteredRfcs = rfcMetricsList.filter((m) => {
    if (!m.generatedAt) return true;
    const d = new Date(m.generatedAt);
    if (isNaN(d.getTime())) return true;
    if (sinceDate && d < sinceDate) return false;
    if (untilDate && d > untilDate) return false;
    return true;
  });

  const filteredSessions = sessionMetricsList.filter((m) => {
    if (!m.generatedAt) return true;
    const d = new Date(m.generatedAt);
    if (isNaN(d.getTime())) return true;
    if (sinceDate && d < sinceDate) return false;
    if (untilDate && d > untilDate) return false;
    return true;
  });

  // Aggregate per-skill
  const skillData = new Map<
    string,
    {
      invocations: number;
      findingsSum: number;
      findingsCount: number;
      fixIterationsSum: number;
      fixIterationsCount: number;
      durationSum: number;
      durationCount: number;
    }
  >();

  function recordSkill(skill: string, data: Partial<{
    findings: number;
    fixIterations: number;
    durationMs: number;
  }>) {
    let entry = skillData.get(skill);
    if (!entry) {
      entry = {
        invocations: 0,
        findingsSum: 0,
        findingsCount: 0,
        fixIterationsSum: 0,
        fixIterationsCount: 0,
        durationSum: 0,
        durationCount: 0,
      };
      skillData.set(skill, entry);
    }
    entry.invocations++;
    if (data.findings !== undefined) {
      entry.findingsSum += data.findings;
      entry.findingsCount++;
    }
    if (data.fixIterations !== undefined) {
      entry.fixIterationsSum += data.fixIterations;
      entry.fixIterationsCount++;
    }
    if (data.durationMs !== undefined) {
      entry.durationSum += data.durationMs;
      entry.durationCount++;
    }
  }

  // From RFC metrics: pipeline steps (skill invocations), review findings, fix iterations
  for (const rfc of filteredRfcs) {
    for (const step of rfc.pipeline) {
      if (step.skill) {
        recordSkill(step.skill, {});
      }
    }
    if (rfc.review && rfc.review.findingsCount !== undefined) {
      recordSkill("fo-review", { findings: rfc.review.findingsCount });
    }
    if (rfc.fix) {
      recordSkill("fo-fix", { fixIterations: rfc.fix.iterations });
    }
  }

  // From session metrics: skill invocations with durations
  for (const session of filteredSessions) {
    for (const inv of session.skills) {
      recordSkill(inv.skill, {
        durationMs: inv.approximateDurationMs ?? undefined,
      });
    }
  }

  let perSkill: SkillAggregate[] = [];
  for (const [skill, data] of skillData) {
    if (skillFilter && skill !== skillFilter) continue;
    perSkill.push({
      skill,
      invocations: data.invocations,
      avgFindings: data.findingsCount > 0 ? data.findingsSum / data.findingsCount : null,
      avgFixIterations: data.fixIterationsCount > 0 ? data.fixIterationsSum / data.fixIterationsCount : null,
      avgDurationMs: data.durationCount > 0 ? data.durationSum / data.durationCount : null,
    });
  }

  // Sort by invocations descending
  perSkill.sort((a, b) => b.invocations - a.invocations);

  if (skillFilter && perSkill.length === 0) {
    perSkill = [];
  }

  const result: MetricsAggregateResult = {
    command: "metrics.aggregate",
    status: "ok",
    skill: (skillFilter as string) ?? "all",
    since: since ?? null,
    until: until ?? null,
    perSkill,
    totalRfcs: filteredRfcs.length,
    totalSessions: filteredSessions.length,
  };

  if (outputFormat === "pretty") {
    context.logger.info(`[metrics.aggregate] ${perSkill.length} skill(s), ${filteredRfcs.length} RFC(s), ${filteredSessions.length} session(s)`);
  }

  return {
    data: result,
    exitCode: 0,
    summary: `[metrics.aggregate] ${perSkill.length} skill(s) across ${filteredRfcs.length} RFC(s) and ${filteredSessions.length} session(s)`,
  };
}
