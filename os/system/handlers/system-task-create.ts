/*
<MODULE_CONTRACT>
<purpose>system.task.create (RFC-1509) — allocate the next T-NNNN id, write
queue/tasks/&lt;id&gt;.yaml (forge/system-task@1, state proposed) and a brief
scaffold at queue/briefs/&lt;id&gt;.md (forge/dispatch-brief@1 frontmatter
with a placeholder goal). Writes files only — the session commits.</purpose>
<non-goals>
  <item>No dispatch/collect logic — move owns readiness checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 3 — system.task.create handler</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { assertSystemRepository, loadSystemMap } from "../repo.ts";
import { TASK_KINDS, type SystemTask } from "../task-schemas.ts";
import {
  briefFilePath,
  nextTaskId,
  taskFilePath,
  writeTask,
} from "../task-store.ts";
import path from "node:path";

export const BRIEF_GOAL_PLACEHOLDER = "TODO: describe the task goal";

export interface SystemTaskCreateResult {
  command: "system.task.create";
  created: boolean;
  task: string | null;
  files: string[];
  diagnostics: Diagnostic[];
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function flagList(input: ForgeCommandInput, name: string): string[] {
  const v = input.flags[name];
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  return typeof v === "string" && v.length > 0 ? [v] : [];
}

/** `--origin` grammar: `<kind>` or `<kind>:<ref>` (ref may itself contain colons). */
function parseOrigin(
  raw: string | null,
): { kind: "operator" | "outbox" | "decision" | "scenario"; ref: string | null } | null {
  if (raw === null) return { kind: "operator", ref: null };
  const idx = raw.indexOf(":");
  const kind = idx === -1 ? raw : raw.slice(0, idx);
  const ref = idx === -1 ? null : raw.slice(idx + 1);
  if (kind !== "operator" && kind !== "outbox" && kind !== "decision" && kind !== "scenario") {
    return null;
  }
  return { kind, ref: ref === "" ? null : ref };
}

function briefScaffold(id: string, product: string): string {
  return `---
schema: forge/dispatch-brief@1
task: ${id}
product: ${product}
goal: "${BRIEF_GOAL_PLACEHOLDER}"
acceptance:
  - claim: "TODO: the claim this task must prove"
    check: "TODO: how the product session verifies it"
constraints: []
---

# ${id}

${BRIEF_GOAL_PLACEHOLDER}
`;
}

export async function runSystemTaskCreate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemTaskCreateResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  const refusal = await assertSystemRepository(root, io);
  if (refusal) diagnostics.push(refusal);

  const product = flagString(input, "product");
  const slug = flagString(input, "slug");
  const title = flagString(input, "title");
  const kind = flagString(input, "kind");
  const contracts = flagList(input, "contracts");
  const dependsOn = flagList(input, "depends-on");
  const origin = parseOrigin(flagString(input, "origin"));

  if (product === null || slug === null || title === null || kind === null) {
    diagnostics.push({
      ruleId: "SYSTEM-TASK-01",
      severity: "error",
      message: "--product, --slug, --title and --kind are required",
      fixHint: "see forge system.task.create --help",
    });
  } else if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    diagnostics.push({
      ruleId: "SYSTEM-TASK-01",
      severity: "error",
      message: `invalid --kind '${kind}' — one of ${TASK_KINDS.join(", ")}`,
      fixHint: "pick a declared task kind",
    });
  }
  if (origin === null) {
    diagnostics.push({
      ruleId: "SYSTEM-TASK-01",
      severity: "error",
      message: `--origin must start with operator|outbox|decision|scenario (e.g. outbox:werkstatt:OB-0003)`,
      fixHint: "pass --origin <kind>:<ref> or omit it",
    });
  }
  for (const dep of dependsOn) {
    if (!/^T-\d{4}$/.test(dep)) {
      diagnostics.push({
        ruleId: "SYSTEM-TASK-01",
        severity: "error",
        message: `--depends-on '${dep}' is not a task id (T-NNNN)`,
      });
    }
  }

  // The product must exist in the map — SYSTEM-TASK-05.
  if (diagnostics.length === 0) {
    const loaded = await loadSystemMap(root, io);
    diagnostics.push(...loaded.diagnostics.filter((d) => d.ruleId === "SYSTEM-MAP-01"));
    if (loaded.map) {
      const known = loaded.map.products.products.some((p) => p.id === product);
      if (!known) {
        diagnostics.push({
          ruleId: "SYSTEM-TASK-05",
          severity: "error",
          message: `product '${product}' is not declared in system/products.yaml`,
          fixHint: "add the product to system/products.yaml or fix --product",
        });
      }
    }
  }

  let id: string | null = null;
  let task: SystemTask | null = null;
  const files: string[] = [];
  if (diagnostics.every((d) => d.severity !== "error")) {
    id = await nextTaskId(root, io);
    task = {
      schema: "forge/system-task@1",
      id,
      title: title!,
      product: product!,
      slug: slug!,
      kind: kind as SystemTask["kind"],
      state: "proposed",
      origin: origin!,
      contracts,
      dependsOn,
      brief: path.posix.join("queue/briefs", `${id}.md`),
      briefSha256: null,
      dispatch: null,
      report: null,
      integratedCommit: null,
      history: [
        {
          at: new Date().toISOString(),
          from: "none",
          to: "proposed",
          by: "operator",
          ...(flagString(input, "reason") ? { reason: flagString(input, "reason")! } : {}),
        },
      ],
    };
    files.push(taskFilePath(root, id), briefFilePath(root, id));
  }

  if (task && !dryRun) {
    await writeTask(root, io, task);
    await io.mkdir(path.dirname(briefFilePath(root, id!)));
    await io.writeFile(briefFilePath(root, id!), briefScaffold(id!, product!));
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: {
      command: "system.task.create",
      created: task !== null && !dryRun,
      task: id,
      files: dryRun ? files : files.filter((f) => f !== null),
      diagnostics,
    },
    exitCode: errors > 0 ? 1 : 0,
    summary:
      task === null
        ? `system.task.create refused (${errors} error(s))`
        : dryRun
          ? `system.task.create would write ${id} (task + brief scaffold)`
          : `system.task.create wrote ${id} at queue/tasks/${id}.yaml + queue/briefs/${id}.md`,
    nextSteps:
      task === null
        ? [{ action: "Fix the error diagnostics and re-run system.task.create", kind: "required" }]
        : dryRun
          ? []
          : [
              {
                action: `Edit queue/briefs/${id}.md — fill goal and acceptance, then system.task.move --task ${id} --to ready`,
                kind: "required",
              },
            ],
  };
}
