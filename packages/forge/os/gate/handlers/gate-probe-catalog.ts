/*
<MODULE_CONTRACT>
<purpose>RFC-1469: gate.probe.catalog — read-model over the fixture inventory: per-contract coverage, per-rule fixture binding, unprobed error-severity rules (gates with no liveness evidence). RFC-1592 adds the liveness ratchet: --check fails PROBE-06 on unprobed rules outside the shrink-only baseline, PROBE-07 on stale baseline entries, PROBE-09 on expired/undeclared provisional warnings; --write-baseline creates or shrink-rewrites docs/gate-probes/unprobed.baseline.generated.yaml (PROBE-08 refuses growth).</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate.probe.catalog fixture-inventory read-model</item>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
  <item>RFC-1469: apply r1 repairs — in-tree injection + invoke, ruleId-matched verdicts, yamlParse catalog, PROBE-02/05, real fixtures</item>
  <item>RFC-1469: apply r2 repairs — contracts-root inventory join, PROBE-03/05 declarations, dir-skeleton sweep, stale doc text</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
  <item>RFC-1592: liveness ratchet — PROBE-06/07/08/09, shrink-only unprobed baseline, provisionalUntil scan</item>
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
      validators?: { rules?: { id?: string; severity?: string }[] }[];
    }[];
  } | null;
  const allRules: InventoryRule[] = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) =>
      (v.rules ?? [])
        .filter((r) => typeof r.id === "string")
        .map((r) => ({ id: r.id!, contract: c.contract ?? "?", severity: r.severity })),
    ),
  );
  const errorRules = allRules.filter((r) => r.severity === "error");
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
  const coverage = counterRecords.length === 0 ? ("none" as const) : ("partial" as const);
  const livenessOf = (r: InventoryRule): RuleLiveness =>
    ruleLiveness({
      bound: bound.has(r.id),
      lastRun: lastRuns.get(r.id),
      emitted: emittedIds.has(`${r.contract}/${r.id}`),
      coverage,
    });
  const livenessById = new Map(errorRules.map((r) => [r.id, livenessOf(r)]));
  const noneRules = errorRules
    .filter((r) => livenessById.get(r.id) === "none")
    .map((r) => r.id)
    .sort();

  const baseline = await loadBaseline(root, io);
  const baselineSet = new Set(baseline?.rules ?? []);
  const newUnprobed = noneRules.filter((id) => !baselineSet.has(id));
  const staleBaseline = (baseline?.rules ?? []).filter(
    (id) => !allDeclared.has(id) || livenessById.get(id) !== "none",
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
