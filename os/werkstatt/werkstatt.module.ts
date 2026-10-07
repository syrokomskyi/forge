/*
<MODULE_CONTRACT>
<purpose>Register forge Werkstatt lock and operation validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement werkstatt handler logic — delegate to handlers/ inlined by RFC-0556.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeWerkstattModule registering 3 werkstatt commands.</item>
  <item>RFC-0556: removed dynamic imports of @warpgogol/site-kernel-handoff and @warpgogol/site-kernel-checks, all handlers now inlined in forge/os/werkstatt/handlers/.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runWerkstattLockStatus } from "./handlers/werkstatt-lock-status.ts";
import { runWerkstattLockRecover } from "./handlers/werkstatt-lock-recover.ts";
import { runWerkstattOperationValidate } from "./handlers/werkstatt-operation-validate.ts";

export const forgeWerkstattModule: ForgeModule = {
  name: "forge-werkstatt",
  version: "0.1.0",
  runtime: "werkstatt-adapter",
  declarations: [],
  commands: [
    {
      name: "werkstatt.lock.status",
      mutatesState: false,
      description: "Report all Werkstatt locks, their age, owner, and staleness (RFC-0362).",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: [".werkstatt/locks/**"],
      execute: runWerkstattLockStatus,
    },
    {
      name: "werkstatt.lock.recover",
      description:
        "Classify and clean stale locks and staging artifacts (RFC-0362). Flags: --scope, --purge.",
      scope: "workspace",
      acceptsAllFlag: false,
      mutatesState: true,
      flags: {
        scope: { kind: "string", description: "Recover only a single lock scope." },
        purge: {
          kind: "boolean",
          description: "Remove stale artifacts instead of classifying them.",
        },
      },
      writes: [".werkstatt/locks/**", "systems/**", "missions/**", "releases/**"],
      generates: [],
      reads: [".werkstatt/locks/**"],
      cacheable: false,
      execute: runWerkstattLockRecover,
    },
    {
      name: "werkstatt.operation.validate",
      mutatesState: false,
      contract: "werkstatt",
      rules: [],
      description:
        "Validate that mutating Werkstatt commands use shared lock/idempotency/atomic-write helpers (RFC-0362).",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["packages/os/site-kernel-handoff/src/**/*.ts"],
      execute: runWerkstattOperationValidate,
    },
  ],
  pipelines: [],
};
