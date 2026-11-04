/*
<MODULE_CONTRACT>
<purpose>system.task.dispatch (RFC-1509) — turn a `ready` task into a product
task branch. Resolves the product folder through products.local.yaml
(SYSTEM-TASK-05), enforces edge verdicts (forbidden → SYSTEM-TASK-03,
undeclared → SYSTEM-TASK-04 warning), refuses briefs that leak the system
identity or other products' folders (SYSTEM-TASK-06), opens an
auto/task-… branch via openFlowBranchCore with owner {kind: task, id},
git-excludes .forge/task/ through the common git dir's info/exclude, writes
the brief into the worktree, and records dispatch + briefSha256 on the task.
A launcher argv from products.local.yaml runs best-effort (SYSTEM-TASK-09).</purpose>
<non-goals>
  <item>No product-side commits, integrates or pushes — the session owns those.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 3 — system.task.dispatch handler</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import path from "node:path";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { openFlowBranchCore } from "../../flow/handlers/flow-open.ts";
import { commonGitDir } from "../../flow/registry.ts";
import { assertSystemRepository, edgeVerdict, loadSystemMap, type SystemMap } from "../repo.ts";
import type { SystemTask } from "../task-schemas.ts";
import { readBrief, readTask, writeTask } from "../task-store.ts";

export interface SystemTaskDispatchResult {
  command: "system.task.dispatch";
  task: string | null;
  product: string | null;
  branch: string | null;
  worktree: string | null;
  dispatched: boolean;
  launcherRan: boolean;
  launcherExit: number | null;
  diagnostics: Diagnostic[];
}

function refusal(ruleId: string, message: string, fixHint?: string): Diagnostic {
  return { ruleId, severity: "error", message, ...(fixHint ? { fixHint } : {}) };
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Resolve a product's local checkout — SYSTEM-TASK-05 on any gap. */
async function resolveProductRoot(
  root: string,
  io: WorkspaceIO,
  map: SystemMap,
  productId: string,
): Promise<{ root: string | null; diagnostic: Diagnostic | null }> {
  const declared = map.products.products.some((p) => p.id === productId);
  if (!declared) {
    return {
      root: null,
      diagnostic: refusal(
        "SYSTEM-TASK-05",
        `product '${productId}' is not declared in system/products.yaml`,
        "add the product to system/products.yaml",
      ),
    };
  }
  const folders = map.local?.folders ?? {};
  const raw = Object.prototype.hasOwnProperty.call(folders, productId)
    ? folders[productId]
    : undefined;
  if (raw === undefined) {
    return {
      root: null,
      diagnostic: refusal(
        "SYSTEM-TASK-05",
        `product '${productId}' has no folder in system/products.local.yaml`,
        `add folders.${productId}: <checkout> to products.local.yaml`,
      ),
    };
  }
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  try {
    const stat = await io.stat(resolved);
    if (!stat.isDirectory) {
      return {
        root: null,
        diagnostic: refusal(
          "SYSTEM-TASK-05",
          `product folder for '${productId}' is not a directory: ${resolved}`,
        ),
      };
    }
  } catch {
    return {
      root: null,
      diagnostic: refusal(
        "SYSTEM-TASK-05",
        `product folder for '${productId}' does not exist: ${resolved}`,
      ),
    };
  }
  return { root: resolved, diagnostic: null };
}

/**
 * SYSTEM-TASK-06 — the brief must not mention the system's identity or any
 * other product's local folder. The task's own product folder is expected in
 * paths the operator wrote; every OTHER product's folder is a leak.
 */
function briefLeakDiagnostics(
  map: SystemMap,
  task: SystemTask,
  briefContent: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const needles: { label: string; value: string }[] = [
    { label: `system id '${map.system.id}'`, value: map.system.id },
    ...(map.system.name ? [{ label: `system name '${map.system.name}'`, value: map.system.name }] : []),
  ];
  for (const product of map.products.products) {
    if (product.id === task.product) continue;
    const folder = map.local?.folders?.[product.id];
    if (folder) {
      needles.push({ label: `folder of product '${product.id}'`, value: folder });
    }
  }
  for (const needle of needles) {
    if (needle.value.length > 0 && briefContent.includes(needle.value)) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-06",
          `dispatch brief for ${task.id} leaks ${needle.label}`,
          "scrub the brief — product sessions learn nothing about the system repository or sibling products",
        ),
      );
    }
  }
  return diagnostics;
}

