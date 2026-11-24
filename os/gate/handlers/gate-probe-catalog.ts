/*
<MODULE_CONTRACT>
<purpose>RFC-1469: gate.probe.catalog — read-model over the fixture inventory: per-contract coverage, per-rule fixture binding, unprobed error-severity rules (gates with no liveness evidence). RFC-1592 adds the liveness ratchet: --check fails PROBE-06 on unprobed rules outside the shrink-only baseline, PROBE-07 on stale baseline entries, PROBE-09 on expired/undeclared provisional warnings; --write-baseline creates or shrink-rewrites docs/gate-probes/unprobed.baseline.generated.yaml (PROBE-08 refuses growth).</purpose>
<non-goals>
  <item>Never execute probes — the catalog is a read-model over declared fixtures.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1592: make probe-catalog liveness worktree-reproducible and exclude app-scope rules (F-0287)</item>
  <item>F-0287 r2: union shared flow-journal refusal ids into emittedIds — integrate refusals journal {rule} to &lt;commonGitDir&gt;/forge/journal.jsonl, the only firing evidence that outlives session worktrees for rebase-class rules (FLOW-INT-02) no file fixture can seed</item>
  <item>RFC-1592: union shared flow-journal refusal ids into probe-catalog emittedIds — FLOW-INT-02 and rebase-class rules keep firing evidence after the session worktree's counters journal dies with it (F-0287 r2)</item>
  <item>RFC-1592: use synthetic FLOW-INT-99 in the shared-journal liveness test — a real rule id literal in the diff trips FLOW-INT-19's duplicate governance scan (F-0287 r2 follow-up)</item>
  <item>RFC-1642: make the probe ratchet reproducible — bound fixture is liveness, mutating rules exempt</item>
  <history>F-0287, RFC-1469, RFC-1485, RFC-1592</history>
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
import { collectFixtureBindings, ruleLiveness, type RuleLiveness } from "./liveness.ts";
import { lastRunStatusByRule, readProbeRunsJournal } from "./probe-runs-journal.ts";
import { readCountersJournal } from "../../checks/handlers/counters-journal.ts";
import { commonGitDir, readJournal } from "../../flow/registry.ts";

export const UNPROBED_BASELINE_REL = "docs/gate-probes/unprobed.baseline.generated.yaml";
const UNPROBED_BASELINE_SCHEMA = "forge/unprobed-baseline@1";

export interface UnprobedBaselineFile {
  schema: typeof UNPROBED_BASELINE_SCHEMA;
  generatedBy: "gate.probe.catalog";
  /** Sorted rule ids in liveness state "none". */
  rules: string[];
}

export interface CatalogData {
  command: "gate.probe.catalog";
  status: "ok";
  contracts: {
    contract: string;
    rules: { rule: string; fixture: string; derivedFrom?: string }[];
  }[];
  unprobedErrorRules: string[];
  /** PROBE-05 — fixtures bound to rules no longer declared anywhere. */
  staleBindings: string[];
  /** RFC-1592 — ratchet outcome under --check/--write-baseline. */
  ratchet?: { newUnprobed: string[]; staleBaseline: string[] };
  diagnostics?: Diagnostic[];
}

interface InventoryRule {
  id: string;
  contract: string;
  severity?: string;
  /** Owning command name — resolves the rule's execution scope. */
  command?: string;
}

/** One PROBE-09 finding — an expired or undeclared provisional surface. */
interface ProvisionalFinding {
  /** The step command or rule id when resolvable. */
  name: string;
  file: string;
  kind: "missing" | "expired" | "malformed";
  detail: string;
}

const PROVISIONAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Heuristic comment detector — literals inside comments are prose, not declarations. */
function isInComment(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  const linePrefix = text.slice(lineStart, offset);
  if (/^\s*(\/\/|\*)/.test(linePrefix)) return true;
  if (/\/\//.test(linePrefix)) return true;
  return text.lastIndexOf("/*", offset) > text.lastIndexOf("*/", offset);
}

/**
 * Scans package sources for provisional surfaces: `{ … warnOnly: true … }`
 * step literals must declare `provisionalUntil`, and every
 * `provisionalUntil: "YYYY-MM-DD"` literal must hold a valid future date —
 * missing, malformed, or expired declarations are PROBE-09 findings.
 */
async function scanProvisionalDeclarations(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<ProvisionalFinding[]> {
  const files = await io.glob("packages/**/*.ts", { cwd: root }).catch(() => [] as string[]);
  const today = new Date().toISOString().slice(0, 10);
  const findings: ProvisionalFinding[] = [];
  for (const rel of files) {
    if (
      rel.endsWith(".test.ts") ||
      rel.endsWith(".spec.ts") ||
      rel.includes("/tests/") ||
      rel.includes("__tests__")
    ) {
      continue;
    }
    const abs = path.join(root, rel);
    const text = await io.readFile(abs).catch(() => null);
    if (text === null) continue;
    // Step objects declared warn-only without a provisionalUntil deadline.
    for (const m of text.matchAll(/\{[^{}]*warnOnly:\s*true[^{}]*\}/g)) {
      if (isInComment(text, m.index ?? 0)) continue;
      if (m[0].includes("provisionalUntil")) continue;
      const command = /command:\s*"([^"]+)"/.exec(m[0])?.[1];
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({
        name: command ?? `${rel}:${line}`,
        file: rel,
        kind: "missing",
        detail: "warnOnly step declares no provisionalUntil date",
      });
    }
    // Every provisionalUntil literal — step or rule — must be a valid future
    // YYYY-MM-DD. An expired deadline means the promotion decision is due.
    for (const m of text.matchAll(/provisionalUntil\s*:\s*"([^"]+)"/g)) {
      if (isInComment(text, m.index ?? 0)) continue;
      const raw = m[1]!;
      const match = PROVISIONAL_DATE_RE.exec(raw);
      const valid = match !== null && !Number.isNaN(Date.parse(raw)) && raw === raw.slice(0, 10);
      const line = text.slice(0, m.index).split("\n").length;
      const context = text.slice(Math.max(0, (m.index ?? 0) - 300), m.index);
      const name =
        /command:\s*"([^"]+)"|\bid:\s*"([^"]+)"|rule\(\s*"([^"]+)"/
          .exec(context)
          ?.slice(1)
          .find((g) => g !== undefined) ?? `${rel}:${line}`;
      if (!valid) {
        findings.push({
          name,
          file: rel,
          kind: "malformed",
          detail: `provisionalUntil "${raw}" is not a valid YYYY-MM-DD date`,
        });
      } else if (raw <= today) {
        findings.push({
          name,
          file: rel,
          kind: "expired",
          detail: `provisionalUntil ${raw} has passed — promote, make permanent with a recorded reason, or extend once`,
        });
      }
    }
  }
  return findings;
}

