/*
<MODULE_CONTRACT>
<purpose>Register forge Werkstatt lock and operation validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement werkstatt handler logic — delegate to site-kernel-handoff and site-kernel-checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeWerkstattModule registering 3 werkstatt commands.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

type ForgeExecute = (
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
) => Promise<ForgeCommandResult | void>;

export const forgeWerkstattModule: ForgeModule = {
  name: "forge-werkstatt",
  version: "0.1.0",
  async register(registry) {
    let handoff: Record<string, unknown> = {};
    let checks: Record<string, unknown> = {};
    try {
      handoff = await import(/* @vite-ignore */ "@gogol/site-kernel-handoff" as string);
    } catch {
      // Autonomous mode: @gogol/site-kernel-handoff not available.
      return;
    }
    try {
      checks = await import(/* @vite-ignore */ "@gogol/site-kernel-checks" as string);
    } catch {
      // Autonomous mode: @gogol/site-kernel-checks not available.
    }
    const { runWerkstattLockStatus, runWerkstattLockRecover } = handoff as Record<
      string,
      ForgeExecute
    >;
    const { runWerkstattOperationValidate } = checks as Record<string, ForgeExecute>;
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
