/*
<MODULE_CONTRACT>
<purpose>Registers forgeInstructionsModule in the instructions module — the instruction-budget validator and scar-migration command surface.</purpose>
<non-goals>
  <item>Autonomous module — no engine imports (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1466: forgeInstructionsModule registering instructions.budget.validate + scar.migrate</item>
  <item>RFC-1466: bound the instruction layer — instructions.budget.validate, scar.migrate, catalog fragment merge</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runInstructionsBudgetValidate } from "./handlers/budget-validate.ts";
import { runScarMigrate } from "./handlers/scar-migrate.ts";

export const forgeInstructionsModule: ForgeModule = {
  name: "forge-instructions",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "instructions.budget.validate",
      coverage: "operator" as const,
      mutatesState: false,
      contract: "instructions",
      rules: [
        { id: "INSTR-01", severity: "warning" },
        { id: "INSTR-02", severity: "warning" },
        { id: "INSTR-03", severity: "warning" },
      ],
      description:
        "RFC-1466: bound the instruction layer — INSTR-01 AGENTS.md over declared budget, INSTR-02 scar-classified bullet in an exempt section (informational), INSTR-03 migrated scar still present as prose. Wave-1 reporting-only.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["forge.yaml", "AGENTS.md", "packages/*/AGENTS.md", "apps/*/AGENTS.md", "docs/remediation-catalog.custom.yaml"],
      execute: runInstructionsBudgetValidate,
    },
    {
      name: "scar.migrate",
      coverage: "operator" as const,
      mutatesState: true,
      description:
        "RFC-1466: migrate a friction-scar bullet from an AGENTS.md file into docs/remediation-catalog.custom.yaml — writes the fragment entry, updates the cited frictions' catalogRefs, removes the bullet, journals refusals. Flags: --file, --line, --catalog-remedy, --friction, --diagnostic-codes, --force.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        file: { kind: "string", required: true, description: "AGENTS.md path containing the scar bullet." },
        line: { kind: "string", required: true, description: "1-based line number of the scar bullet." },
        "catalog-remedy": {
          kind: "string",
          description: "Entry id to append/extend in the fragment catalog (default SCAR-####).",
        },
        friction: {
          kind: "string",
          description: "Comma-separated friction ids (F-XXXX) to link via catalogRefs.",
        },
        "diagnostic-codes": {
          kind: "string",
          description: "Comma-separated ruleIds bound to this remedy.",
        },
        force: {
          kind: "boolean",
          description: "Override the invariant-shaped refusal (journaled).",
        },
      },
      writes: ["docs/remediation-catalog.custom.yaml", "docs/frictions.yaml", "AGENTS.md", "packages/*/AGENTS.md", "apps/*/AGENTS.md"],
      generates: [{ path: "docs/remediation-catalog.custom.yaml", phase: "on-demand" }],
      reads: ["forge.yaml", "docs/frictions.yaml", "docs/remediation-catalog.custom.yaml"],
      cacheable: false,
      execute: runScarMigrate,
    },
  ],
  pipelines: [],
};