async function loadBaseline(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<UnprobedBaselineFile | null> {
  const src = await io.readFile(path.join(root, UNPROBED_BASELINE_REL)).catch(() => null);
  if (src === null) return null;
  const parsed = yamlParse(src) as { rules?: unknown } | null;
  const rules = Array.isArray(parsed?.rules)
    ? parsed.rules.filter((r): r is string => typeof r === "string")
    : [];
  return { schema: UNPROBED_BASELINE_SCHEMA, generatedBy: "gate.probe.catalog", rules };
}

/**
 * F-0287: rule ids with diagnostic > 0 in the committed counters artifact
 * (docs/metrics/check-counters.generated.yaml, RFC-1474). Absent or
 * unparseable file degrades to the empty set — the local journals stay the
 * only evidence, matching pre-fix behavior.
 */
async function committedDiagnosticRuleIds(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<Set<string>> {
  const src = await io
    .readFile(path.join(root, "docs/metrics/check-counters.generated.yaml"))
    .catch(() => null);
  if (src === null) return new Set();
  const parsed = yamlParse(src) as { rules?: { ruleId?: unknown; diagnostic?: unknown }[] } | null;
  const out = new Set<string>();
  for (const r of parsed?.rules ?? []) {
    if (typeof r.ruleId === "string" && typeof r.diagnostic === "number" && r.diagnostic > 0)
      out.add(r.ruleId);
  }
  return out;
}

/**
 * F-0287 r2: `flow/<ruleId>` ids recorded by integrate refusals in the shared
 * flow journal (<commonGitDir>/forge/journal.jsonl). Refusal diagnostics land
 * there before the session worktree — and its counters journal — is torn
 * down, so the shared journal is the only firing evidence that outlives
 * checkouts for rebase-class rules (flow/FLOW-INT-*) that cannot be seeded
 * by a file fixture. Missing git dir, missing exec, or an absent journal
 * degrades to the empty set like the committed artifact.
 */
async function sharedFlowRefusalRuleIds(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (typeof io.exec !== "function") return out;
  try {
    const common = await commonGitDir(io, root);
    for (const ev of await readJournal(io, common)) {
      if (typeof ev.rule === "string" && ev.rule.length > 0) out.add(`flow/${ev.rule}`);
    }
  } catch {
    // Not a git worktree or no journal — no shared evidence to union.
  }
  return out;
}

/**
 * F-0287: command name → declared scope map from the generated command
 * manifest. Absent/unparsable manifest degrades to an empty map — every rule
 * then resolves in-domain (fail-closed), matching pre-fix behavior.
 */
async function commandScopeMap(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<Map<string, string>> {
  const src = await io
    .readFile(path.join(root, "docs/command-manifest.generated.yaml"))
    .catch(() => null);
  const out = new Map<string, string>();
  if (src === null) return out;
  const parsed = yamlParse(src) as { commands?: { name?: unknown; scope?: unknown }[] } | null;
  for (const c of parsed?.commands ?? []) {
    if (typeof c.name === "string" && typeof c.scope === "string") out.set(c.name, c.scope);
  }
  return out;
}

/**
 * RFC-1640 follow-up: command → mutatesState from the generated command
 * manifest. A mutating command's rules cannot be proven by a gate.probe
 * fixture (the probe injects a violation and invokes a CHECK command), so the
 * ratchet exempts them the same way it exempts app-scope rules.
 */
async function commandMutatesStateMap(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<Map<string, boolean>> {
  const src = await io
    .readFile(path.join(root, "docs/command-manifest.generated.yaml"))
    .catch(() => null);
  const out = new Map<string, boolean>();
  if (src === null) return out;
  const parsed = yamlParse(src) as {
    commands?: { name?: unknown; mutatesState?: unknown }[];
  } | null;
  for (const c of parsed?.commands ?? []) {
    if (typeof c.name === "string") out.set(c.name, c.mutatesState === true);
  }
  return out;
}

export async function runGateProbeCatalog(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CatalogData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const check = input.flags["check"] === true;
  const writeBaseline = input.flags["write-baseline"] === true;

  const bindings = await collectFixtureBindings(root, io);
  const contracts: CatalogData["contracts"] = [];
  const bound = new Set<string>();
  const byContract = new Map<string, CatalogData["contracts"][number]["rules"]>();
  for (const b of bindings) {
    bound.add(b.rule);
    const list = byContract.get(b.contract) ?? [];
    list.push({ rule: b.rule, fixture: b.path, derivedFrom: b.derivedFrom });
    byContract.set(b.contract, list);
  }
  for (const [contract, rules] of byContract) contracts.push({ contract, rules });

  // Error-severity rules with no fixture — gates lacking liveness evidence.
  // The validator inventory carries the declared rules[] + severities; the
  // contract is kept for the counters journal's <contract>/<id> join key.
  const manifestSrc = await io
    .readFile(path.join(root, "docs", "validator-inventory.generated.yaml"))
    .catch(() => "");
  const parsed = yamlParse(manifestSrc) as {
    contracts?: {
      contract?: string;
      validators?: { command?: string; rules?: { id?: string; severity?: string }[] }[];
    }[];
  } | null;
  const allRules: InventoryRule[] = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) =>
      (v.rules ?? [])
        .filter((r) => typeof r.id === "string")
        .map((r) => ({
          id: r.id!,
          contract: c.contract ?? "?",
          severity: r.severity,
          command: typeof v.command === "string" ? v.command : undefined,
        })),
    ),
  );
  const errorRules = allRules.filter((r) => r.severity === "error");
  // F-0287: scope:"app" commands execute only inside app workspaces — their
  // firing evidence lives in the app's own counters journal, where the same
  // ratchet runs under sites-check. A workspace-scope --check is structurally
  // blind to them, so every fresh session checkout would refuse on rules it
  // can never prove. The generated command manifest carries each command's
  // declared scope (context.commandRegistry is absent under `werkstatt run`,
  // F-0287/RFC-1518 D-001); commands missing from the manifest stay in-domain
  // (fail-closed).
  const commandScope = await commandScopeMap(root, io);
  const commandMutates = await commandMutatesStateMap(root, io);
  // RFC-1640 follow-up: a mutating command's rule cannot be proven by a
  // gate.probe fixture (the probe injects a violation and invokes a check),
  // so it is exempt from the unprobed ratchet — like app-scope rules, which
  // the app-side gate judges. Their coverage is the command's unit tests.
  const ratchetRules = errorRules.filter((r) => {
    if (r.command === undefined) return true;
    if (commandScope.get(r.command) === "app") return false;
    if (commandMutates.get(r.command) === true) return false;
    return true;
  });
  const unprobedErrorRules = errorRules.filter((r) => !bound.has(r.id)).map((r) => r.id);
  // PROBE-05: fixture bindings pointing at rules no longer declared anywhere.
  const allDeclared = new Set(allRules.map((r) => r.id));
  const staleBindings = [...bound].filter((id) => allDeclared.size > 0 && !allDeclared.has(id));

  const base: Omit<CatalogData, "ratchet" | "diagnostics"> = {
    command: "gate.probe.catalog",
    status: "ok",
    contracts,
    unprobedErrorRules,
    staleBindings,
  };

  if (!check && !writeBaseline) {
    if (context.outputFormat === "pretty") {
      if (unprobedErrorRules.length > 0)
        context.logger.warn(
          `PROBE-03 ${unprobedErrorRules.length} error-severity rule(s) have no liveness fixture`,
        );
      if (staleBindings.length > 0)
        context.logger.warn(`PROBE-05 stale fixture binding(s): ${staleBindings.join(", ")}`);
    }
    return {
      data: base,
      summary: `${contracts.length} contract(s), ${contracts.reduce((n, c) => n + c.rules.length, 0)} fixture(s), ${unprobedErrorRules.length} unprobed error rule(s)`,
      exitCode: 0,
    };
  }

  // ── Liveness join (RFC-1592) ───────────────────────────────────────────────
  const { records: probeRuns } = await readProbeRunsJournal(root);
  const lastRuns = lastRunStatusByRule(probeRuns);
  const { records: counterRecords } = await readCountersJournal(root);
  const emittedIds = new Set(
    counterRecords.filter((r) => r.outcome === "diagnostic").map((r) => r.ruleId),
  );
  // F-0287: the committed counters projection is the transferable half of
  // firing evidence. Both journals are per-worktree local state — a fresh
  // session checkout reads `none` for rules the primary already proved, so
  // the ratchet refused on develop debt no branch introduced. Union the
  // committed diagnostic totals (RFC-1474 artifact) so liveness stays
  // reproducible across checkouts; local records still cover unexported runs.
  const committedIds = await committedDiagnosticRuleIds(root, io);
  for (const id of committedIds) emittedIds.add(id);
  // F-0287 r2: the flow contract's refusal journal is the durable half of
  // its firing evidence — integrate refusals record {rule} into
  // <commonGitDir>/forge/journal.jsonl before the worktree's counters
  // journal dies with the session checkout.
  const sharedIds = await sharedFlowRefusalRuleIds(root, io);
  for (const id of sharedIds) emittedIds.add(id);
  const coverage =
    counterRecords.length === 0 && committedIds.size === 0 && sharedIds.size === 0
      ? ("none" as const)
      : ("partial" as const);
  const livenessOf = (r: InventoryRule): RuleLiveness =>
    ruleLiveness({
      bound: bound.has(r.id),
      lastRun: lastRuns.get(r.id),
      emitted: emittedIds.has(`${r.contract}/${r.id}`),
      coverage,
    });
  const ratchetIds = new Set(ratchetRules.map((r) => r.id));
  const livenessById = new Map(ratchetRules.map((r) => [r.id, livenessOf(r)]));
  const noneRules = ratchetRules
    .filter((r) => !bound.has(r.id) && livenessById.get(r.id) === "none")
    .map((r) => r.id)
    .sort();

  const baseline = await loadBaseline(root, io);
  const baselineSet = new Set(baseline?.rules ?? []);
  const newUnprobed = noneRules.filter((id) => !baselineSet.has(id));
  const staleBaseline = (baseline?.rules ?? []).filter((id) =>
    // Baseline entries owned by app-scope commands are out of this surface's
    // domain — the app-side gate judges their liveness. A rule gone from the
    // inventory entirely is stale regardless of scope.
    ratchetIds.has(id) ? bound.has(id) || livenessById.get(id) !== "none" : !allDeclared.has(id),
  );

  if (writeBaseline) {
    // PROBE-08: a rewrite may only remove entries — growth is never allowed.
    const grows = noneRules.some((id) => !baselineSet.has(id));
    if (baseline !== null && grows) {
      const adding = noneRules.filter((id) => !baselineSet.has(id));
      return {
        data: {
          ...base,
          ratchet: { newUnprobed, staleBaseline },
          diagnostics: [
            {
              ruleId: "PROBE-08" as const,
              severity: "error" as const,
              file: UNPROBED_BASELINE_REL,
              message: `--write-baseline would add ${adding.length} rule(s) to the existing baseline (first: ${adding[0]}). The baseline only shrinks — a new unprobed rule lands evidence in the same change or the change does not land.`,
              fixHint:
                "probe the new rule(s) with gate.probe, or delete the rule — never grow the baseline",
            },
          ],
        },
        summary: `PROBE-08 refused — baseline unchanged (${baseline.rules.length} entries)`,
        exitCode: 1,
      };
    }
    await io.mkdir(path.join(root, path.dirname(UNPROBED_BASELINE_REL)));
    await io.writeFile(
      path.join(root, UNPROBED_BASELINE_REL),
      yamlStringify({
        schema: UNPROBED_BASELINE_SCHEMA,
        generatedBy: "gate.probe.catalog",
        rules: noneRules,
      }),
    );
    return {
      data: { ...base, ratchet: { newUnprobed, staleBaseline } },
      summary: `baseline written: ${noneRules.length} rule(s) → ${UNPROBED_BASELINE_REL}${baseline !== null ? ` (was ${baseline.rules.length})` : ""}`,
      exitCode: 0,
    };
  }

  // ── --check: the ratchet gate ──────────────────────────────────────────────
  const diagnostics: Diagnostic[] = [];
  for (const id of newUnprobed) {
    diagnostics.push({
      ruleId: "PROBE-06",
      severity: "error",
      message: `error-severity rule ${id} has no liveness evidence and is absent from ${UNPROBED_BASELINE_REL}`,
      fixHint:
        baseline === null
          ? `create the adoption baseline once via gate.probe.catalog --write-baseline, or prove the rule with a gate.probe fixture`
          : `probe ${id} with gate.probe or delete the rule — the baseline never grows`,
    });
  }
  for (const id of staleBaseline) {
    diagnostics.push({
      ruleId: "PROBE-07",
      severity: "error",
      file: UNPROBED_BASELINE_REL,
      message: `baseline entry ${id} ${!allDeclared.has(id) ? "no longer exists" : "now has liveness evidence"} — regenerate the baseline`,
      fixHint:
        "run gate.probe.catalog --write-baseline to shrink the baseline to the current unprobed set",
    });
  }
  for (const f of await scanProvisionalDeclarations(root, io)) {
    diagnostics.push({
      ruleId: "PROBE-09",
      severity: "error",
      file: f.file,
      message: `provisional surface ${f.name}: ${f.detail}`,
      fixHint:
        "decide: promote to blocking, make the weaker level permanent with a recorded reason, or extend provisionalUntil once (at most 30 days ahead)",
    });
  }
  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
  }
  return {
    data: { ...base, ratchet: { newUnprobed, staleBaseline }, diagnostics },
    summary:
      diagnostics.length === 0
        ? `ratchet clean — ${noneRules.length} unprobed rule(s) all baselined`
        : `${diagnostics.length} ratchet violation(s): ${newUnprobed.length} PROBE-06, ${staleBaseline.length} PROBE-07`,
    exitCode: diagnostics.length > 0 ? 1 : 0,
  };
}
