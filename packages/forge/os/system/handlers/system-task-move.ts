/*
<MODULE_CONTRACT>
<purpose>system.task.move (RFC-1509) — the state-machine command. Applies
every move-owned transition (proposed→ready/cancelled, ready/failed→parked,
parked→ready, reported→ready, failed→ready, integrated→verified,
verified→done) and refuses everything else with SYSTEM-TASK-02. Ready-checks
validate the dispatch-brief frontmatter, dependency completion and edge
verdicts; verified-checks name a version-set file that lists the product.</purpose>
<non-goals>
  <item>No dispatch or collect transitions — those live in their own commands.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 3 — system.task.move handler</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1509: close RFC-1509 review r1 findings — mark-failed escape, open-error refusal, dry-run coverage</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { assertSystemRepository, edgeVerdict, loadSystemMap, type SystemMap } from "../repo.ts";
import {
  dispatchBriefFrontmatterSchema,
  findTransition,
  TASK_STATES,
  type SystemTask,
  type TaskState,
} from "../task-schemas.ts";
import { readBrief, readTask, writeTask } from "../task-store.ts";
import { BRIEF_GOAL_PLACEHOLDER } from "./system-task-create.ts";

export interface SystemTaskMoveResult {
  command: "system.task.move";
  task: string | null;
  from: TaskState | null;
  to: TaskState | null;
  moved: boolean;
  diagnostics: Diagnostic[];
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function refusal(
  ruleId: string,
  message: string,
  fixHint?: string,
  file?: string,
): Diagnostic {
  return { ruleId, severity: "error", message, ...(fixHint ? { fixHint } : {}), ...(file ? { file } : {}) };
}

/**
 * The `→ ready` check (proposed / parked / failed → ready): brief frontmatter
 * must validate and carry a real goal, every dependsOn task must be done, and
 * every contract edge must be non-forbidden. Failure → SYSTEM-TASK-02 diag;
 * forbidden → SYSTEM-TASK-03; undeclared → SYSTEM-TASK-04 warning.
 */
async function readyChecks(
  root: string,
  io: Parameters<typeof loadSystemMap>[1],
  map: SystemMap,
  task: SystemTask,
  diagnostics: Diagnostic[],
): Promise<void> {
  const brief = await readBrief(root, io, task.id);
  if (brief === null || brief.frontmatter === null) {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} → ready: queue/briefs/${task.id}.md is missing or its frontmatter is not YAML`,
        "create the dispatch brief before moving to ready",
      ),
    );
  } else {
    const parsed = dispatchBriefFrontmatterSchema.safeParse(brief.frontmatter);
    if (!parsed.success) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id} → ready: brief frontmatter fails forge/dispatch-brief@1 — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
          "fix the brief frontmatter per the schema",
        ),
      );
    } else if (parsed.data.goal.trim() === BRIEF_GOAL_PLACEHOLDER) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id} → ready: brief goal is still the create-scaffold placeholder`,
          "write the real goal in the brief frontmatter",
        ),
      );
    } else if (parsed.data.task !== task.id || parsed.data.product !== task.product) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id} → ready: brief frontmatter names task=${parsed.data.task} product=${parsed.data.product}, expected ${task.id} / ${task.product}`,
          "fix the frontmatter — the brief must be bound to this task",
        ),
      );
    }
  }

  for (const dep of task.dependsOn) {
    const { task: depTask, diagnostic } = await readTask(root, io, dep);
    if (diagnostic) {
      diagnostics.push(
        refusal("SYSTEM-TASK-02", `${task.id} → ready: ${diagnostic.message}`),
      );
    } else if (depTask && depTask.state !== "done") {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id} → ready: dependency ${dep} is ${depTask.state}, not done`,
          `finish ${dep} first or drop it from dependsOn`,
        ),
      );
    }
  }

  for (const contract of task.contracts) {
    const verdict = edgeVerdict(map, task.product, contract);
    if (verdict === "forbidden") {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-03",
          `${task.id} → ready: contract '${contract}' is a forbidden edge for ${task.product}`,
          "renegotiate the edge in system/edges.yaml before dispatching",
        ),
      );
    } else if (verdict === "undeclared") {
      diagnostics.push({
        ruleId: "SYSTEM-TASK-04",
        severity: "warning",
        message: `${task.id} → ready: contract '${contract}' is undeclared for ${task.product} — allowed, but declare it in system/edges.yaml`,
      });
    }
  }
}

/**
 * `integrated → verified` check: --version-set <id> must name a file
 * system/version-sets/<id>.yaml listing task.product.
 */
