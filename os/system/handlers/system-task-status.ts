/*
<MODULE_CONTRACT>
<purpose>system.task.status (RFC-1509) — read-only projection of every task
plus the product-side flow facts for dispatched work. The system task file
is authoritative for the state; the product layer adds registry/journal
evidence: branch registered, integrated/discarded per journal, orphaned
(no registry entry AND no journal integrate/discard for dispatch.branch),
or unknown when the product repo cannot be read.</purpose>
<non-goals>
  <item>Never mutates — no task writes, no registry writes.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 3 — system.task.status handler</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1509: close RFC-1509 review r1 findings — mark-failed escape, open-error refusal, dry-run coverage</item>
  <item>RFC-1509: address RFC-1509 review r2 — mark-failed without product, journal-read warning, status map diagnostics, V-49 deviations</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { collectFlowStatus } from "../../flow/handlers/flow-status.ts";
import { commonGitDir, readJournal } from "../../flow/registry.ts";
import { assertSystemRepository, loadSystemMap } from "../repo.ts";
import type { SystemTask } from "../task-schemas.ts";
import { listTasks, readTask } from "../task-store.ts";

export type TaskProductStatus =
  | "registered"
  | "integrated"
  | "discarded"
  | "orphaned"
  | "unknown"
  | "not-dispatched";

export interface TaskStatusRow {
  id: string;
  title: string;
  product: string;
  kind: string;
  state: SystemTask["state"];
  branch: string | null;
  productStatus: TaskProductStatus;
  productMessage: string | null;
}

export interface SystemTaskStatusResult {
  command: "system.task.status";
  tasks: TaskStatusRow[];
  diagnostics: Diagnostic[];
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function runSystemTaskStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemTaskStatusResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];

  const refusalDiag = await assertSystemRepository(root, io);
  if (refusalDiag) diagnostics.push(refusalDiag);

  const only = flagString(input, "task");
  let tasks: SystemTask[] = [];
  if (diagnostics.every((d) => d.severity !== "error")) {
    if (only !== null) {
      const read = await readTask(root, io, only);
      if (read.diagnostic) diagnostics.push(read.diagnostic);
      if (read.task) tasks = [read.task];
    } else {
      const listed = await listTasks(root, io);
      diagnostics.push(...listed.diagnostics);
      tasks = listed.tasks;
    }
  }

  let map: Awaited<ReturnType<typeof loadSystemMap>>["map"] = null;
  if (tasks.length > 0) {
    const loaded = await loadSystemMap(root, io);
    // Surface map-load diagnostics — a corrupt products.local.yaml must not
    // masquerade as a plain "no folder" productMessage below.
    diagnostics.push(...loaded.diagnostics);
    map = loaded.map;
  }

  const rows: TaskStatusRow[] = [];
  for (const task of tasks) {
    const row: TaskStatusRow = {
      id: task.id,
      title: task.title,
      product: task.product,
      kind: task.kind,
      state: task.state,
      branch: task.dispatch?.branch ?? null,
      productStatus: "not-dispatched",
      productMessage: null,
    };
    if (task.dispatch !== null && task.state !== "cancelled") {
      const folders = map?.local?.folders ?? {};
      const folder = Object.prototype.hasOwnProperty.call(folders, task.product)
        ? folders[task.product]
        : undefined;
      if (folder === undefined || map === null) {
        row.productStatus = "unknown";
        row.productMessage =
          map === null
            ? "system map failed to load — see diagnostics"
            : "no products.local.yaml folder for this product";
      } else {
        const productRoot = path.isAbsolute(folder) ? folder : path.resolve(root, folder);
        try {
          const status = await collectFlowStatus(productRoot, io);
          const entry = status.data.branches.find(
            (b) => b.registered && b.name === task.dispatch!.branch,
          );
          let journalEvent: "integrate" | "discard" | null = null;
          let journalReadable = true;
          try {
            const common = await commonGitDir(io, productRoot);
            const events = await readJournal(io, common);
            const found = events.find(
              (e) =>
                (e.event === "integrate" || e.event === "discard") &&
                e.branch === task.dispatch!.branch,
            );
            journalEvent = found?.event === "discard" ? "discard" : found ? "integrate" : null;
          } catch {
            journalReadable = false;
          }
          if (status.registryError !== null || !journalReadable) {
            // Orphaned is a negative claim — corrupt evidence must not assert it.
            row.productStatus = "unknown";
            row.productMessage = status.registryError
              ? `product registry is corrupt: ${status.registryError.message}`
              : "product journal is unreadable";
          } else if (entry !== undefined) {
            row.productStatus = "registered";
            row.productMessage = `worktree ${entry.worktree ?? "(none)"}`;
          } else if (journalEvent === "integrate") {
            row.productStatus = "integrated";
          } else if (journalEvent === "discard") {
            row.productStatus = "discarded";
          } else {
            row.productStatus = "orphaned";
            row.productMessage = `branch ${task.dispatch.branch} has no registry entry and no journal integrate/discard event`;
          }
        } catch (error) {
          row.productStatus = "unknown";
          row.productMessage = `product repo unreadable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    rows.push(row);
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: { command: "system.task.status", tasks: rows, diagnostics },
    exitCode: errors > 0 ? 1 : 0,
    summary: `system.task.status: ${rows.length} task(s)${errors > 0 ? ` — ${errors} error(s)` : ""}`,
  };
}
