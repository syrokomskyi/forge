/*
<MODULE_CONTRACT>
<purpose>
RFC-1473/1474: checks.contribution.report — per-rule marginal-contribution
read-model. Joins the validator inventory (rule universe, contracts[].contract)
+ the counters journal docs/.index/checks/counters.jsonl as the PRIMARY firing
surface (one record per evaluated rule; emitted/zeroStreak/lastFiredAt derive
from it; coverage none|partial|complete vs the --window run count; CONTRIB-03
warns on absent/empty journal, effectiveCoverage = fired ids ∩ inventory ids) +
session audit sidecars as SECONDARY diagnostic-signature history
(uniqueEmitted/firedOn/variantCandidates) + frictions (escapes by forge.yaml
checksContribution.contractMappings). uniqueEmitted = signatures seen under no
sibling rule (cross-rule dedup — redundant is reachable). verdict:
earning|silent|redundant|guard (guard declared via checksContribution.guardRules).
--check diffs the computed artifact vs the committed file (freshness gate,
producer-tail tolerated).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1473: apply r2 repairs — bare-sequence frictions root, real contract names in escape mapping, stale-path --check test</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply review findings (F-1..F-9)</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
  <item>RFC-1474: check-execution counters — close emission-shape extraction class (round-3 review)</item>
  <history>RFC-1473</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  readCountersJournal,
  recordsCoveredByArtifact,
  type CheckCounterRecord,
} from "./counters-journal.ts";

export interface ContributionRecord {
  ruleId: string;
  contract: string;
  emitted: number;
  evaluated: number;
  lastFiredAt: string;
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
  window: { runs: number; coverage: "none" | "partial" | "complete"; effective: number; observable: number };
  rules: ContributionRecord[];
  variantCandidates: VariantCandidate[];
  ungovernedContracts: string[];
  metrics: string;
  diagnostics?: Diagnostic[];
}


interface FiredRule { uniqueSignatures: Set<string>; sessions: number; firedOn: Set<string> }
interface CounterStats { emitted: number; evaluated: number; lastFiredAt: string; lastDiagRunIdx: number; evalRunIdxs: Set<number> }

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
  // blocking input, not a silent empty report. Only ENOENT means "absent" —
  // other read failures surface as real I/O errors.
  const invPath = path.join(root, "docs", "validator-inventory.generated.yaml");
  const invSrc = await io.readFile(invPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (invSrc === null) {
    return {
      data: { command: "checks.contribution.report", status: "ok", window: { runs: 0, coverage: "none", effective: 0, observable: 0 }, rules: [], variantCandidates: [], ungovernedContracts: [], metrics: "" },
      summary: "CONTRIB-01 docs/validator-inventory.generated.yaml missing — rule universe unavailable",
      exitCode: 1,
    };
  }
  const parsed = (() => {
    try {
      return yamlParse(invSrc) as {
        contracts?: { contract?: string; validators?: { rules?: { id?: string; severity?: string }[] }[] }[];
      } | null;
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) {
    return {
      data: { command: "checks.contribution.report", status: "ok", window: { runs: 0, coverage: "none", effective: 0, observable: 0 }, rules: [], variantCandidates: [], ungovernedContracts: [], metrics: "" },
      summary: "CONTRIB-01 docs/validator-inventory.generated.yaml malformed — rule universe unparseable",
      exitCode: 1,
    };
  }
  const inventoryContracts = (parsed?.contracts ?? []).map((c) => c.contract ?? "?");
  if (contractFilter && !inventoryContracts.includes(contractFilter)) {
    return {
      data: { command: "checks.contribution.report", status: "ok", window: { runs: 0, coverage: "none", effective: 0, observable: 0 }, rules: [], variantCandidates: [], ungovernedContracts: [], metrics: "" },
      summary: `CONTRIB-01 unknown --contract "${contractFilter}" (declared: ${inventoryContracts.join(", ")})`,
      exitCode: 1,
    };
  }
  const rules = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) =>
      (v.rules ?? []).filter((r) => r.id && (!contractFilter || c.contract === contractFilter)).map((r) => ({ id: r.id!, contract: c.contract ?? "?" })),
    ),
  );
  // Counters ruleIds carry the namespaced `<contract>/<id>` form — the join key.
  const inventoryJoinIds = new Set(rules.map((r) => `${r.contract}/${r.id}`));

  // RFC-1474: the counters journal is the PRIMARY firing source — one record
  // per evaluated rule per run. The window is the last `windowN` distinct
  // runIds ordered by each run's first `at`.
  const { records: counterRecords } = await readCountersJournal(root);
  const computeWindowStats = (source: readonly CheckCounterRecord[]) => {
    const runFirstAt = new Map<string, number>();
    for (const r of source) {
      const atMs = Date.parse(r.at);
      const cur = runFirstAt.get(r.runId);
      if (cur === undefined || atMs < cur) runFirstAt.set(r.runId, atMs);
    }
    const orderedRuns = [...runFirstAt.keys()].sort(
      (a, b) => runFirstAt.get(a)! - runFirstAt.get(b)!,
    );
    const windowRunIds = orderedRuns.slice(-windowN);
    const windowRunSet = new Set(windowRunIds);
    const runIndex = new Map(windowRunIds.map((id, i) => [id, i]));
    const windowRecords = source.filter((r) => windowRunSet.has(r.runId));

    const stats = new Map<string, CounterStats>();
    let to = "";
    let toMs = Number.NEGATIVE_INFINITY;
    for (const r of windowRecords) {
      const atMs = Date.parse(r.at);
      if (atMs > toMs) {
        toMs = atMs;
        to = r.at;
      }
      const s = stats.get(r.ruleId) ?? { emitted: 0, evaluated: 0, lastFiredAt: "", lastDiagRunIdx: -1, evalRunIdxs: new Set<number>() };
      if (r.outcome !== "skipped") {
        s.evaluated++;
        s.evalRunIdxs.add(runIndex.get(r.runId) ?? -1);
      }
      if (r.outcome === "diagnostic") {
        s.emitted++;
        if (s.lastFiredAt === "" || atMs > Date.parse(s.lastFiredAt)) s.lastFiredAt = r.at;
        s.lastDiagRunIdx = Math.max(s.lastDiagRunIdx, runIndex.get(r.runId) ?? -1);
      }
      stats.set(r.ruleId, s);
    }
    const evaluated = [...stats.entries()].filter(([, s]) => s.evaluated > 0).map(([id]) => id);
    const cov: "none" | "partial" | "complete" =
      source.length === 0 ? "none" : orderedRuns.length >= windowN ? "complete" : "partial";
    return { stats, evaluated, coverage: cov, windowTo: to, runCount: windowRunIds.length };
  };

  // Secondary source (RFC-1474): session audit sidecars keep the diagnostic
  // signature history — uniqueEmitted / firedOn / variantCandidates only.
  const auditDir = path.join(root, "docs", "sessions", "audit");
  const sidecars = (await io.readdir(auditDir).catch(() => [] as { name: string; isDirectory: boolean }[]))
    .filter((e) => !e.isDirectory && e.name.endsWith(".audit.yaml"))
    .map((e) => e.name)
    .sort()
    .slice(-windowN);

  const fired = new Map<string, FiredRule>();
  const signatureOwners = new Map<string, Set<string>>();
  for (let i = 0; i < sidecars.length; i++) {
    const src = await io.readFile(path.join(auditDir, sidecars[i]!)).catch(() => "");
    const sc = yamlParse(src) as { findings?: { ruleId?: string; signature?: string; evidence?: { file?: string } }[] } | null;
    for (const f of sc?.findings ?? []) {
      if (!f.ruleId) continue;
      const g = fired.get(f.ruleId) ?? { uniqueSignatures: new Set<string>(), sessions: 0, firedOn: new Set<string>() };
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

  const computeView = (source: readonly CheckCounterRecord[]) => {
    const ws = computeWindowStats(source);
    const effectiveIds = ws.evaluated.filter((id) => inventoryJoinIds.has(id));
    const recs: ContributionRecord[] = [];
    const candidates: VariantCandidate[] = [];
    for (const r of rules) {
      const f = fired.get(r.id) ?? { uniqueSignatures: new Set<string>(), sessions: 0, firedOn: new Set<string>() };
      const cs = ws.stats.get(`${r.contract}/${r.id}`) ?? { emitted: 0, evaluated: 0, lastFiredAt: "", lastDiagRunIdx: -1, evalRunIdxs: new Set<number>() };
      // Streak counts evaluation opportunities, not the whole run universe —
      // operational commands journal their own rules, so foreign runs must not
      // inflate a rule's silence (RFC-1474 review F-6).
      const zeroStreak = [...cs.evalRunIdxs].filter((i) => i > cs.lastDiagRunIdx).length;
      const escapeCount = Object.keys(contractMappings).length > 0
        ? frictions.filter((fr) => contractMappings[fr.category ?? ""] === r.contract).length
        : null;
      const uniqueEmitted = [...f.uniqueSignatures].filter((s) => (signatureOwners.get(s)?.size ?? 0) === 1).length;
      let verdict: ContributionRecord["verdict"];
      let action: ContributionRecord["action"] | undefined;
      if (guardRules.has(r.id)) { verdict = "guard"; action = "keep"; }
      else if (cs.emitted > 0 && f.uniqueSignatures.size > 0 && uniqueEmitted === 0) { verdict = "redundant"; action = "scope"; }
      else if (cs.emitted > 0) verdict = "earning";
      else { verdict = "silent"; action = escapeCount === null || escapeCount > 0 ? "scope" : "probe"; }
      if (uniqueEmitted > 0) {
        candidates.push({ rule: r.id, firedOn: [...f.firedOn], siblingScope: r.contract });
      }
      recs.push({ ruleId: r.id, contract: r.contract, emitted: cs.emitted, evaluated: cs.evaluated, lastFiredAt: cs.lastFiredAt, uniqueEmitted, zeroStreak, escapeCount, verdict, action });
    }
    const metrics = {
      schema: "forge/check-contribution@1",
      generatedAt: ws.windowTo || "no-data",
      window: { runs: ws.runCount, coverage: ws.coverage, effective: effectiveIds.length, observable: ws.evaluated.length },
      rules: recs,
      variantCandidates: candidates,
      ungovernedContracts,
    };
    return { metrics, records: recs, variantCandidates: candidates, ws, effectiveIds };
  };

  const view = computeView(counterRecords);
  const { metrics, records, variantCandidates, ws, effectiveIds } = view;
  const { coverage, evaluated: evaluatedJoinIds } = ws;

  const metricsRel = "docs/metrics/check-contribution.generated.yaml";
  const serialized = yamlStringify(metrics) + "\n";

  const diagnostics: Diagnostic[] = [];
  if (coverage === "none") {
    diagnostics.push({
      ruleId: "CONTRIB-03",
      severity: "warning",
      message: "counters journal is empty or absent — coverage is none, all firing signals are honest zeros (no retroactive fabrication)",
    });
  }

  if (check) {
    const committed = await io.readFile(path.join(root, metricsRel)).catch(() => null);
    // Recompute over the record set the committed artifact could have seen —
    // this report's own journal tail is structurally unreachable.
    const committedAt =
      committed === null
        ? ""
        : ((yamlParse(committed) as { generatedAt?: string } | null)?.generatedAt ?? "");
    const covered = recordsCoveredByArtifact(counterRecords, committedAt, "checks.contribution.report-");
    const expected = yamlStringify(computeView(covered).metrics) + "\n";
    const stale = committed !== expected;
    return {
      data: { command: "checks.contribution.report", status: "ok", window: metrics.window, rules: records, variantCandidates, ungovernedContracts, metrics: metricsRel, diagnostics },
      summary: stale ? "CONTRIB-02 committed report is stale — run checks.contribution.report" : "report fresh",
      exitCode: stale ? 1 : 0,
    };
  }

  await io.mkdir(path.join(root, "docs", "metrics")).catch(() => {});
  await io.writeFile(path.join(root, metricsRel), serialized);
  if (context.outputFormat === "pretty") {
    if (coverage === "none") {
      context.logger.warn(`CONTRIB-03 counters journal is empty or absent — coverage: none`);
    } else if (effectiveIds.length === 0 && evaluatedJoinIds.length > 0) {
      context.logger.warn(`observableCoverage: ${effectiveIds.length}/${evaluatedJoinIds.length} evaluated ids resolve in the inventory — firing surface is structurally disjoint from the rule universe`);
    }
    for (const r of records.filter((r) => r.verdict === "silent" || r.verdict === "redundant")) {
      context.logger.warn(`${r.verdict.toUpperCase()} ${r.ruleId} — ${r.emitted} emitted, ${r.uniqueEmitted} unique, streak ${r.zeroStreak} → ${r.action}`);
    }
  }
  return {
    data: { command: "checks.contribution.report", status: "ok", window: metrics.window, rules: records, variantCandidates, ungovernedContracts, metrics: metricsRel, diagnostics },
    summary: `${records.length} rule(s): ${records.filter((r) => r.verdict === "earning").length} earning, ${records.filter((r) => r.verdict === "silent").length} silent, ${records.filter((r) => r.verdict === "redundant").length} redundant (effectiveCoverage ${effectiveIds.length}/${evaluatedJoinIds.length}, coverage ${coverage})`,
    exitCode: 0,
  };
}
