/*
<MODULE_CONTRACT>
<purpose>RFC-1471: session.audit.report — read-model over docs/sessions/audit/*.audit.yaml sidecars + frictions: per-rule frequency, sessions-with-findings, and whether an audit finding class has a friction on file.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1471: session.audit.report sidecar+friction read-model</item>
  <item>RFC-1471: session.audit Stage-A detectors + audit.report read-model — denied-retry, blocker omission, generated-edit, retry-after-denial, false-claim</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ReportData {
  command: "session.audit.report";
  status: "ok";
  sessionsAudited: number;
  verdicts: { clean: number; warnings: number; violations: number };
  byRule: { ruleId: string; count: number; sessions: string[] }[];
  unlinkedFindings: string[];
}

export async function runSessionAuditReport(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ReportData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const auditDir = path.join(root, "docs", "sessions", "audit");

  const entries = await io.readdir(auditDir).catch(() => [] as { name: string; isDirectory: boolean }[]);
  const byRule = new Map<string, { count: number; sessions: Set<string> }>();
  let clean = 0, warnings = 0, violations = 0;

  for (const e of entries) {
    if (e.isDirectory || !e.name.endsWith(".audit.yaml")) continue;
    const src = await io.readFile(path.join(auditDir, e.name)).catch(() => null);
    if (src === null) continue;
    const a = yamlParse(src) as { sessionId?: string; verdict?: string; findings?: { ruleId?: string }[] } | null;
    if (!a) continue;
    if (a.verdict === "violations") violations++;
    else if (a.verdict === "warnings") warnings++;
    else clean++;
    for (const f of a.findings ?? []) {
      if (!f.ruleId) continue;
      const g = byRule.get(f.ruleId) ?? { count: 0, sessions: new Set<string>() };
      g.count++;
      if (a.sessionId) g.sessions.add(a.sessionId);
      byRule.set(f.ruleId, g);
    }
  }

  // Findings classes with no friction on file — audit signal without a governed scar.
  const frictionsSrc = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
  const unlinkedFindings = [...byRule.keys()].filter((id) => !frictionsSrc.includes(id));

  return {
    data: {
      command: "session.audit.report",
      status: "ok",
      sessionsAudited: clean + warnings + violations,
      verdicts: { clean, warnings, violations },
      byRule: [...byRule.entries()].map(([ruleId, g]) => ({ ruleId, count: g.count, sessions: [...g.sessions] })).sort((a, b) => b.count - a.count),
      unlinkedFindings,
    },
    summary: `${clean + warnings + violations} sidecar(s): ${violations} violations, ${warnings} warnings, ${clean} clean`,
    exitCode: 0,
  };
}
