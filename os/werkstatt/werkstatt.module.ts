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
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runWerkstattLockStatus } from "./handlers/werkstatt-lock-status.ts";
import { runWerkstattLockRecover } from "./handlers/werkstatt-lock-recover.ts";
import { runWerkstattOperationValidate } from "./handlers/werkstatt-operation-validate.ts";

export const forgeWerkstattModule: ForgeModule = {
  name: "forge-werkstatt",
  version: "0.1.0",
  async register(registry) {
    registry.registerCommand({
      name: "werkstatt.lock.status",
      description: "Report all Werkstatt locks, their age, owner, and staleness (RFC-0362).",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: [".werkstatt/locks/**"],
      execute: runWerkstattLockStatus,
    });
    registry.registerCommand({
      name: "werkstatt.lock.recover",
      description:
        "Classify and clean stale locks and staging artifacts (RFC-0362). Flags: --scope, --purge.",
      scope: "workspace",
      supportsAllSites: false,
      mutatesState: true,
      flags: {
        scope: { kind: "string", description: "Recover only a single lock scope." },
        purge: {
          kind: "boolean",
          description: "Remove stale artifacts instead of classifying them.",
        },
      },
      writes: [".werkstatt/locks/**", "systems/**", "missions/**", "releases/**"],
      reads: [".werkstatt/locks/**"],
      cacheable: false,
      execute: runWerkstattLockRecover,
    });
    registry.registerCommand({
      name: "werkstatt.operation.validate",
      description:
        "Validate that mutating Werkstatt commands use shared lock/idempotency/atomic-write helpers (RFC-0362).",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: ["packages/os/site-kernel-handoff/src/**/*.ts"],
      execute: runWerkstattOperationValidate,
    });
  },
};
