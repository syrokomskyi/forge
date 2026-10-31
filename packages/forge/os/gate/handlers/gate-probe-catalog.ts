/*
<MODULE_CONTRACT>
<purpose>RFC-1469: gate.probe.catalog — read-model over the fixture inventory: per-contract coverage, per-rule fixture binding, unprobed error-severity rules (gates with no liveness evidence).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate.probe.catalog fixture-inventory read-model</item>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
  <item>RFC-1469: apply r1 repairs — in-tree injection + invoke, ruleId-matched verdicts, yamlParse catalog, PROBE-02/05, real fixtures</item>
  <item>RFC-1469: apply r2 repairs — contracts-root inventory join, PROBE-03/05 declarations, dir-skeleton sweep, stale doc text</item>
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

export interface CatalogData {
  command: "gate.probe.catalog";
  status: "ok";
  contracts: { contract: string; rules: { rule: string; fixture: string; derivedFrom?: string }[] }[];
  unprobedErrorRules: string[];
  /** PROBE-05 — fixtures bound to rules no longer declared anywhere. */
  staleBindings: string[];
}

export async function runGateProbeCatalog(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CatalogData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;

  const contracts: CatalogData["contracts"] = [];
  const bound = new Set<string>();
  const base = path.join(root, "docs", "gate-probes");
  for (const c of await io.readdir(base).catch(() => [] as { name: string; isDirectory: boolean }[])) {
    if (!c.isDirectory || c.name.startsWith("_")) continue;
    const rules: CatalogData["contracts"][number]["rules"] = [];
    const cdir = path.join(base, c.name);
    for (const r of await io.readdir(cdir).catch(() => [] as { name: string; isDirectory: boolean }[])) {
      if (!r.isDirectory) continue;
      const fp = path.join(cdir, r.name, "fixture.yaml");
      const src = await io.readFile(fp).catch(() => null);
      if (src === null) continue;
      const parsed = yamlParse(src) as { rule?: string; derivedFrom?: string } | null;
      if (parsed?.rule) {
        rules.push({ rule: parsed.rule, fixture: path.relative(root, fp).split(path.sep).join("/"), derivedFrom: parsed.derivedFrom });
        bound.add(parsed.rule);
      }
    }
    if (rules.length > 0) contracts.push({ contract: c.name, rules });
  }

  // Error-severity rules with no fixture — gates lacking liveness evidence.
  // The validator inventory carries the declared rules[] + severities.
  const manifestSrc = await io.readFile(path.join(root, "docs", "validator-inventory.generated.yaml")).catch(() => "");
  const parsed = yamlParse(manifestSrc) as {
    contracts?: { validators?: { rules?: { id?: string; severity?: string }[] }[] }[];
  } | null;
  const allRules = (parsed?.contracts ?? []).flatMap((c) =>
    (c.validators ?? []).flatMap((v) => v.rules ?? []),
  );
  const errorRules = allRules
    .filter((r) => r.severity === "error" && typeof r.id === "string")
    .map((r) => r.id!);
  const unprobedErrorRules = errorRules.filter((id) => !bound.has(id));
  // PROBE-05: fixture bindings pointing at rules no longer declared anywhere.
  const allDeclared = new Set(allRules.map((r) => r.id).filter((i): i is string => !!i));
  const staleBindings = [...bound].filter((id) => allDeclared.size > 0 && !allDeclared.has(id));

  if (context.outputFormat === "pretty") {
    if (unprobedErrorRules.length > 0) context.logger.warn(`PROBE-03 ${unprobedErrorRules.length} error-severity rule(s) have no liveness fixture`);
    if (staleBindings.length > 0) context.logger.warn(`PROBE-05 stale fixture binding(s): ${staleBindings.join(", ")}`);
  }
  return {
    data: { command: "gate.probe.catalog", status: "ok", contracts, unprobedErrorRules, staleBindings },
    summary: `${contracts.length} contract(s), ${contracts.reduce((n, c) => n + c.rules.length, 0)} fixture(s), ${unprobedErrorRules.length} unprobed error rule(s)`,
    exitCode: 0,
  };
}
