/*
<MODULE_CONTRACT>
<purpose>system.task.collect (RFC-1509) — gather the product session's task
report. Reads .forge/task/report.yaml from the dispatch worktree, falling back
to the preserved copy under &lt;common&gt;/forge/tasks/&lt;id&gt;/ when the
worktree is gone; missing report refuses with SYSTEM-TASK-07 (unless
--mark-failed --reason), schema/task-id mismatch refuses with SYSTEM-TASK-08.
A validated report is copied to queue/reports/; outcome done|needs-decision →
reported, blocked → failed. A journal `integrate` event for dispatch.branch
then advances reported → integrated with integratedCommit from the journal
sha — never from report commit ids. One call may apply dispatched → reported
→ integrated and record both history rows.</purpose>
<non-goals>
  <item>No product-side mutations — collect only reads the product repo.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 3 — system.task.collect handler</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
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
  WorkspaceIO,
} from "../../../src/types.ts";
import { commonGitDir, readJournal } from "../../flow/registry.ts";
import { assertSystemRepository, loadSystemMap, type SystemMap } from "../repo.ts";
import { taskReportSchema, type SystemTask } from "../task-schemas.ts";
import { readTask, reportFilePath, writeTask } from "../task-store.ts";

export interface SystemTaskCollectResult {
  command: "system.task.collect";
  task: string | null;
  state: SystemTask["state"] | null;
  reportFound: boolean;
  reportFile: string | null;
  integratedCommit: string | null;
  diagnostics: Diagnostic[];
}

function refusal(ruleId: string, message: string, fixHint?: string): Diagnostic {
  return { ruleId, severity: "error", message, ...(fixHint ? { fixHint } : {}) };
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function historyRow(
  task: SystemTask,
  to: SystemTask["state"],
  by: string,
  reason?: string,
): SystemTask {
  return {
    ...task,
    state: to,
    history: [
      ...task.history,
      {
        at: new Date().toISOString(),
        from: task.state,
        to,
        by,
        ...(reason ? { reason } : {}),
      },
    ],
  };
}

/** Find report.yaml — worktree first, then the preserved copy in the common dir. */
async function locateReport(
  io: WorkspaceIO,
  task: SystemTask,
  productCommon: string | null,
): Promise<{ file: string; content: string } | null> {
  const worktree = task.dispatch?.worktree ?? null;
  if (worktree !== null) {
    const candidate = path.join(worktree, ".forge", "task", "report.yaml");
    if (await io.exists(candidate)) {
      return { file: candidate, content: await io.readFile(candidate) };
    }
  }
  if (productCommon !== null) {
    const preserved = path.join(productCommon, "forge", "tasks", task.id, "report.yaml");
    if (await io.exists(preserved)) {
      return { file: preserved, content: await io.readFile(preserved) };
    }
  }
  return null;
}

