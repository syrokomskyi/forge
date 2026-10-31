/*
<MODULE_CONTRACT>
<purpose>RFC-1469: gate.probe.catalog — read-model over the fixture inventory: per-contract coverage, per-rule fixture binding, unprobed error-severity rules (gates with no liveness evidence).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate.probe.catalog fixture-inventory read-model</item>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
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
  const unprobedErrorRules = [...manifestSrc.matchAll(/-\s+id:\s*([A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)*)\s*\n\s+severity:\s*error/g)]
    .map((m) => m[1]!)
    .filter((id) => !bound.has(id));

  return {
    data: { command: "gate.probe.catalog", status: "ok", contracts, unprobedErrorRules },
    summary: `${contracts.length} contract(s), ${contracts.reduce((n, c) => n + c.rules.length, 0)} fixture(s), ${unprobedErrorRules.length} unprobed error rule(s)`,
    exitCode: 0,
  };
}
