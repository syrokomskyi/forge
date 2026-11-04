/*
<MODULE_CONTRACT>
<purpose>Register the forge-system commands with the forge kernel registry:
system.map.validate (RFC-1508, read-only) plus the RFC-1509 task queue —
system.task.create/move/dispatch/collect/status. System commands gate on the
system profile and mutate only system-repository files; dispatch's product
side is limited to opening the task branch and writing .forge/task/.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/.</item>
  <item>No outbox, scenario or version-set commands — those are RFC-1510..1511.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 3 — forge-system module registration</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
  <item>RFC-1508: align rfc-1508 schemas with the normative contract after review r1</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeSystemModule(): Promise<ForgeModule> {
  const { runSystemMapValidate } = await import("./handlers/system-map-validate.ts");
  const { runSystemTaskCreate } = await import("./handlers/system-task-create.ts");
  const { runSystemTaskMove } = await import("./handlers/system-task-move.ts");
  const { runSystemTaskDispatch } = await import("./handlers/system-task-dispatch.ts");
  const { runSystemTaskCollect } = await import("./handlers/system-task-collect.ts");
  const { runSystemTaskStatus } = await import("./handlers/system-task-status.ts");
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
      {
        name: "system.task.create",
        description:
          "Create a system task (RFC-1509). Allocates the next T-NNNN id, " +
          "writes queue/tasks/<id>.yaml (forge/system-task@1, state proposed) " +
          "and a dispatch-brief scaffold at queue/briefs/<id>.md. Requires " +
          "the system profile (SYSTEM-01) and a declared product " +
          "(SYSTEM-TASK-05). Writes files only — the session commits.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-MAP-01", severity: "error" },
          { id: "SYSTEM-TASK-01", severity: "error" },
          { id: "SYSTEM-TASK-05", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "not-idempotent",
        writes: ["queue/tasks/", "queue/briefs/"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "task creation — the operator or an outbox/scenario command creates cross-product work (RFC-1509)",
        reads: [
          "forge.yaml",
          "system/system.yaml",
          "system/products.yaml",
          "system/edges.yaml",
          "queue/tasks/",
        ],
        cacheable: false,
        flags: {
          product: { kind: "string", required: true, description: "Product id from system/products.yaml" },
          slug: { kind: "string", required: true, description: "kebab-case slug for the product branch" },
          title: { kind: "string", required: true, description: "Human-readable task title" },
          kind: { kind: "string", required: true, description: "change | adoption | dependency-update | verification" },
          contracts: { kind: "string[]", description: "Contracts the task touches (repeatable)" },
          "depends-on": { kind: "string[]", description: "Task ids that must be done first (repeatable)" },
          origin: { kind: "string", description: "<kind>:<ref> — operator | outbox | decision | scenario (default operator)" },
          reason: { kind: "string", description: "Optional note recorded on the creation history row" },
          "dry-run": { kind: "boolean", description: "Plan only — write nothing" },
        },
        execute: runSystemTaskCreate,
      },
      {
        name: "system.task.move",
        description:
          "Move a system task between states (RFC-1509). Owns every move-side " +
          "transition: proposed→ready (brief valid, dependencies done, no " +
          "forbidden edge), proposed→cancelled, ready/failed→parked, " +
          "parked→ready, reported→ready, failed→ready (each requiring " +
          "--reason where the table says so), integrated→verified " +
          "(--version-set must list the product) and verified→done. " +
          "Illegal transitions refuse with SYSTEM-TASK-02; forbidden edges " +
          "with SYSTEM-TASK-03; undeclared edges warn with SYSTEM-TASK-04.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-MAP-01", severity: "error" },
          { id: "SYSTEM-TASK-01", severity: "error" },
          { id: "SYSTEM-TASK-02", severity: "error" },
          { id: "SYSTEM-TASK-03", severity: "error" },
          { id: "SYSTEM-TASK-04", severity: "warning" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        writes: ["queue/tasks/"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "task state machine — the operator moves tasks; dispatch/collect own their transitions (RFC-1509)",
        reads: [
          "forge.yaml",
          "system/system.yaml",
          "system/products.yaml",
          "system/edges.yaml",
          "system/version-sets/",
          "queue/tasks/",
          "queue/briefs/",
        ],
        cacheable: false,
        flags: {
          task: { kind: "string", required: true, description: "Task id T-NNNN" },
          to: { kind: "string", required: true, description: "Target state" },
          reason: { kind: "string", description: "Required by transitions the table marks reason-bearing" },
          "version-set": { kind: "string", description: "Required for integrated → verified — names system/version-sets/<id>.yaml" },
          "dry-run": { kind: "boolean", description: "Plan only — write nothing" },
        },
        execute: runSystemTaskMove,
      },
      {
        name: "system.task.dispatch",
        description:
          "Dispatch a ready task into its product repository (RFC-1509). " +
          "Resolves the product folder from products.local.yaml " +
          "(SYSTEM-TASK-05), refuses forbidden edges (SYSTEM-TASK-03), warns " +
          "on undeclared ones (SYSTEM-TASK-04), refuses briefs that leak " +
          "system identity or sibling product folders (SYSTEM-TASK-06), then " +
          "opens an auto/task-… branch in-process, git-excludes .forge/task/, " +
          "writes the brief into the worktree and records dispatch on the " +
          "task. An optional launcher argv from products.local.yaml runs " +
          "best-effort (SYSTEM-TASK-09). Never commits or pushes in the " +
          "product.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-MAP-01", severity: "error" },
          { id: "SYSTEM-TASK-01", severity: "error" },
          { id: "SYSTEM-TASK-02", severity: "error" },
          { id: "SYSTEM-TASK-03", severity: "error" },
          { id: "SYSTEM-TASK-04", severity: "warning" },
          { id: "SYSTEM-TASK-05", severity: "error" },
          { id: "SYSTEM-TASK-06", severity: "error" },
          { id: "SYSTEM-TASK-09", severity: "warning" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-OPEN-01", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "error" },
          { id: "FLOW-OPEN-03", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-05", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        writes: ["queue/tasks/", "<product>/info/exclude", "<product>/.forge/task/"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "task dispatch — opens a product task branch and hands the operator the worktree (RFC-1509)",
        reads: [
          "forge.yaml",
          "system/system.yaml",
          "system/products.yaml",
          "system/edges.yaml",
          "system/products.local.yaml",
          "queue/tasks/",
          "queue/briefs/",
        ],
        cacheable: false,
        flags: {
          task: { kind: "string", required: true, description: "Task id T-NNNN (must be ready)" },
          "dry-run": { kind: "boolean", description: "Plan only — open no branch, write nothing" },
        },
        execute: runSystemTaskDispatch,
      },
      {
        name: "system.task.collect",
        description:
          "Collect a task report from the product side (RFC-1509). Reads " +
          ".forge/task/report.yaml in the dispatch worktree, falling back to " +
          "the preserved copy under the product's common git dir. Missing " +
          "report refuses SYSTEM-TASK-07 unless --mark-failed --reason; an " +
          "invalid or wrong-task report refuses SYSTEM-TASK-08. A valid " +
          "report is copied to queue/reports/; done|needs-decision → " +
          "reported, blocked → failed. A product journal integrate event " +
          "for the dispatch branch then advances to integrated with the " +
          "journal sha as integratedCommit. Read-only in the product.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-MAP-01", severity: "error" },
          { id: "SYSTEM-TASK-01", severity: "error" },
          { id: "SYSTEM-TASK-02", severity: "error" },
          { id: "SYSTEM-TASK-05", severity: "error" },
          { id: "SYSTEM-TASK-07", severity: "error" },
          { id: "SYSTEM-TASK-08", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        writes: ["queue/tasks/", "queue/reports/"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "report collection — the operator collects after the product session finishes (RFC-1509)",
        reads: [
          "forge.yaml",
          "system/system.yaml",
          "system/products.yaml",
          "system/products.local.yaml",
          "queue/tasks/",
          "<product>/.forge/task/report.yaml",
          "<product>/.git/forge/tasks/",
          "<product>/.git/forge/journal.jsonl",
        ],
        cacheable: false,
        flags: {
          task: { kind: "string", required: true, description: "Task id T-NNNN (dispatched or reported)" },
          "mark-failed": { kind: "boolean", description: "Mark the task failed instead of collecting a report" },
          reason: { kind: "string", description: "Required with --mark-failed" },
          "dry-run": { kind: "boolean", description: "Plan only — write nothing" },
        },
        execute: runSystemTaskCollect,
      },
      {
        name: "system.task.status",
        description:
          "Project every system task plus product-side flow evidence " +
          "(RFC-1509). The task file is authoritative for state; dispatched " +
          "tasks also report productStatus: registered, integrated, " +
          "discarded, orphaned (no registry entry and no journal event) or " +
          "unknown (product repo unreadable). Read-only.",
        scope: "workspace",
        contract: "system",
        rules: [
          { id: "SYSTEM-01", severity: "error" },
          { id: "SYSTEM-TASK-01", severity: "error" },
        ],
        mutatesState: false,
        writes: [],
        generates: [],
        coverage: "operator",
        coverageNote:
          "task overview — the operator's queue dashboard before collect/move decisions (RFC-1509)",
        reads: [
          "forge.yaml",
          "system/products.yaml",
          "system/products.local.yaml",
          "queue/tasks/",
          "<product>/.git/forge/registry.yaml",
          "<product>/.git/forge/journal.jsonl",
        ],
        cacheable: false,
        flags: {
          task: { kind: "string", description: "Limit the projection to one task id" },
        },
        execute: runSystemTaskStatus,
      },
    ],
    pipelines: [],
  };
}
