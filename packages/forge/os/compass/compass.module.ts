/*
<MODULE_CONTRACT>
<purpose>Register the forge Compass command family against the Site OS kernel registry.</purpose>
<non-goals>
  <item>Do not implement compass handler logic — delegate to handlers/ inlined by RFC-0556.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeCompassModule registering 12 compass commands.</item>
  <item>RFC-0538: renamed compass.changesummary.tidy to compass.summary.trim, removed compass.annotate, compass.clear, compass.markup.migrate, compass.invariant.add.</item>
  <item>RFC-0556: removed dynamic import of @warpgogol/site-kernel-checks, all handlers now inlined in forge/os/compass/handlers/.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type { ForgeFlagSpec } from "../../src/types.ts";
import { runCompassInventory, runCompassValidation } from "./handlers/compass-inventory-handler.ts";
import {
  runCompassAuditPlan,
  runCompassAuditRecord,
  runCompassAuditBaseline,
  runCompassAuditValidate,
} from "./handlers/compass-audit-handler.ts";
import {
  runCompassChangeSummaryValidate,
  runCompassSummaryTrim,
} from "./handlers/compass-change-summary-handler.ts";

const compassScanFlags = {
  packages: {
    kind: "boolean",
    description: "Scan packages/ instead of the inferred app or default workspace scope.",
  },
  package: {
    kind: "string",
    description: "With --packages, scan one package by directory/name.",
  },
  workpiece: {
    kind: "string",
    description:
      "Scan a mission workpiece directory (RFC-0617). Mutually exclusive with --packages and --site.",
  },
} satisfies Record<string, ForgeFlagSpec>;

export const forgeCompassModule: ForgeModule = {
  name: "forge-compass",
  version: "0.1.0",
  async register(registry) {
    registry.registerCommand({
      name: "compass.inventory",
      description: "Generate the repository-wide Compass source inventory XML report.",
      scope: "workspace",
      supportsAllSites: true,
      flags: { ...compassScanFlags },
      reads: ["packages/**/*.{ts,tsx,md}", "apps/**/*.{ts,tsx,md}", "services/**/*.{ts,tsx,md}"],
      execute: runCompassInventory,
    });
    registry.registerCommand({
      name: "compass.validate",
      description:
        "Validate authored source files against current Compass scaffolding requirements.",
      scope: "workspace",
      supportsAllSites: true,
      flags: { ...compassScanFlags },
      reads: [
        "packages/**/*.{ts,tsx,md}",
        "apps/**/*.{ts,tsx,md}",
        "services/**/*.{ts,tsx,md}",
        "docs/source-markup.xml",
      ],
      execute: runCompassValidation,
    });
    registry.registerCommand({
      name: "compass.changesummary.validate",
      description:
        "Validate CHANGE_SUMMARY blocks for boilerplate items and over-cap unprotected items (RFC-0349).",
      scope: "workspace",
      supportsAllSites: true,
      flags: { ...compassScanFlags },
      reads: ["packages/**/*.{ts,tsx,md}", "apps/**/*.{ts,tsx,md}", "services/**/*.{ts,tsx,md}"],
      execute: runCompassChangeSummaryValidate,
    });
    registry.registerCommand({
      name: "compass.summary.trim",
      description:
        "Deterministically trim CHANGE_SUMMARY blocks: remove boilerplate, cap total items to 30, preserve protected items (RFC-0538).",
      scope: "workspace",
      mutatesState: true,
      supportsAllSites: true,
      writes: [
        "apps/**/*.{astro,ts,tsx,md}",
        "packages/**/*.{astro,ts,tsx,md}",
        "services/**/*.{ts,tsx,md}",
      ],
      reads: ["packages/**/*.{ts,tsx,md}", "apps/**/*.{ts,tsx,md}", "services/**/*.{ts,tsx,md}"],
      cacheable: false,
      flags: { ...compassScanFlags },
      execute: runCompassSummaryTrim,
    });
    registry.registerCommand({
      name: "compass.audit.plan",
      description:
        "Emit a deterministic work-order of files whose revision has advanced past the threshold since their last Compass audit (RFC-0352). Read-only, no LLM.",
      scope: "workspace",
      supportsAllSites: true,
      flags: {
        ...compassScanFlags,
        threshold: {
          kind: "string",
          description: "Revision distance that makes a file audit-overdue.",
        },
      },
      reads: [
        "packages/**/*.{ts,tsx,md}",
        "apps/**/*.{ts,tsx,md}",
        "services/**/*.{ts,tsx,md}",
        "docs/compass-audit-ledger.generated.yaml",
      ],
      execute: runCompassAuditPlan,
    });
    registry.registerCommand({
      name: "compass.audit.record",
      description:
        "Stamp a file's audit verdict and current revision into the compass-audit ledger (RFC-0352). Mutating.",
      scope: "workspace",
      mutatesState: true,
      supportsAllSites: true,
      writes: ["docs/compass-audit-ledger.generated.yaml"],
      reads: ["docs/compass-audit-ledger.generated.yaml"],
      cacheable: false,
      flags: {
        file: { kind: "string", required: true, description: "Authored file path to stamp." },
        verdict: {
          kind: "string",
          required: true,
          description: "Audit verdict: pass, repaired, or baseline.",
        },
        agent: { kind: "string", description: "Agent identity to record in the ledger." },
      },
      execute: runCompassAuditRecord,
    });
    registry.registerCommand({
      name: "compass.audit.baseline",
      description:
        "Seed the compass-audit ledger for every authored file at its current revision with verdict=baseline (RFC-0352). One-time bootstrap.",
      scope: "workspace",
      mutatesState: true,
      supportsAllSites: true,
      writes: ["docs/compass-audit-ledger.generated.yaml"],
      reads: ["packages/**/*.{ts,tsx,md}", "apps/**/*.{ts,tsx,md}", "services/**/*.{ts,tsx,md}"],
      cacheable: false,
      flags: { ...compassScanFlags },
      execute: runCompassAuditBaseline,
    });
    registry.registerCommand({
      name: "compass.audit.validate",
      description:
        "Validate that no authored file is audit-overdue per the revision threshold (RFC-0352). Warns by default, fails with --strict.",
      scope: "workspace",
      supportsAllSites: true,
      flags: {
        ...compassScanFlags,
        strict: {
          kind: "boolean",
          description: "Fail when audit-overdue authored files are found.",
        },
      },
      reads: [
        "packages/**/*.{ts,tsx,md}",
        "apps/**/*.{ts,tsx,md}",
        "services/**/*.{ts,tsx,md}",
        "docs/compass-audit-ledger.generated.yaml",
      ],
      execute: runCompassAuditValidate,
      gate: {
        severity: "mixed",
        phase: "author",
        conditional: {
          kind: "flag",
          ref: "--strict",
          description: "Warns by default, fails with --strict",
        },
      },
    });
  },
};
