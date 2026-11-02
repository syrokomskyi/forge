/*
<MODULE_CONTRACT>
<purpose>Register forge Werkstatt lock and operation validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement werkstatt handler logic — delegate to handlers/ inlined by RFC-0556.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
  <item>RFC-1248: VITE-CLIENT-DEP-02 lazy-import gate + SCAN-02 validator reads-root existence check (RFC-1248)</item>
  <item>RFC-1462: isolate parallel agent sessions in per-session git worktrees — session.open/close/status, registry, commit overlap warning</item>
  <item>RFC-1462: repair RFC-1462 session-worktree r1 findings — last-commit status, real inside-worktree skip, loud residue commit</item>
  <item>RFC-1487: step 7 — remove RFC-1462 session-worktree paths, COMMIT-FGN-01 guard, and .sessions model; document flow lifecycle</item>
  <history>RFC-0374, RFC-0556, RFC-1173, RFC-1360</history>
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
      coverage: "operator" as const,
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
      coverage: "operator" as const,
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
      writes: [
        ".werkstatt/locks/**",
        "systems/*.tmp",
        "systems/*.staging-*",
        "systems/*.incomplete",
        "systems/*.failed-*",
        "missions/*.tmp",
        "missions/*.staging-*",
        "missions/*.incomplete",
        "missions/*.failed-*",
        "releases/*.tmp",
        "releases/*.staging-*",
        "releases/*.incomplete",
        "releases/*.failed-*",
      ],
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
      reads: ["packages/werkstatt-engine/src/handoff/**/*.ts"],
      execute: runWerkstattOperationValidate,
    },
  ],
  pipelines: [],
};
