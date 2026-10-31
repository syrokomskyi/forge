/*
<MODULE_CONTRACT>
<purpose>Register forge Werkstatt lock and operation validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement werkstatt handler logic — delegate to handlers/ inlined by RFC-0556.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0556: removed dynamic imports of @warpgogol/site-kernel-handoff and @warpgogol/site-kernel-checks, all handlers now inlined in forge/os/werkstatt/handlers/.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
  <item>RFC-1248: VITE-CLIENT-DEP-02 lazy-import gate + SCAN-02 validator reads-root existence check (RFC-1248)</item>
  <item>RFC-1462: isolate parallel agent sessions in per-session git worktrees — session.open/close/status, registry, commit overlap warning</item>
  <history>RFC-0374, RFC-1360</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runWerkstattLockStatus } from "./handlers/werkstatt-lock-status.ts";
import { runWerkstattLockRecover } from "./handlers/werkstatt-lock-recover.ts";
import { runWerkstattOperationValidate } from "./handlers/werkstatt-operation-validate.ts";
import { runSessionOpen } from "./handlers/session-open.ts";
import { runSessionClose } from "./handlers/session-close.ts";
import { runSessionStatus } from "./handlers/session-status.ts";

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
    {
      name: "werkstatt.session.open",
      coverage: "operator" as const,
      mutatesState: true,
      description:
        "RFC-1462: open an isolated per-session git worktree at .sessions/<id> on branch session/<id> and register it in the shared gitdir. Flags: --agent <id> (required), --brief, --resume (re-adopt a live session).",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        agent: {
          kind: "string",
          required: true,
          description: "Session/agent id — becomes .sessions/<id> and session/<id>.",
        },
        brief: { kind: "string", description: "Short description of the session's purpose." },
        resume: {
          kind: "boolean",
          description: "Re-adopt an existing live session for the same agent id.",
        },
      },
      writes: [".sessions/**"],
      generates: [],
      reads: [".git/**"],
      cacheable: false,
      execute: runSessionOpen,
    },
    {
      name: "werkstatt.session.close",
      coverage: "operator" as const,
      mutatesState: true,
      description:
        "RFC-1462: close a session — merge session/<id> into its base branch (default, refuses dirty worktrees and branch retargeting without --allow-dirty/--into) or --discard it. Rerun-safe on an already-closed session.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        session: {
          kind: "string",
          required: true,
          description: "Session id to close.",
        },
        discard: {
          kind: "boolean",
          description: "Remove the worktree and delete the branch instead of merging.",
        },
        merge: {
          kind: "boolean",
          description: "Merge the session branch (default behavior).",
        },
        "allow-dirty": {
          kind: "boolean",
          description: "Sweep a dirty worktree into a 'chore: session residue' commit before merging.",
        },
        into: {
          kind: "string",
          description: "Retarget the merge to a different base branch.",
        },
      },
      writes: [".sessions/**"],
      generates: [],
      reads: [".git/**"],
      cacheable: false,
      execute: runSessionClose,
    },
    {
      name: "werkstatt.session.status",
      coverage: "operator" as const,
      mutatesState: false,
      description:
        "RFC-1462: list registered sessions — worktree presence, dirty counts, staleness (default 24h, --stale-after <minutes>). All state is filesystem/gitdir — survives a dead agent.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        "stale-after": {
          kind: "string",
          description: "Minutes before an open session is marked stale (default 1440).",
        },
      },
      reads: [".git/**", ".sessions/**"],
      execute: runSessionStatus,
    },
  ],
  pipelines: [],
};