async function verifiedChecks(
  root: string,
  io: Parameters<typeof loadSystemMap>[1],
  task: SystemTask,
  versionSet: string | null,
  diagnostics: Diagnostic[],
): Promise<void> {
  if (versionSet === null) {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} → verified: --version-set <id> is required`,
        "pass the verified version-set id published by the system repo",
      ),
    );
    return;
  }
  const file = path.join(root, "system", "version-sets", `${versionSet}.yaml`);
  if (!(await io.exists(file))) {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} → verified: no version-set file at system/version-sets/${versionSet}.yaml`,
        "publish the version-set file first (RFC-1511)",
      ),
    );
    return;
  }
  try {
    const raw = YAML.parse(await io.readFile(file));
    const products =
      raw !== null && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).products)
        ? ((raw as Record<string, unknown>).products as unknown[])
        : [];
    const listed = products.some(
      (p) =>
        p === task.product ||
        (p !== null && typeof p === "object" && (p as Record<string, unknown>).id === task.product),
    );
    if (!listed) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id} → verified: version-set ${versionSet} does not list product ${task.product}`,
          "pick the version-set that verified this product",
        ),
      );
    }
  } catch (error) {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} → verified: system/version-sets/${versionSet}.yaml is not readable YAML: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

export async function runSystemTaskMove(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemTaskMoveResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  const refusalDiag = await assertSystemRepository(root, io);
  if (refusalDiag) diagnostics.push(refusalDiag);

  const id = flagString(input, "task");
  const to = flagString(input, "to");
  const reason = flagString(input, "reason");
  const versionSet = flagString(input, "version-set");

  if (id === null || to === null) {
    diagnostics.push(
      refusal("SYSTEM-TASK-02", "--task and --to are required", "see forge system.task.move --help"),
    );
  }

  let task: SystemTask | null = null;
  let from: TaskState | null = null;
  if (diagnostics.every((d) => d.severity !== "error")) {
    const loaded = await readTask(root, io, id!);
    if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
    task = loaded.task;
    from = task?.state ?? null;
  }

  let map: SystemMap | null = null;
  if (diagnostics.every((d) => d.severity !== "error") && task !== null) {
    if (!(TASK_STATES as readonly string[]).includes(to!)) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `${task.id}: '${to}' is not a task state`,
          `states: ${TASK_STATES.join(", ")}`,
        ),
      );
    } else {
      const transition = findTransition(task.state, to as TaskState);
      if (transition === null) {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-02",
            `${task.id}: ${task.state} → ${to} is not a legal transition`,
            "see the RFC-1509 transition table",
          ),
        );
      } else if (transition.owner !== "move") {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-02",
            `${task.id}: ${task.state} → ${to} is owned by system.task.${transition.owner}, not move`,
            `run system.task.${transition.owner} --task ${task.id}`,
          ),
        );
      } else if (transition.needsReason && (reason === null || reason.trim() === "")) {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-02",
            `${task.id}: ${task.state} → ${to} requires --reason`,
            "the history row records why the task changed course",
          ),
        );
      } else {
        // Load the map only when a check needs it.
        const loadedMap = await loadSystemMap(root, io);
        diagnostics.push(...loadedMap.diagnostics.filter((d) => d.ruleId === "SYSTEM-MAP-01"));
        map = loadedMap.map;
        if (to === "ready" && map !== null) {
          await readyChecks(root, io, map, task, diagnostics);
        } else if (to === "verified") {
          await verifiedChecks(root, io, task, versionSet, diagnostics);
        }
      }
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const canMove = task !== null && errors === 0;
  if (canMove && !dryRun) {
    const next = {
      ...task!,
      state: to as TaskState,
      history: [
        ...task!.history,
        {
          at: new Date().toISOString(),
          from: task!.state,
          to: to as TaskState,
          by: "operator",
          ...(reason ? { reason } : {}),
        },
      ],
    };
    await writeTask(root, io, next);
  }

  return {
    data: {
      command: "system.task.move",
      task: task?.id ?? id,
      from,
      to: (to as TaskState) ?? null,
      moved: canMove && !dryRun,
      diagnostics,
    },
    exitCode: errors > 0 ? 1 : 0,
    summary:
      task === null
        ? `system.task.move refused (${errors} error(s))`
        : canMove
          ? dryRun
            ? `system.task.move would move ${task.id} ${from} → ${to}`
            : `system.task.move moved ${task.id} ${from} → ${to}`
          : `system.task.move refused ${task.id} ${from} → ${to} (${errors} error(s))`,
    nextSteps:
      canMove && !dryRun && to === "ready"
        ? [
            {
              action: `system.task.dispatch --task ${task!.id}`,
              kind: "optional",
            },
          ]
        : [],
  };
}
