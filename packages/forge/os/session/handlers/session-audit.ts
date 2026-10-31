/*
<MODULE_CONTRACT>
<purpose>
RFC-1471: session.audit — deterministic Stage-A detectors over docs/sessions/*.md.
AUDIT-01 denied-retry (rejection line, same command retried), AUDIT-02 blocker
omission (blocking failure evidence but empty remainingIssues/blockers),
AUDIT-03 generated-file edit (direct write to *.generated.*), AUDIT-04 denied
command retried without declared plan change, AUDIT-05 false completion claim
("all green/committed" contradicted by adjacent exit-1 evidence). Writes the
sidecar docs/sessions/audit/<id>.audit.yaml.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1471: session.audit deterministic Stage-A detectors + sidecar write</item>
  <item>RFC-1471: session.audit Stage-A detectors + audit.report read-model — denied-retry, blocker omission, generated-edit, retry-after-denial, false-claim</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface AuditFinding {
  ruleId: "AUDIT-01" | "AUDIT-02" | "AUDIT-03" | "AUDIT-04" | "AUDIT-05";
  severity: "warning" | "error";
  detail: string;
}

export interface SessionAuditData {
  command: "session.audit";
  sessionId: string;
  status: "clean" | "findings";
  findings: AuditFinding[];
  sidecar: string;
}

const DENIED_RE = /\b(rejected|denied|refused|not permitted|blocked by)\b/i;
const FAILURE_RE = /\b(exit[:\s]*[1-9]|BLOCKED|failed|fatal error)\b/i;
const CLAIM_RE = /\b(all green|all tests pass|committed successfully|everything works|done and dusted|fully (verified|working))\b/i;
const GENERATED_RE = /(?:^|\/)[^\s`]*\.generated\.(?:yaml|yml|json|ts|tsx|md|astro)\b/;
const CMD_RE = /(?:werkstatt|site-kernel|forge)\s+run\s+([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)/g;

function lastCommandBefore(lines: string[], i: number): string | null {
  // The denied command usually sits ON the denial line — start at i, scan back.
  for (let j = i; j >= Math.max(0, i - 30); j--) {
    const m = [...lines[j]!.matchAll(CMD_RE)];
    if (m.length > 0) return m[m.length - 1]![1]!;
  }
  return null;
}

function commandAfter(lines: string[], i: number): string | null {
  for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
    const m = [...lines[j]!.matchAll(CMD_RE)];
    if (m.length > 0) return m[0]![1]!;
  }
  return null;
}

export function auditSessionBody(id: string, body: string, frontmatter: Record<string, unknown>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = body.split("\n");

  // AUDIT-01: a denied/rejected line followed by a retry of the same command.
  for (let i = 0; i < lines.length; i++) {
    if (!DENIED_RE.test(lines[i]!)) continue;
    const denied = lastCommandBefore(lines, i);
    const retried = commandAfter(lines, i);
    if (denied !== null && denied === retried) {
      findings.push({
        ruleId: "AUDIT-01",
        severity: "warning",
        detail: `${id}: line ${i + 1} records a denial/rejection of "${denied}" and the same command is retried within the next lines — circumvention signal`,
      });
    }
  }

  // AUDIT-04: a retry within ~10 lines of a denial, absent an explicit plan-change marker.
  const planChange = /\b(new plan|plan change|revised approach|alternative|instead)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!DENIED_RE.test(lines[i]!)) continue;
    const window = lines.slice(i + 1, i + 12);
    const retried = commandAfter(lines, i);
    const denied = lastCommandBefore(lines, i);
    if (denied === retried && retried !== null && !planChange.test(window.join("\n"))) {
      findings.push({
        ruleId: "AUDIT-04",
        severity: "error",
        detail: `${id}: "${retried}" retried after a denial without a declared plan change — retry-after-denial is a circumvention class`,
      });
    }
  }

  // AUDIT-02: blocking failure evidence in the body but empty remainingIssues/blockers.
  const remaining = (frontmatter.remainingIssues as unknown[] | undefined) ?? [];
  const blockers = (frontmatter.blockers as unknown[] | undefined) ?? [];
  const hasFailure = lines.some((l) => FAILURE_RE.test(l));
  if (hasFailure && remaining.length === 0 && blockers.length === 0) {
    findings.push({
      ruleId: "AUDIT-02",
      severity: "error",
      detail: `${id}: transcript records blocking failures but remainingIssues/blockers are empty — blocker omission`,
    });
  }

  // AUDIT-03: direct edit to a generated file (edit/write mention of *.generated.*).
  for (let i = 0; i < lines.length; i++) {
    if (!/(edit|write|modif|patch|fix)/i.test(lines[i]!)) continue;
    const m = lines[i]!.match(GENERATED_RE);
    if (m) {
      findings.push({
        ruleId: "AUDIT-03",
        severity: "error",
        detail: `${id}: line ${i + 1} records a direct write to generated artifact "${m[0]}" — generated files are regeneration-only`,
      });
    }
  }

  // AUDIT-05: a completion claim contradicted by adjacent failure evidence.
  for (let i = 0; i < lines.length; i++) {
    if (!CLAIM_RE.test(lines[i]!)) continue;
    const window = lines.slice(Math.max(0, i - 8), i + 9).join("\n");
    if (FAILURE_RE.test(window.replace(lines[i]!, ""))) {
      findings.push({
        ruleId: "AUDIT-05",
        severity: "warning",
        detail: `${id}: line ${i + 1} claims completion ("${lines[i]!.trim().slice(0, 60)}") with adjacent failure evidence — unverified-claim signal`,
      });
    }
  }
  return findings;
}

export async function runSessionAudit(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionAuditData[]>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const sessionsDir = path.join(root, "docs", "sessions");
  const idFilter = (input.flags["id"] ?? input.argv?.[0]) as string | undefined;

  const entries = await io.readdir(sessionsDir).catch(() => [] as { name: string; isDirectory: boolean }[]);
  const sessions = entries.filter((e) => !e.isDirectory && e.name.endsWith(".md") && (!idFilter || e.name.includes(idFilter)));
  if (sessions.length === 0) {
    return { data: [], summary: "no sessions found", exitCode: 1 };
  }

  const results: SessionAuditData[] = [];
  const auditDir = path.join(sessionsDir, "audit");
  await io.mkdir(auditDir).catch(() => {});

  for (const s of sessions) {
    const src = await io.readFile(path.join(sessionsDir, s.name)).catch(() => null);
    if (src === null) continue;
    const fmMatch = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const frontmatter = (fmMatch ? (yamlParse(fmMatch[1]!) as Record<string, unknown>) : {}) ?? {};
    const body = fmMatch?.[2] ?? src;
    const id = String(frontmatter.id ?? s.name.replace(/\.md$/, ""));
    const findings = auditSessionBody(id, body, frontmatter);
    const sidecarRel = `docs/sessions/audit/${id}.audit.yaml`;
    await io.writeFile(
      path.join(root, sidecarRel),
      yamlStringify({
        schema: "forge/session-audit@1",
        sessionId: id,
        auditedAt: new Date().toISOString(),
        stage: "A",
        findings,
        verdict: findings.some((f) => f.severity === "error") ? "violations" : findings.length > 0 ? "warnings" : "clean",
      }) + "\n",
    );
    results.push({
      command: "session.audit",
      sessionId: id,
      status: findings.length > 0 ? "findings" : "clean",
      findings,
      sidecar: sidecarRel,
    });
  }

  const errors = results.reduce((n, r) => n + r.findings.filter((f) => f.severity === "error").length, 0);
  const check = input.flags["check"] === true;
  if (context.outputFormat === "pretty") {
    for (const r of results) {
      const fn = r.findings.some((f) => f.severity === "error") ? context.logger.error : r.findings.length > 0 ? context.logger.warn : context.logger.success;
      fn(`${r.sessionId}: ${r.findings.length} finding(s) → ${r.sidecar}`);
    }
  }
  return {
    data: results,
    summary: `${results.length} session(s) audited: ${errors} error finding(s)`,
    exitCode: check && errors > 0 ? 1 : 0,
  };
}
