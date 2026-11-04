/*
<MODULE_CONTRACT>
<purpose>Register system.map.validate with the forge kernel registry (RFC-1508) —
the Stage-2 Verbund-migration foundation: system-profile assertion plus the
system map's schema and cross-file validation. Read-only.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/system-map-validate.ts.</item>
  <item>No task, outbox, scenario or version-set commands — those are RFC-1509..1511.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 3 — forge-system module registration</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
  <item>RFC-1508: align rfc-1508 schemas with the normative contract after review r1</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeSystemModule(): Promise<ForgeModule> {
  const { runSystemMapValidate } = await import("./handlers/system-map-validate.ts");
  return {
    name: "forge-system",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "system.map.validate",
        description:
          "Read-only system-map validator (RFC-1508). Refuses outside the " +
          "system profile (SYSTEM-01), reports missing or schema-invalid map " +
          "files (SYSTEM-MAP-01), duplicate product ids and unknown edge " +
          "consumers (SYSTEM-MAP-02), edges naming contracts no product " +
          "offers (SYSTEM-MAP-03), consumer/contract pairs both allowed and " +
          "forbidden (SYSTEM-MAP-04), and warns on products.local.yaml gaps " +
          "(SYSTEM-MAP-05). Exit 1 iff an error-severity diagnostic exists.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-MAP-01", severity: "error" },
          { id: "SYSTEM-MAP-02", severity: "error" },
          { id: "SYSTEM-MAP-03", severity: "error" },
          { id: "SYSTEM-MAP-04", severity: "error" },
          { id: "SYSTEM-MAP-05", severity: "warning" },
        ],
        mutatesState: false,
        writes: [],
        coverage: "operator",
        coverageNote:
          "map validation — the operator runs this before dispatching system work (RFC-1508)",
        reads: [
          "forge.yaml",
          "system/system.yaml",
          "system/products.yaml",
          "system/edges.yaml",
          "system/products.local.yaml",
        ],
        cacheable: false,
        flags: {},
        execute: runSystemMapValidate,
      },
    ],
    pipelines: [],
  };
}
