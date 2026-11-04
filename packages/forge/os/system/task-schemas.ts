/*
<MODULE_CONTRACT>
<purpose>Task-queue schemas for the system repository (RFC-1509): the
forge/system-task@1 task file, forge/dispatch-brief@1 brief frontmatter and
forge/task-report@1 product report, plus the task state machine expressed as
data. Every object is strict — a typo in a task file is a SYSTEM-TASK-01/08
diagnostic, never silently stripped.</purpose>
<non-goals>
  <item>No store or handler logic — schemas and the transition table only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 2 — task schemas and transition table</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

// ---------------------------------------------------------------------------
// States, kinds, transitions
// ---------------------------------------------------------------------------

export const TASK_STATES = [
  "proposed",
  "ready",
  "dispatched",
  "reported",
  "integrated",
  "verified",
  "done",
  "failed",
  "parked",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_KINDS = [
  "change",
  "adoption",
  "dependency-update",
  "verification",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskTransitionOwner = "move" | "dispatch" | "collect";

export interface TaskTransition {
  from: TaskState;
  to: TaskState;
  /** The command allowed to apply this transition. */
  owner: TaskTransitionOwner;
  /** Transitions that require --reason. */
  needsReason?: boolean;
}

/** The RFC-1509 transition table, as data. Any pair absent here is SYSTEM-TASK-02. */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  { from: "proposed", to: "ready", owner: "move" },
  { from: "proposed", to: "cancelled", owner: "move", needsReason: true },
  { from: "ready", to: "dispatched", owner: "dispatch" },
  { from: "ready", to: "parked", owner: "move", needsReason: true },
  { from: "failed", to: "parked", owner: "move", needsReason: true },
  { from: "parked", to: "ready", owner: "move" },
  { from: "dispatched", to: "reported", owner: "collect" },
  { from: "dispatched", to: "failed", owner: "collect" },
  { from: "reported", to: "integrated", owner: "collect" },
  { from: "reported", to: "ready", owner: "move", needsReason: true },
  { from: "failed", to: "ready", owner: "move" },
  { from: "integrated", to: "verified", owner: "move" },
  { from: "verified", to: "done", owner: "move" },
];

export function findTransition(
  from: TaskState,
  to: TaskState,
): TaskTransition | null {
  return TASK_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

// ---------------------------------------------------------------------------
// forge/system-task@1
// ---------------------------------------------------------------------------

export const TASK_ID_RE = /^T-\d{4}$/;

export const systemTaskSchema = z
  .object({
    schema: z.literal("forge/system-task@1"),
    id: z.string().regex(TASK_ID_RE),
    title: z.string().min(1),
    product: z.string().min(1),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .min(3)
      .max(48),
    kind: z.enum(TASK_KINDS),
    state: z.enum(TASK_STATES),
    origin: z
      .object({
        kind: z.enum(["operator", "outbox", "decision", "scenario"]),
        ref: z.string().nullable(),
      })
      .strict(),
    contracts: z.array(z.string().min(1)).default([]),
    dependsOn: z.array(z.string().regex(TASK_ID_RE)).default([]),
    brief: z.string().min(1),
    briefSha256: z.string().nullable(),
    dispatch: z
      .object({
        branch: z.string().min(1),
        worktree: z.string().min(1),
        baseCommit: z.string().min(1),
        dispatchedAt: z.string().min(1),
      })
      .strict()
      .nullable(),
    report: z.string().nullable(),
    integratedCommit: z.string().nullable(),
    history: z.array(
      z
        .object({
          at: z.string(),
          from: z.string(),
          to: z.string(),
          by: z.string(),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type SystemTask = z.infer<typeof systemTaskSchema>;

// ---------------------------------------------------------------------------
// forge/dispatch-brief@1 — frontmatter of queue/briefs/<id>.md
// ---------------------------------------------------------------------------

export const dispatchBriefFrontmatterSchema = z
  .object({
    schema: z.literal("forge/dispatch-brief@1"),
    task: z.string().regex(TASK_ID_RE),
    product: z.string().min(1),
    goal: z.string().min(1),
    acceptance: z
      .array(
        z
          .object({ claim: z.string().min(1), check: z.string().min(1) })
          .strict(),
      )
      .min(1),
    constraints: z.array(z.string()).default([]),
  })
  .strict();

export type DispatchBriefFrontmatter = z.infer<typeof dispatchBriefFrontmatterSchema>;

// ---------------------------------------------------------------------------
// forge/task-report@1 — .forge/task/report.yaml in the product worktree
// ---------------------------------------------------------------------------

export const taskReportSchema = z
  .object({
    schema: z.literal("forge/task-report@1"),
    task: z.string().regex(TASK_ID_RE),
    outcome: z.enum(["done", "blocked", "needs-decision"]),
    summary: z.string().min(1),
    commits: z.array(z.string()).default([]),
    gate: z.enum(["pass", "fail", "not-run"]),
    acceptance: z
      .array(z.object({ claim: z.string(), evidence: z.string() }).strict())
      .default([]),
    outbox: z.array(z.string()).default([]),
    question: z.string().optional(),
  })
  .strict();

export type TaskReport = z.infer<typeof taskReportSchema>;
