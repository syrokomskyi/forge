/*
<MODULE_CONTRACT>
<purpose>
RFC-1473: checks.contribution.report — per-rule marginal-contribution read-model.
Joins the validator inventory (rule universe) + docs/sessions/audit/*.audit.yaml
sidecars (what actually fired — coverage: partial until RFC-1469's engine-side
checkExecution counters land) + docs/frictions.yaml (escapes by contract/tag).
Verdicts: earning (unique findings), silent (zeroStreak ≥ threshold),
redundant (emits but uniqueEmitted ≈ 0 — shadowed by a sibling), guard
(declared low-frequency). Writes docs/metrics/check-contribution.generated.yaml.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1473: checks.contribution.report per-rule marginal-contribution read-model</item>
  <item>RFC-1473: checks.contribution.report — per-rule marginal-contribution read-model over firing history + escapes</item>
  <item>RFC-1473: deterministic metrics generatedAt — derived from window data, not wall-clock</item>
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

export interface ContributionRecord {
  ruleId: string;
  emitted: number;
  uniqueEmitted: number;
  zeroStreak: number;
  escapeCount: number;
  verdict: "earning" | "silent" | "redundant" | "guard";
  action?: "probe" | "scope" | "retire-rfc" | "keep";
}

export interface ContributionData {
  command: "checks.contribution.report";
  status: "ok";
  window: { runs: number; coverage: "full" | "partial" };
  rules: ContributionRecord[];
  variantCandidates: string[];
  metrics: string;
}

const ZERO_STREAK_THRESHOLD = 10;
const GUARD_RULES = new Set(["PROBE-01", "PROBE-03", "PROBE-05", "AUDIT-01", "AUDIT-02"]);

export async function runContributionReport(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ContributionData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const contractFilter = input.flags["contract"] as string | undefined;
  const windowN = Number(input.flags["window"] ?? 20) || 20;

  // Rule universe: validator inventory's declared rules.
  const invSrc = await io.readFile(path.join(root, "docs", "validator-inventory.generated.yaml")).catch(() => "");
  const parsed = yamlParse(invSrc) as {
    contracts?: { name?: string; validators?: { name?: string; rules?: { id?: string; severity?: string }[] }[] }[];
  } | null;
  const rules = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) =>
      (v.rules ?? []).filter((r) => r.id && (!contractFilter || c.name === contractFilter)).map((r) => ({ id: r.id!, contract: c.name ?? "?", severity: r.severity ?? "warning" })),
    ),
  );

  // Firing history: session audit sidecars (the only persisted per-rule firing
  // surface until RFC-1469's checkExecution journal lands — coverage: partial).
  const auditDir = path.join(root, "docs", "sessions", "audit");
  const sidecars = (await io.readdir(auditDir).catch(() => [] as { name: string; isDirectory: boolean }[]))
    .filter((e) => !e.isDirectory && e.name.endsWith(".audit.yaml"))
    .map((e) => e.name)
    .sort()
    .slice(-windowN);

  const fired = new Map<string, { emitted: number; uniqueSignatures: Set<string>; sessions: number }>();
  const lastFiredAt = new Map<string, number>();
  let windowTo = "";
  for (let i = 0; i < sidecars.length; i++) {
    const src = await io.readFile(path.join(auditDir, sidecars[i]!)).catch(() => "");
    const sc = yamlParse(src) as { findings?: { ruleId?: string; signature?: string }[]; auditedAt?: string } | null;
    if (typeof sc?.auditedAt === "string" && sc.auditedAt > windowTo) windowTo = sc.auditedAt;
    for (const f of sc?.findings ?? []) {
      if (!f.ruleId) continue;
      const g = fired.get(f.ruleId) ?? { emitted: 0, uniqueSignatures: new Set<string>(), sessions: 0 };
      g.emitted++;
      if (f.signature) g.uniqueSignatures.add(f.signature);
      g.sessions++;
      fired.set(f.ruleId, g);
      lastFiredAt.set(f.ruleId, i);
    }
  }

  // Escapes: friction entries whose signature matches a rule's contract/tag —
  // evidence the guard missed a signature that mattered.
  const frictionsSrc = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
  const frictions = (yamlParse(frictionsSrc) as { frictions?: { id?: string; contract?: string; tags?: string[]; recurrences?: number }[] } | null)?.frictions ?? [];

  const records: ContributionRecord[] = [];
  const variantCandidates: string[] = [];
  for (const r of rules) {
    const f = fired.get(r.id) ?? { emitted: 0, uniqueSignatures: new Set<string>(), sessions: 0 };
    const lastIdx = lastFiredAt.get(r.id) ?? -1;
    const zeroStreak = lastIdx === -1 ? sidecars.length : sidecars.length - 1 - lastIdx;
    const escapeCount = frictions.filter((fr) =>
      fr.contract === r.contract || (fr.tags ?? []).includes(r.id),
    ).length;
    const uniqueEmitted = f.uniqueSignatures.size || f.emitted;
    let verdict: ContributionRecord["verdict"];
    let action: ContributionRecord["action"] | undefined;
    if (GUARD_RULES.has(r.id)) { verdict = "guard"; action = "keep"; }
    else if (uniqueEmitted > 0 || escapeCount === 0 && f.emitted > 0) verdict = "earning";
    else if (f.emitted > 0 && uniqueEmitted === 0) { verdict = "redundant"; action = "scope"; }
    else if (zeroStreak >= ZERO_STREAK_THRESHOLD || f.emitted === 0) { verdict = "silent"; action = "probe"; }
    else verdict = "earning";
    if (escapeCount > 0 && verdict === "silent") action = "scope";
    if (f.emitted > 0 && uniqueEmitted >= 1) variantCandidates.push(r.id);
    records.push({ ruleId: r.id, emitted: f.emitted, uniqueEmitted, zeroStreak, escapeCount, verdict, action });
  }

  const metricsRel = "docs/metrics/check-contribution.generated.yaml";
  const metrics = {
    schema: "forge/check-contribution@1",
    // Deterministic — derived from the window's own data, not wall-clock, so a
    // rerun over unchanged inputs produces an identical artifact.
    generatedAt: windowTo || "no-window",
    window: { runs: sidecars.length, coverage: "partial" as const },
    rules: records,
    variantCandidates,
  };
  const check = input.flags["check"] === true;
  if (!check) {
    await io.mkdir(path.join(root, "docs", "metrics")).catch(() => {});
    await io.writeFile(path.join(root, metricsRel), yamlStringify(metrics) + "\n");
  }

  if (context.outputFormat === "pretty") {
    for (const r of records.filter((r) => r.verdict === "silent" || r.verdict === "redundant")) {
      context.logger.warn(`${r.verdict.toUpperCase()} ${r.ruleId} — ${r.emitted} emitted, ${r.uniqueEmitted} unique, streak ${r.zeroStreak} → ${r.action}`);
    }
  }
  return {
    data: {
      command: "checks.contribution.report",
      status: "ok",
      window: { runs: sidecars.length, coverage: "partial" },
      rules: records,
      variantCandidates,
      metrics: check ? "(check — not written)" : metricsRel,
    },
    summary: `${records.length} rule(s): ${records.filter((r) => r.verdict === "earning").length} earning, ${records.filter((r) => r.verdict === "silent").length} silent, ${records.filter((r) => r.verdict === "redundant").length} redundant`,
    exitCode: 0,
  };
}
