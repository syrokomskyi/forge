/*
<MODULE_CONTRACT>
<purpose>Register the forge Compass command family against the Site OS kernel registry.</purpose>
<non-goals>
  <item>Do not implement compass handler logic — delegate to handlers/ inlined by RFC-0556.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <item>RFC-1097: steps 1-4 — compass.migrate codemod

Add the v1 to v2 Compass header codemod: migrateFile pure transform (collapse, strip, seed, reorder, purpose-flag actions), migrateWorkspace walker, runCompassMigrate handler with dirty-tree refusal and --force/--files/--dry-run flags, module registration, and 15 unit tests.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>KERNEL-FLAG-02: Declare compass --root as kind "string[]" — resolveScanRoots reads it as multi-value via getFlagValues, so repeated --root stays legal now that repeated kind-"string" flags are rejected at flag resolution.</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
  <history>RFC-0374, RFC-0538, RFC-0556</history>
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
import { runCompassSummaryTrim } from "./handlers/compass-change-summary-handler.ts";
import { runCompassSummaryRecord } from "./handlers/summary-record.ts";
import { runCompassMigrate } from "./handlers/compass-migrate-handler.ts";

const compassScanFlags = {
  packages: {
    kind: "boolean",
    description: "Scan packages/ instead of the inferred app or default workspace scope.",
  },
  package: {
    kind: "string",
    description: "Scan one package by directory/name (implies --packages).",
  },
  workpiece: {
    kind: "string",
    description:
      "Scan a mission workpiece directory (RFC-0617). Mutually exclusive with --packages and --site.",
  },
  root: {
    kind: "string[]",
    description:
      "Scan root directory (repeatable — overrides the universal --root workspace override on scan commands).",
  },
} satisfies Record<string, ForgeFlagSpec>;

// RFC-1094: --mode governs v2 rule severity on the two validating commands only.
const compassModeFlag = {
  kind: "string",
  description: "v2 rule severity: warning (default, transition window) or error (post-migration).",
} satisfies ForgeFlagSpec;

export const forgeCompassModule: ForgeModule = {
  name: "forge-compass",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "compass.inventory",
      mutatesState: true,
      description: "Generate the repository-wide Compass source inventory XML report.",
      scope: "workspace",
      acceptsAllFlag: true,
      flags: { ...compassScanFlags },
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      execute: runCompassInventory,
    },
    {
      name: "compass.validate",
      mutatesState: false,
      contract: "compass",
      rules: [],
      description:
        "Validate authored source files against current Compass scaffolding requirements.",
      scope: "workspace",
      acceptsAllFlag: true,
      flags: { ...compassScanFlags, mode: compassModeFlag },
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "docs/source-markup.xml",
      ],
      execute: runCompassValidation,
    },
    {
      name: "compass.summary.record",
      description:
        "Append a governance-referencing item to each target file's CHANGE_SUMMARY and collapse the 5-item window into <history> (RFC-1095). Invoked by commit commands when a commit carries an RFC/ADR reference. Required flags: `--id`.",
      scope: "workspace",
      mutatesState: true,
      acceptsAllFlag: true,
      writes: [
        "apps/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "packages/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      generates: [],
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      cacheable: false,
      flags: {
        ...compassScanFlags,
        id: {
          kind: "string",
          required: true,
          description: "Governance ID to record (e.g. RFC-1095, ADR-0042).",
        },
        files: {
          kind: "string[]",
          description:
            "Target files (repo-relative, or workpiece-relative with --workpiece). Commit integrations pass the commit's changed-file set.",
        },
        text: {
          kind: "string",
          description:
            "Item description. Default: commit subject minus conventional prefix; bare ID outside commit context.",
        },
      },
      execute: runCompassSummaryRecord,
    },
    {
      name: "compass.summary.trim",
      description:
        "Repair CHANGE_SUMMARY blocks to the v2 shape: collapse described items past 5 into <history>, remove ID-less items, normalize <history> (RFC-1095).",
      scope: "workspace",
      mutatesState: true,
      acceptsAllFlag: true,
      writes: [
        "apps/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "packages/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      generates: [],
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      cacheable: false,
      flags: {
        ...compassScanFlags,
        mode: {
          kind: "string",
          description: "Repair mode: repair (default, only mode — reserved for future modes).",
        },
      },
      execute: runCompassSummaryTrim,
    },
    {
      name: "compass.migrate",
      description:
        "Rewrite authored file headers to the Compass v2 shape (RFC-1097): collapse CHANGE_SUMMARY into <history>, strip forbidden v1 blocks, seed KEY_DECISIONS from @ai-invariant comments, reorder blocks canonically. Refuses a dirty git tree unless --force.",
      scope: "workspace",
      mutatesState: true,
      acceptsAllFlag: true,
      writes: [
        "apps/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "packages/**/*.{astro,ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      generates: [],
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      cacheable: false,
      flags: {
        ...compassScanFlags,
        files: {
          kind: "string[]",
          description: "Explicit root-relative file list — bypasses scan-root filtering entirely.",
        },
        "dry-run": {
          kind: "boolean",
          description: "Print the action manifest without writing any file.",
        },
        force: {
          kind: "boolean",
          description: "Override the dirty-tree refusal.",
        },
      },
      execute: runCompassMigrate,
    },
    {
      name: "compass.audit.plan",
      mutatesState: false,
      execOnReadOnly: true,
      description:
        "Emit a deterministic work-order of files whose revision has advanced past the threshold since their last Compass audit (RFC-0352). Read-only, no LLM.",
      scope: "workspace",
      acceptsAllFlag: true,
      flags: {
        ...compassScanFlags,
        threshold: {
          kind: "string",
          description: "Revision distance that makes a file audit-overdue.",
        },
      },
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "docs/compass-audit-ledger.generated.yaml",
      ],
      execute: runCompassAuditPlan,
    },
    {
      name: "compass.audit.record",
      modulePath: "packages/forge/os/compass/compass.module.ts",
      description:
        "Stamp a file's audit verdict and current revision into the compass-audit ledger (RFC-0352). Mutating. Required flags: `--file`, `--verdict`.",
      scope: "workspace",
      mutatesState: true,
      acceptsAllFlag: true,
      writes: ["docs/compass-audit-ledger.generated.yaml"],
      generates: [{ path: "docs/compass-audit-ledger.generated.yaml", phase: "on-demand" }],
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
    },
    {
      name: "compass.audit.baseline",
      modulePath: "packages/forge/os/compass/compass.module.ts",
      description:
        "Seed the compass-audit ledger for every authored file at its current revision with verdict=baseline (RFC-0352). One-time bootstrap.",
      scope: "workspace",
      mutatesState: true,
      acceptsAllFlag: true,
      writes: ["docs/compass-audit-ledger.generated.yaml"],
      // Artifact ownership is claimed by compass.audit.record (GENERATES-PATH-
      // COLLISION forbids two owners on a non-glob path); baseline only writes it.
      generates: [],
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
      ],
      cacheable: false,
      flags: { ...compassScanFlags },
      execute: runCompassAuditBaseline,
    },
    {
      name: "compass.audit.validate",
      mutatesState: false,
      execOnReadOnly: true,
      contract: "compass",
      rules: [],
      description:
        "Validate that no authored file is audit-overdue per the revision threshold (RFC-0352). Warns by default, fails with --strict.",
      scope: "workspace",
      acceptsAllFlag: true,
      flags: {
        ...compassScanFlags,
        strict: {
          kind: "boolean",
          description: "Fail when audit-overdue authored files are found.",
        },
      },
      reads: [
        "packages/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "apps/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
        "services/**/*.{ts,tsx,astro,js,mjs,css,cs,tscn,tres,gd,md}",
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
    },
  ],
  pipelines: [],
};
