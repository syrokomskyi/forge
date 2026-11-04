/*
<MODULE_CONTRACT>
<purpose>File store for the system task queue (RFC-1509): read/write/list of
queue/tasks/T-NNNN.yaml files (forge/system-task@1), the next-id allocator,
the dispatch-brief reader/writer and the report copy. All mutation paths go
through the injected WorkspaceIO so kernel callers stay on the recording
adapter.</purpose>
<non-goals>
  <item>No transition checks — handlers own the table lookups.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 2 — task store (read/write/list/next-id, brief IO)</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";

import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";
import { systemTaskSchema, TASK_ID_RE, type SystemTask } from "./task-schemas.ts";

export const TASKS_DIR = "queue/tasks";
export const BRIEFS_DIR = "queue/briefs";
export const REPORTS_DIR = "queue/reports";

export function taskFilePath(root: string, id: string): string {
  return path.join(root, TASKS_DIR, `${id}.yaml`);
}

export function briefFilePath(root: string, id: string): string {
  return path.join(root, BRIEFS_DIR, `${id}.md`);
}

export function reportFilePath(root: string, id: string): string {
  return path.join(root, REPORTS_DIR, `${id}.yaml`);
}

function taskDiag(ruleId: string, message: string, file?: string): Diagnostic {
  return { ruleId, severity: "error", message, file };
}

function schemaIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Read one task file. SYSTEM-TASK-01 when the file is missing or fails the
 * forge/system-task@1 schema — never throws on malformed input.
 */
export async function readTask(
  root: string,
  io: WorkspaceIO,
  id: string,
): Promise<{ task: SystemTask | null; diagnostic: Diagnostic | null }> {
  const file = taskFilePath(root, id);
  if (!(await io.exists(file))) {
    return {
      task: null,
      diagnostic: taskDiag(
        "SYSTEM-TASK-01",
        `unknown task ${id} — no file at ${path.relative(root, file)}`,
        path.relative(root, file),
      ),
    };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(await io.readFile(file));
  } catch (error) {
    return {
      task: null,
      diagnostic: taskDiag(
        "SYSTEM-TASK-01",
        `${path.relative(root, file)} is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
        path.relative(root, file),
      ),
    };
  }
  const parsed = systemTaskSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      task: null,
      diagnostic: taskDiag(
        "SYSTEM-TASK-01",
        `${path.relative(root, file)} fails forge/system-task@1: ${schemaIssues(parsed.error)}`,
        path.relative(root, file),
      ),
    };
  }
  return { task: parsed.data, diagnostic: null };
}

/** Write a task file (creates queue/tasks/ when absent). */
export async function writeTask(
  root: string,
  io: WorkspaceIO,
  task: SystemTask,
): Promise<void> {
  const file = taskFilePath(root, task.id);
  await io.mkdir(path.dirname(file));
  await io.writeFile(file, YAML.stringify(task));
}

/**
 * List every task file under queue/tasks/. Files that fail the schema are
 * reported as SYSTEM-TASK-01 diagnostics and skipped — the listing itself
 * never throws.
 */
export async function listTasks(
  root: string,
  io: WorkspaceIO,
): Promise<{ tasks: SystemTask[]; diagnostics: Diagnostic[] }> {
  const dir = path.join(root, TASKS_DIR);
  const tasks: SystemTask[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!(await io.exists(dir))) return { tasks, diagnostics };
  const entries = await io.readdir(dir);
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
    const id = entry.name.slice(0, -".yaml".length);
    if (!TASK_ID_RE.test(id)) continue;
    const { task, diagnostic } = await readTask(root, io, id);
    if (diagnostic) diagnostics.push(diagnostic);
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, diagnostics };
}

/** Highest T-NNNN in queue/tasks/ plus one, zero-padded to four digits. */
export async function nextTaskId(root: string, io: WorkspaceIO): Promise<string> {
  const dir = path.join(root, TASKS_DIR);
  let max = 0;
  if (await io.exists(dir)) {
    for (const entry of await io.readdir(dir)) {
      const m = /^T-(\d{4})\.yaml$/.exec(entry.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `T-${String(max + 1).padStart(4, "0")}`;
}

/** Append one history row and set the new state — returns a NEW task object. */
export function moveTask(
  task: SystemTask,
  row: { to: SystemTask["state"]; by: string; at: string; reason?: string },
): SystemTask {
  return {
    ...task,
    state: row.to,
    history: [
      ...task.history,
      { at: row.at, from: task.state, to: row.to, by: row.by, ...(row.reason ? { reason: row.reason } : {}) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dispatch brief
// ---------------------------------------------------------------------------

export interface LoadedBrief {
  /** Full markdown content — written verbatim into the product worktree. */
  content: string;
  /** Parsed frontmatter, or null when the file fails to parse/validate. */
  frontmatter: Record<string, unknown> | null;
}

/**
 * Read queue/briefs/<id>.md and split out the YAML frontmatter block. Returns
 * null when the file is absent.
 */
export async function readBrief(
  root: string,
  io: WorkspaceIO,
  id: string,
): Promise<LoadedBrief | null> {
  const file = briefFilePath(root, id);
  if (!(await io.exists(file))) return null;
  const content = await io.readFile(file);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let frontmatter: Record<string, unknown> | null = null;
  if (match) {
    try {
      const parsed = YAML.parse(match[1]);
      if (parsed !== null && typeof parsed === "object") {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = null;
    }
  }
  return { content, frontmatter };
}
