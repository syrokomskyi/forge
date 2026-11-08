/*
<MODULE_CONTRACT>
<purpose>system.map.validate command handler (RFC-1508) — gates on the system
profile (SYSTEM-01), loads the system map non-throwing (SYSTEM-MAP-01), then
evaluates the cross-file rules (SYSTEM-MAP-02..05). Read-only: exit 1 iff an
error-severity diagnostic exists.</purpose>
<non-goals>
  <item>Do not mutate any files.</item>
  <item>No task, outbox, scenario or version-set behavior — RFC-1509..1511.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 3 — system.map.validate handler</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
  <item>RFC-1508: align rfc-1508 schemas with the normative contract after review r1</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
  <item>RFC-1541: version-set@2 contracts with validator and pin-drift scenario checks</item>
</CHANGE_SUMMARY>
*/

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  assertSystemRepository,
  loadScenarios,
  loadSystemMap,
  validateScenarios,
  validateSystemMap,
} from "../repo.ts";

export interface SystemMapValidateResult {
  command: "system.map.validate";
  status: "pass" | "warn" | "fail";
  systemId: string | null;
  products: number;
  allowed: number;
  forbidden: number;
  localFolders: number | null;
  diagnostics: Diagnostic[];
}

export async function runSystemMapValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemMapValidateResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];

  const refusal = await assertSystemRepository(root, io);
  let map: Awaited<ReturnType<typeof loadSystemMap>>["map"] = null;
  if (refusal) {
    diagnostics.push(refusal);
  } else {
    const loaded = await loadSystemMap(root, io);
    diagnostics.push(...loaded.diagnostics);
    map = loaded.map;
    if (map) {
      diagnostics.push(...(await validateSystemMap(map, io)));
      const scenarios = await loadScenarios(root, io);
      diagnostics.push(...scenarios.diagnostics);
      diagnostics.push(...validateScenarios(map, scenarios.scenarios, root));
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) {
      const line = `${d.ruleId} · ${d.file ? `${d.file}: ` : ""}${d.message}`;
      if (d.severity === "error") context.logger.error(line);
      else if (d.severity === "warning") context.logger.warn(line);
      else context.logger.info(line);
    }
  }

  const result: SystemMapValidateResult = {
    command: "system.map.validate",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    systemId: map?.system.id ?? null,
    products: map?.products.products.length ?? 0,
    allowed: map?.edges.allowed.length ?? 0,
    forbidden: map?.edges.forbidden.length ?? 0,
    localFolders: map?.local ? Object.keys(map.local.folders).length : null,
    diagnostics,
  };

  return {
    data: result,
    exitCode: errors > 0 ? 1 : 0,
    summary: `system.map.validate: ${errors} error(s), ${warnings} warning(s) — ${result.products} product(s), ${result.allowed} allowed and ${result.forbidden} forbidden edge(s)`,
    nextSteps:
      errors > 0
        ? [{ action: "Fix the error-severity system-map diagnostics above", kind: "required" }]
        : [
            {
              action:
                "Declare products, offered contracts and edges under system/ as the system grows",
              kind: "optional",
            },
          ],
  };
}
