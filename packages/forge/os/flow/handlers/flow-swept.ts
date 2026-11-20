/*
<MODULE_CONTRACT>
<purpose>RFC-1626: lifecycle commands for durable gate-isolation swept refs
(refs/forge/swept/&lt;worktree&gt;/&lt;timestamp&gt;). ecosystem.commit writes one ref
per sweep before reverting the worktree — the recoverable copy of foreign
uncommitted work that previously lived only in a disposable snapshot dir
(F-0329). flow.swept.list enumerates refs read-only grouped by worktree;
flow.swept.gc deletes refs older than --keep-days and only with --apply
(hygiene.gc-style explicit mutation).</purpose>
<non-goals>
  <item>No restore command — recovery is self-service git: git checkout &lt;ref&gt; -- &lt;path&gt; or git show &lt;ref&gt;:&lt;path&gt;. A restore verb belongs to a later RFC if manual recovery proves awkward.</item>
  <item>No automatic gc — swept refs are user-work evidence; deletion is always an explicit operator act.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Ref shape refs/forge/swept/&lt;wtName&gt;/&lt;ts&gt; — wtName is the sanitized worktree basename (no slashes), ts a UTC compact timestamp; for-each-ref output splits deterministically on that 5-segment shape.</item>
  <item>Age is judged by the ref's creatordate (the sweep commit's commit time), not the ref update time — they coincide at creation.</item>
  <item>gc refuses nothing: no --apply prints the deletion plan with applied:false and exits 0, matching the hygiene.gc manual-only contract.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1626: flow.swept.list + flow.swept.gc — enumerate and expire durable gate-isolation swept refs (F-0329 recovery surface)</item>
  <item>RFC-1626: make gate-isolation sweeps durable and refuse foreign uncommitted work</item>
</CHANGE_SUMMARY>
*/

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { git, requireGit, topLevel } from "../git.ts";

const SWEPT_REF_PREFIX = "refs/forge/swept/";

interface SweptRef {
  ref: string;
  /** Sanitized worktree basename the sweep ran in. */
  worktree: string;
  /** UTC compact timestamp segment from the ref name. */
  timestamp: string;
  sha: string;
  createdAt: string;
  ageDays: number;
}

export interface FlowSweptListData {
  command: "flow.swept.list";
  refs: SweptRef[];
  byWorktree: Record<string, number>;
  diagnostics: Diagnostic[];
}

export interface FlowSweptGcData {
  command: "flow.swept.gc";
  applied: boolean;
  keepDays: number;
  deleted: string[];
  kept: string[];
  plan: string[];
  diagnostics: Diagnostic[];
}

async function enumerateSweptRefs(
  repoRoot: string,
  io: ReturnType<typeof resolveIo>,
): Promise<SweptRef[]> {
  const res = await git(repoRoot, io, [
    "for-each-ref",
    SWEPT_REF_PREFIX,
    "--format=%(refname)%09%(creatordate:iso-strict)%09%(objectname)",
  ]);
  if (res.exitCode !== 0) return [];
  const now = Date.now();
  const out: SweptRef[] = [];
  for (const line of res.stdout.split("\n")) {
    const [ref, created, sha] = line.split("\t");
    if (!ref || !created || !sha) continue;
    const segs = ref.split("/");
    // refs/forge/swept/<wt>/<ts> → exactly 5 segments.
    if (segs.length !== 5) continue;
    const createdMs = Date.parse(created);
    out.push({
      ref,
      worktree: segs[3],
      timestamp: segs[4],
      sha: sha.trim(),
      createdAt: created.trim(),
      ageDays: Number.isFinite(createdMs) ? (now - createdMs) / 86_400_000 : 0,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function runFlowSweptList(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowSweptListData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);
  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) throw new Error("flow.swept.list must run inside a git repository");

  const refs = await enumerateSweptRefs(repoRoot, io);
  const byWorktree: Record<string, number> = {};
  for (const r of refs) byWorktree[r.worktree] = (byWorktree[r.worktree] ?? 0) + 1;

  if (outputFormat === "pretty") {
    logger.section("flow.swept.list");
    if (refs.length === 0) {
      logger.info("  no swept refs — no gate-isolation sweep has written a durable copy");
    }
    for (const r of refs) {
      logger.info(`  ${r.ref}  ${r.sha.slice(0, 10)}  ${r.createdAt}  (${r.ageDays.toFixed(1)}d)`);
    }
  }

  return {
    data: { command: "flow.swept.list", refs, byWorktree, diagnostics: [] },
    summary:
      refs.length === 0
        ? "no swept refs"
        : `${refs.length} swept ref(s) across ${Object.keys(byWorktree).length} worktree(s)`,
    exitCode: 0,
  };
}

export async function runFlowSweptGc(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowSweptGcData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);
  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) throw new Error("flow.swept.gc must run inside a git repository");

  const keepDaysRaw = input.flags["keep-days"];
  const keepDays =
    typeof keepDaysRaw === "string" &&
    Number.isFinite(Number(keepDaysRaw)) &&
    Number(keepDaysRaw) > 0
      ? Number(keepDaysRaw)
      : 30;
  const apply = input.flags["apply"] === true;

  const refs = await enumerateSweptRefs(repoRoot, io);
  const expired = refs.filter((r) => r.ageDays > keepDays);
  const kept = refs.filter((r) => r.ageDays <= keepDays);

  const deleted: string[] = [];
  if (apply) {
    for (const r of expired) {
      const res = await git(repoRoot, io, ["update-ref", "-d", r.ref]);
      if (res.exitCode === 0) deleted.push(r.ref);
    }
  }

  if (outputFormat === "pretty") {
    logger.section("flow.swept.gc");
    for (const r of expired) {
      logger.info(`  ${apply ? "deleted" : "would delete"}: ${r.ref} (${r.ageDays.toFixed(1)}d)`);
    }
    if (!apply && expired.length > 0)
      logger.info(`  re-run with --apply to delete ${expired.length} ref(s)`);
  }

  return {
    data: {
      command: "flow.swept.gc",
      applied: apply,
      keepDays,
      deleted,
      kept: kept.map((r) => r.ref),
      plan: expired.map((r) => r.ref),
      diagnostics: [],
    },
    summary: apply
      ? `deleted ${deleted.length}/${expired.length} expired swept ref(s) (keep ${keepDays}d)`
      : `${expired.length} expired swept ref(s) — plan only, re-run with --apply`,
    exitCode: 0,
  };
}