export async function runSystemTaskCollect(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemTaskCollectResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const markFailed = input.flags["mark-failed"] === true;
  const reason = flagString(input, "reason");

  const refusalDiag = await assertSystemRepository(root, io);
  if (refusalDiag) diagnostics.push(refusalDiag);

  const id = flagString(input, "task");
  if (id === null) {
    diagnostics.push(refusal("SYSTEM-TASK-01", "--task is required"));
  }

  let map: SystemMap | null = null;
  let task: SystemTask | null = null;
  if (diagnostics.every((d) => d.severity !== "error")) {
    const loaded = await loadSystemMap(root, io);
    diagnostics.push(...loaded.diagnostics.filter((d) => d.ruleId === "SYSTEM-MAP-01"));
    map = loaded.map;
    const read = await readTask(root, io, id!);
    if (read.diagnostic) diagnostics.push(read.diagnostic);
    task = read.task;
  }

  if (task !== null && task.state !== "dispatched" && task.state !== "reported") {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} is ${task.state} — collect owns only dispatched → reported/failed and reported → integrated`,
      ),
    );
  }

  // Resolve the product's common git dir for preserved reports + journal.
  let productRoot: string | null = null;
  let productCommon: string | null = null;
  if (task !== null && map !== null && diagnostics.every((d) => d.severity !== "error")) {
    const folder = Object.prototype.hasOwnProperty.call(map.local?.folders ?? {}, task.product)
      ? map.local!.folders[task.product]
      : undefined;
    if (folder === undefined && task.state === "dispatched") {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-05",
          `product '${task.product}' has no folder in system/products.local.yaml`,
        ),
      );
    } else if (folder !== undefined) {
      productRoot = path.isAbsolute(folder) ? folder : path.resolve(root, folder);
      try {
        productCommon = await commonGitDir(io, productRoot);
      } catch {
        productCommon = null;
      }
    }
  }

  let reportFile: string | null = null;
  if (task !== null && diagnostics.every((d) => d.severity !== "error")) {
    const located = task.state === "dispatched" ? await locateReport(io, task, productCommon) : null;
    if (task.state === "dispatched" && located === null) {
      if (markFailed && reason !== null && reason.trim() !== "") {
        if (!dryRun) {
          task = historyRow(task, "failed", "operator", reason);
          await writeTask(root, io, task);
        }
      } else {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-07",
            `no task report for ${task.id} — checked ${task.dispatch?.worktree ?? "(no worktree)"} and the preserved copy`,
            "finish the product session or re-run with --mark-failed --reason <why>",
          ),
        );
      }
    } else if (located !== null) {
      reportFile = located.file;
      let raw: unknown = null;
      let parseError: string | null = null;
      try {
        raw = YAML.parse(located.content);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const parsed = parseError === null ? taskReportSchema.safeParse(raw) : null;
      if (parsed === null || !parsed.success) {
        const detail =
          parseError ??
          (parsed && !parsed.success
            ? parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")
            : "");
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-08",
            `task report at ${located.file} is not valid forge/task-report@1 — ${detail}`,
            "fix the report in the product session or --mark-failed --reason <why>",
          ),
        );
      } else if (parsed.data.task !== task.id) {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-08",
            `report at ${located.file} names task ${parsed.data.task}, expected ${task.id}`,
            "the report belongs to a different task",
          ),
        );
      } else if (!dryRun) {
        // Copy the validated report into the system queue.
        const dst = reportFilePath(root, task.id);
        await io.mkdir(path.dirname(dst));
        await io.writeFile(dst, located.content);
        const next: SystemTask = { ...task, report: path.posix.join("queue/reports", `${task.id}.yaml`) };
        const outcome = parsed.data.outcome;
        const target = outcome === "blocked" ? "failed" : "reported";
        task = historyRow(next, target, "collect");
        await writeTask(root, io, task);
      }
    }
  }

  // Journal check — reported → integrated when the product integrated dispatch.branch.
  if (
    task !== null &&
    task.state === "reported" &&
    task.dispatch !== null &&
    productCommon !== null &&
    diagnostics.every((d) => d.severity !== "error")
  ) {
    try {
      const events = await readJournal(io, productCommon);
      const integrated = events.find(
        (e) => e.event === "integrate" && e.branch === task!.dispatch!.branch,
      );
      if (integrated && !dryRun) {
        const next: SystemTask = { ...task, integratedCommit: integrated.sha };
        task = historyRow(next, "integrated", "collect");
        await writeTask(root, io, task);
      } else if (integrated && dryRun) {
        task = { ...task, integratedCommit: integrated.sha };
      }
    } catch {
      // A product repo without a journal is simply not-yet-integrated.
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: {
      command: "system.task.collect",
      task: task?.id ?? id,
      state: task?.state ?? null,
      reportFound: reportFile !== null,
      reportFile,
      integratedCommit: task?.integratedCommit ?? null,
      diagnostics,
    },
    exitCode: errors > 0 ? 1 : 0,
    summary:
      task === null
        ? `system.task.collect refused (${errors} error(s))`
        : dryRun
          ? `system.task.collect would process ${task.id} (state ${task.state})`
          : `system.task.collect: ${task.id} is now ${task.state}${task.integratedCommit ? ` (integrated ${task.integratedCommit.slice(0, 9)})` : ""}`,
    nextSteps:
      task?.state === "reported"
        ? [{ action: "integrate the product branch, then re-run system.task.collect", kind: "optional" }]
        : task?.state === "integrated"
          ? [{ action: `system.task.move --task ${task.id} --to verified --version-set <id>`, kind: "optional" }]
          : [],
  };
}
