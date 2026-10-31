/*
<MODULE_CONTRACT>
<purpose>
RFC-1473: checks.contribution.report — per-rule marginal-contribution read-model.
Joins the validator inventory (rule universe, contracts[].contract) + session
audit sidecars (firing surface — coverage: partial until RFC-1469's
checkExecution counters land; the report surfaces effectiveCoverage = fired ids
∩ inventory ids, warned when 0) + frictions (escapes by forge.yaml
checksContribution.contractMappings). uniqueEmitted = signatures seen under no
sibling rule (cross-rule dedup — redundant is reachable). verdict:
earning|silent|redundant|guard (guard declared via checksContribution.guardRules).
--check diffs the computed artifact vs the committed file (freshness gate).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1473: r1 repair — contract-root inventory join, effectiveCoverage, cross-rule signature dedup, escape mapping via forge.yaml, --check staleness diff, CONTRIB-01 blocking</item>
  <item>RFC-1473: apply r2 repairs — bare-sequence frictions root, real contract names in escape mapping, stale-path --check test</item>
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
  contract: string;
  emitted: number;
  uniqueEmitted: number;
  zeroStreak: number;
  escapeCount: number | null;
  verdict: "earning" | "silent" | "redundant" | "guard";
  action?: "probe" | "scope" | "retire-rfc" | "keep";
}

export interface VariantCandidate {
  rule: string;
  firedOn: string[];
  siblingScope: string;
}

export interface ContributionData {
  command: "checks.contribution.report";
  status: "ok";
  window: { runs: number; coverage: "full" | "partial"; effective: number; observable: number };
  rules: ContributionRecord[];
  variantCandidates: VariantCandidate[];
  ungovernedContracts: string[];
  metrics: string;
}


interface FiredRule { emitted: number; uniqueSignatures: Set<string>; sessions: number; firedOn: Set<string> }

export async function runContributionReport(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ContributionData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const contractFilter = input.flags["contract"] as string | undefined;
  const windowN = Math.max(1, Number(input.flags["window"] ?? 20) || 20);
  const check = input.flags["check"] === true;

  // CONTRIB-01: the rule universe must exist — a missing inventory is a
  // blocking input, not a silent empty report.
  const invPath = path.join(root, "docs", "validator-inventory.generated.yaml");
  const invSrc = await io.readFile(invPath).catch(() => null);
  if (invSrc === null) {
    return {
      data: { command: "checks.contribution.report", status: "ok", window: { runs: 0, coverage: "partial", effective: 0, observable: 0 }, rules: [], variantCandidates: [], ungovernedContracts: [], metrics: "" },
      summary: "CONTRIB-01 docs/validator-inventory.generated.yaml missing — rule universe unavailable",
      exitCode: 1,
    };
  }
  const parsed = yamlParse(invSrc) as {
    contracts?: { contract?: string; validators?: { rules?: { id?: string; severity?: string }[] }[] }[];
  } | null;
  const inventoryContracts = (parsed?.contracts ?? []).map((c) => c.contract ?? "?");
  if (contractFilter && !inventoryContracts.includes(contractFilter)) {
    return {
      data: { command: "checks.contribution.report", status: "ok", window: { runs: 0, coverage: "partial", effective: 0, observable: 0 }, rules: [], variantCandidates: [], ungovernedContracts: [], metrics: "" },
      summary: `CONTRIB-01 unknown --contract "${contractFilter}" (declared: ${inventoryContracts.join(", ")})`,
      exitCode: 1,
    };
  }
  const rules = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) =>
      (v.rules ?? []).filter((r) => r.id && (!contractFilter || c.contract === contractFilter)).map((r) => ({ id: r.id!, contract: c.contract ?? "?" })),
    ),
  );
  const inventoryIds = new Set(rules.map((r) => r.id));

  // Firing surface: session audit sidecars' findings[].ruleId — the only
  // persisted per-rule surface until RFC-1469 counters land.
  const auditDir = path.join(root, "docs", "sessions", "audit");
  const sidecars = (await io.readdir(auditDir).catch(() => [] as { name: string; isDirectory: boolean }[]))
    .filter((e) => !e.isDirectory && e.name.endsWith(".audit.yaml"))
    .map((e) => e.name)
    .sort()
    .slice(-windowN);

  const fired = new Map<string, FiredRule>();
  const signatureOwners = new Map<string, Set<string>>();
  const firedIds = new Set<string>();
  let windowTo = "";
  for (let i = 0; i < sidecars.length; i++) {
    const src = await io.readFile(path.join(auditDir, sidecars[i]!)).catch(() => "");
    const sc = yamlParse(src) as { findings?: { ruleId?: string; signature?: string; evidence?: { file?: string } }[]; auditedAt?: string } | null;
    if (typeof sc?.auditedAt === "string" && sc.auditedAt > windowTo) windowTo = sc.auditedAt;
    for (const f of sc?.findings ?? []) {
      if (!f.ruleId) continue;
      firedIds.add(f.ruleId);
      const g = fired.get(f.ruleId) ?? { emitted: 0, uniqueSignatures: new Set<string>(), sessions: 0, firedOn: new Set<string>() };
      g.emitted++;
      if (f.signature) g.uniqueSignatures.add(f.signature);
      if (f.evidence?.file) g.firedOn.add(f.evidence.file);
      g.sessions++;
      fired.set(f.ruleId, g);
      if (f.signature) {
        const owners = signatureOwners.get(f.signature) ?? new Set<string>();
        owners.add(f.ruleId);
        signatureOwners.set(f.signature, owners);
      }
    }
  }
  const effectiveIds = [...firedIds].filter((id) => inventoryIds.has(id));
  const lastIdxByRule = new Map<string, number>();
  for (let i = 0; i < sidecars.length; i++) {
    const src = await io.readFile(path.join(auditDir, sidecars[i]!)).catch(() => "");
    const sc = yamlParse(src) as { findings?: { ruleId?: string }[] } | null;
    for (const f of sc?.findings ?? []) if (f.ruleId) lastIdxByRule.set(f.ruleId, i);
  }

  // Escape mapping — forge.yaml checksContribution: maps friction contracts/
  // categories to the contract whose rules should have caught them.
  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => "");
  const cc = (yamlParse(forgeYaml) as { checksContribution?: { contractMappings?: Record<string, string>; guardRules?: string[] } } | null)?.checksContribution ?? {};
  const contractMappings = cc.contractMappings ?? {};
  const guardRules = new Set(cc.guardRules ?? []);
  const frictionsSrc = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
  // frictions.yaml is a bare top-level sequence (- id: F-NNNN), not a {frictions:[]} map.
  const frParsed = yamlParse(frictionsSrc) as unknown;
  const frictions: { id?: string; category?: string; contract?: string; tags?: string[] }[] = Array.isArray(frParsed)
    ? frParsed
    : ((frParsed as { frictions?: typeof frictions } | null)?.frictions ?? []);
  const ungovernedContracts = [...new Set(frictions.map((f) => f.category).filter((c): c is string => !!c))].filter((c) => !Object.keys(contractMappings).includes(c));

  const records: ContributionRecord[] = [];
  const variantCandidates: VariantCandidate[] = [];
  for (const r of rules) {
    const f = fired.get(r.id) ?? { emitted: 0, uniqueSignatures: new Set<string>(), sessions: 0, firedOn: new Set<string>() };
    const lastIdx = lastIdxByRule.get(r.id) ?? -1;
    const zeroStreak = lastIdx === -1 ? sidecars.length : sidecars.length - 1 - lastIdx;
    const escapeCount = Object.keys(contractMappings).length > 0
      ? frictions.filter((fr) => contractMappings[fr.category ?? ""] === r.contract).length
      : null;
    const uniqueEmitted = [...f.uniqueSignatures].filter((s) => (signatureOwners.get(s)?.size ?? 0) === 1).length;
    let verdict: ContributionRecord["verdict"];
    let action: ContributionRecord["action"] | undefined;
    if (guardRules.has(r.id)) { verdict = "guard"; action = "keep"; }
    else if (f.emitted > 0 && uniqueEmitted > 0) verdict = "earning";
    else if (f.emitted > 0 && uniqueEmitted === 0) { verdict = "redundant"; action = "scope"; }
    else if (f.emitted === 0) { verdict = "silent"; action = escapeCount === null || escapeCount > 0 ? "scope" : "probe"; }
    else verdict = "earning";
    if (uniqueEmitted > 0) {
      variantCandidates.push({ rule: r.id, firedOn: [...f.firedOn], siblingScope: r.contract });
    }
    records.push({ ruleId: r.id, contract: r.contract, emitted: f.emitted, uniqueEmitted, zeroStreak, escapeCount, verdict, action });
  }

  const metricsRel = "docs/metrics/check-contribution.generated.yaml";
  const metrics = {
    schema: "forge/check-contribution@1",
    generatedAt: windowTo || "no-window",
    window: { runs: sidecars.length, coverage: "partial" as const, effective: effectiveIds.length, observable: firedIds.size },
    rules: records,
    variantCandidates,
    ungovernedContracts,
  };
  const serialized = yamlStringify(metrics) + "\n";

  if (check) {
    const committed = await io.readFile(path.join(root, metricsRel)).catch(() => null);
    const stale = committed !== serialized;
    return {
      data: { command: "checks.contribution.report", status: "ok", window: metrics.window, rules: records, variantCandidates, ungovernedContracts, metrics: metricsRel },
      summary: stale ? "CONTRIB-02 committed report is stale — run checks.contribution.report" : "report fresh",
      exitCode: stale ? 1 : 0,
    };
  }

  await io.mkdir(path.join(root, "docs", "metrics")).catch(() => {});
  await io.writeFile(path.join(root, metricsRel), serialized);
  if (context.outputFormat === "pretty") {
    if (effectiveIds.length === 0 && firedIds.size > 0) {
      context.logger.warn(`observableCoverage: ${effectiveIds.length}/${firedIds.size} fired ids resolve in the inventory — firing surface is structurally disjoint from the rule universe`);
    }
    for (const r of records.filter((r) => r.verdict === "silent" || r.verdict === "redundant")) {
      context.logger.warn(`${r.verdict.toUpperCase()} ${r.ruleId} — ${r.emitted} emitted, ${r.uniqueEmitted} unique, streak ${r.zeroStreak} → ${r.action}`);
    }
  }
  return {
    data: { command: "checks.contribution.report", status: "ok", window: metrics.window, rules: records, variantCandidates, ungovernedContracts, metrics: metricsRel },
    summary: `${records.length} rule(s): ${records.filter((r) => r.verdict === "earning").length} earning, ${records.filter((r) => r.verdict === "silent").length} silent, ${records.filter((r) => r.verdict === "redundant").length} redundant (effectiveCoverage ${effectiveIds.length}/${firedIds.size})`,
    exitCode: 0,
  };
}