export async function runSystemTaskDispatch(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemTaskDispatchResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  const refusalDiag = await assertSystemRepository(root, io);
  if (refusalDiag) diagnostics.push(refusalDiag);

  const id = flagString(input, "task");
  if (id === null) {
    diagnostics.push(refusal("SYSTEM-TASK-01", "--task is required", "see forge system.task.dispatch --help"));
  }

  let map: SystemMap | null = null;
  let task: SystemTask | null = null;
  if (diagnostics.every((d) => d.severity !== "error")) {
    const loaded = await loadSystemMap(root, io);
    diagnostics.push(...loaded.diagnostics.filter((d) => d.ruleId === "SYSTEM-MAP-01"));
    map = loaded.map;
    if (map === null) {
      diagnostics.push(
        refusal("SYSTEM-TASK-05", "system map failed to load — see SYSTEM-MAP diagnostics"),
      );
    }
    const read = await readTask(root, io, id!);
    if (read.diagnostic) diagnostics.push(read.diagnostic);
    task = read.task;
  }

  if (task !== null && task.state !== "ready") {
    diagnostics.push(
      refusal(
        "SYSTEM-TASK-02",
        `${task.id} is ${task.state} — dispatch requires ready`,
        "system.task.move --to ready first",
      ),
    );
  }

  let productRoot: string | null = null;
  let briefContent: string | null = null;
  if (task !== null && map !== null && diagnostics.every((d) => d.severity !== "error")) {
    const resolved = await resolveProductRoot(root, io, map, task.product);
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
    productRoot = resolved.root;

    for (const contract of task.contracts) {
      const verdict = edgeVerdict(map, task.product, contract);
      if (verdict === "forbidden") {
        diagnostics.push(
          refusal(
            "SYSTEM-TASK-03",
            `contract '${contract}' is a forbidden edge for ${task.product}`,
            "renegotiate system/edges.yaml before dispatching this task",
          ),
        );
      } else if (verdict === "undeclared") {
        diagnostics.push({
          ruleId: "SYSTEM-TASK-04",
          severity: "warning",
          message: `contract '${contract}' is undeclared for ${task.product} — declare it in system/edges.yaml`,
        });
      }
    }

    const brief = await readBrief(root, io, task.id);
    if (brief === null) {
      diagnostics.push(
        refusal(
          "SYSTEM-TASK-02",
          `dispatch brief for ${task.id} is missing at queue/briefs/${task.id}.md`,
          "create the brief before dispatching",
        ),
      );
    } else {
      briefContent = brief.content;
      diagnostics.push(...briefLeakDiagnostics(map, task, brief.content));
    }
  }

  const errors = () => diagnostics.filter((d) => d.severity === "error").length;

  let branch: string | null = null;
  let worktree: string | null = null;
  if (task !== null && productRoot !== null && briefContent !== null && errors() === 0 && !dryRun) {
    const opened = await openFlowBranchCore(productRoot, io, {
      kind: "task",
      slug: task.slug,
      brief: task.id,
      owner: { kind: "task", id: task.id },
      dryRun: false,
      now: new Date(),
    });
    diagnostics.push(...opened.diagnostics);
    if (opened.opened && opened.branch && opened.worktree) {
      branch = opened.branch;
      worktree = opened.worktree;

      // RFC-1509: .forge/task/ must never become a tracked artifact — extend
      // the common git dir's info/exclude once (idempotent).
      const common = await commonGitDir(io, productRoot);
      const infoDir = path.join(common, "info");
      const excludeFile = path.join(infoDir, "exclude");
      const excludeLine = "/.forge/task/";
      await io.mkdir(infoDir);
      const existing = (await io.exists(excludeFile)) ? await io.readFile(excludeFile) : "";
      if (!existing.split(/\r?\n/).some((line) => line.trim() === excludeLine)) {
        await io.appendFile(
          excludeFile,
          `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${excludeLine}\n`,
        );
      }

      const taskDir = path.join(worktree, ".forge", "task");
      await io.mkdir(taskDir);
      await io.writeFile(path.join(taskDir, "brief.md"), briefContent);

      const briefSha = createHash("sha256").update(briefContent, "utf8").digest("hex");
      const next: SystemTask = {
        ...task,
        state: "dispatched",
        briefSha256: briefSha,
        dispatch: {
          branch,
          worktree,
          baseCommit: opened.baseSha ?? "",
          dispatchedAt: new Date().toISOString(),
        },
        history: [
          ...task.history,
          {
            at: new Date().toISOString(),
            from: task.state,
            to: "dispatched",
            by: "operator",
          },
        ],
      };
      await writeTask(root, io, next);
      task = next;
    }
  }

  let launcherRan = false;
  let launcherExit: number | null = null;
  if (task !== null && task.state === "dispatched" && worktree !== null && map?.local?.launcher) {
    const argv = map.local.launcher.argv.map((a) =>
      a.replace(/\{worktree\}/g, worktree!).replace(/\{task\}/g, task!.id),
    );
    launcherRan = true;
    try {
      const result = await io.exec(argv[0], argv.slice(1), { cwd: productRoot! });
      launcherExit = result.exitCode;
      if (result.exitCode !== 0) {
        diagnostics.push({
          ruleId: "SYSTEM-TASK-09",
          severity: "warning",
          message: `launcher exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        });
      }
    } catch (error) {
      diagnostics.push({
        ruleId: "SYSTEM-TASK-09",
        severity: "warning",
        message: `launcher failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const errs = errors();
  const dispatched = task?.state === "dispatched" && !dryRun;
  return {
    data: {
      command: "system.task.dispatch",
      task: task?.id ?? id,
      product: task?.product ?? null,
      branch,
      worktree,
      dispatched,
      launcherRan,
      launcherExit,
      diagnostics,
    },
    exitCode: errs > 0 ? 1 : 0,
    summary:
      task === null
        ? `system.task.dispatch refused (${errs} error(s))`
        : dryRun
          ? `system.task.dispatch would open auto/task-…-${task.slug} for ${task.id} in ${task.product}`
          : dispatched
            ? `system.task.dispatch opened ${branch} for ${task.id} — worktree ${worktree}`
            : `system.task.dispatch refused ${task.id} (${errs} error(s))`,
    nextSteps: dispatched
      ? [
          { action: `cd ${worktree}`, kind: "required" },
          { action: `read .forge/task/brief.md and follow it`, kind: "required" },
        ]
      : [],
  };
}
