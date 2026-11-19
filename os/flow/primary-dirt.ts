/*
<MODULE_CONTRACT>
<purpose>Primary-checkout dirt lifecycle for flow.open / flow.status /
flow.integrate (RFC-1599): the mid-operation detector, the porcelain -z
sweep enumerator, the applySweep mover (copy → worktree index → restore the
primary to HEAD via git checkout-index — the agent-safe restore path), and
the foreignDirt audit attribution.</purpose>
<non-goals>
  <item>No dirty-path classification — the DirtyClass vocabulary stays in dirty-classify.ts.</item>
  <item>No refusal policy — flow.open decides when mid-operation state refuses; this module only detects and moves dirt.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Primary restore uses `git reset -q HEAD -- &lt;path&gt;` + `checkout-index -f` — never checkout/restore/reset --hard (session guard).</item>
  <item>Swept content lands STAGED — the "moves uncommitted files into the index" contract collapses both states per path.</item>
  <item>foreignDirt matches dirty-path governance ids against session briefs — a single unambiguous match, else owningSession: null.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1599: sweep mechanics + foreignDirt audit for primary-checkout dirt</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
</CHANGE_SUMMARY>
*/

import { basename, dirname, join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import { git, isForgeStatePath } from "./git.ts";
import { FORGE_CONFIG_FILE, GENERATED_MARKER_FILE } from "./repo-kind.ts";
import { readRegistry } from "./registry.ts";

/** RFC-1599 escalation bound: untracked files above this size refuse, recorded. */
const UNTRACKED_SWEEP_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Repo-identity files — an untracked copy is an in-flight adoption marker,
 * never session work. The sweep leaves it in place so the primary keeps its
 * governed/exempt identity (detectRepoKind keys `governed` on the file
 * itself; moving it would demote the checkout until the session integrates).
 */
function isRepoIdentityPath(path: string): boolean {
  return path === FORGE_CONFIG_FILE || path === GENERATED_MARKER_FILE;
}

export type MidOperation = "merge" | "rebase" | "cherry-pick";

/**
 * In-flight merge/rebase/cherry-pick markers in the primary's common .git
 * dir. Sweeping would corrupt the in-flight state, so flow.open refuses on
 * any hit — MERGE_MSG alone counts (a recorded merge commit being edited is
 * still mid-merge).
 */
export async function detectPrimaryMidOperation(
  common: string,
  io: WorkspaceIO,
): Promise<MidOperation | null> {
  if (await io.exists(join(common, "MERGE_HEAD"))) return "merge";
  if (
    (await io.exists(join(common, "REBASE_HEAD"))) ||
    (await io.exists(join(common, "rebase-merge"))) ||
    (await io.exists(join(common, "rebase-apply")))
  ) {
    return "rebase";
  }
  if (await io.exists(join(common, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await io.exists(join(common, "MERGE_MSG"))) return "merge";
  return null;
}

export interface SweepEntry {
  /** Repo-relative path the sweep acts on (for R/C: the destination). */
  path: string;
  /** Porcelain XY pair — "M ", " M", "A ", " D", "??", "R ", … */
  status: string;
  /** For R/C pairs: the source (renamed-from / copied-from) path. */
  src?: string;
}

export interface SweepPlan {
  /** Entries the sweep moves — tracked composite + non-ignored untracked. */
  entries: SweepEntry[];
  /** Tracked porcelain paths — the `primaryMutations` reporting surface. */
  trackedPaths: string[];
  /** Untracked forge-local state (`.forge/…`) — never swept, never reported as dirt. */
  toleratedState: string[];
}

function parsePorcelainZ(stdout: string): SweepEntry[] {
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const out: SweepEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const status = tok.slice(0, 2);
    const path = tok.slice(3);
    // -z prints the rename/copy pair as "<dst>\0<src>\0" (reversed vs the
    // human "from -> to" text form).
    if (status[0] === "R" || status[0] === "C") {
      const src = tokens[++i];
      out.push({ status, path, ...(src !== undefined ? { src } : {}) });
    } else {
      out.push({ status, path });
    }
  }
  return out;
}

/**
 * Everything the sweep considers: `git status --porcelain=v1 -z -uall`
 * gives tracked composite state plus every non-ignored untracked file —
 * ignored files are never listed, so they can never be swept by accident.
 * Untracked forge-local state (`.forge/…` journal files) partitions out.
 */
export async function enumerateSweepPlan(primary: string, io: WorkspaceIO): Promise<SweepPlan> {
  const result = await git(primary, io, ["status", "--porcelain=v1", "-z", "-uall"]);
  const entries = parsePorcelainZ(result.stdout);
  const toleratedState: string[] = [];
  const sweepable: SweepEntry[] = [];
  const trackedPaths: string[] = [];
  for (const e of entries) {
    // Untracked repo-identity files never sweep: a still-uncommitted
    // forge.yaml marks adoption in flight — moving it out of the primary
    // would demote the checkout to ungoverned until the session integrates
    // (detectRepoKind keys `governed` on the file itself). A tracked
    // modification still sweeps normally — the committed base stays behind.
    if (e.status === "??" && (isForgeStatePath(e.path) || isRepoIdentityPath(e.path))) {
      toleratedState.push(e.path);
      continue;
    }
    sweepable.push(e);
    if (e.status !== "??") {
      trackedPaths.push(e.path);
      if (e.src !== undefined) trackedPaths.push(e.src);
    }
  }
  return { entries: sweepable, trackedPaths, toleratedState };
}

export interface SweepResult {
  /** Repo-relative paths now staged in the worktree's index. */
  swept: string[];
  /** path → reason — the path stays in the primary, surfaced as a warning. */
  refused: Record<string, string>;
}

/** A symlink copies as its target's bytes — refuse it rather than materialize a plain file. */
async function isSymlinkPath(abs: string, io: WorkspaceIO): Promise<boolean> {
  try {
    const resolved = await io.realpath(abs);
    const parentResolved = await io.realpath(dirname(abs));
    return resolved !== join(parentResolved, basename(abs));
  } catch {
    return false;
  }
}

/**
 * Move the enumerated dirt: copy each path's primary bytes into the
 * worktree and `git add` them there (deletions via `git rm`), then restore
 * the primary to HEAD — `reset -q HEAD -- <path>` unstages and
 * `checkout-index -f -- <path>` rewrites the file with index (HEAD) bytes;
 * a path never in HEAD is removed. A per-path failure is recorded in
 * `refused` and left in the primary — it never aborts the open.
 */
export async function applySweep(
  primary: string,
  worktree: string,
  entries: SweepEntry[],
  io: WorkspaceIO,
): Promise<SweepResult> {
  const swept: string[] = [];
  const refused: Record<string, string> = {};
  for (const e of entries) {
    const legs: SweepEntry[] =
      e.src !== undefined && e.status[0] === "R"
        ? [
            { status: e.status, path: e.path },
            { status: " D", path: e.src },
          ]
        : [e];
    for (const leg of legs) {
      try {
        if (leg.status.includes("U") || leg.status === "AA" || leg.status === "DD") {
          refused[leg.path] = "unmerged path — resolve the conflict in the primary first";
          continue;
        }
        const abs = join(primary, leg.path);
        const wtAbs = join(worktree, leg.path);
        const exists = await io.exists(abs);
        const inHead =
          (await git(primary, io, ["cat-file", "-e", `HEAD:${leg.path}`])).exitCode === 0;

        if (leg.status === "??") {
          if (!exists) {
            refused[leg.path] = "untracked path vanished before the sweep";
            continue;
          }
          const size = (await io.stat(abs)).size;
          if (size > UNTRACKED_SWEEP_MAX_BYTES) {
            refused[leg.path] = `exceeds the 16 MiB untracked sweep bound (${size} bytes)`;
            continue;
          }
          if (await isSymlinkPath(abs, io)) {
            refused[leg.path] = "symlink — recreate the link inside the worktree by hand";
            continue;
          }
          await io.mkdir(dirname(wtAbs));
          await io.copyFile(abs, wtAbs);
          const add = await git(worktree, io, ["add", "--", leg.path]);
          if (add.exitCode !== 0) {
            refused[leg.path] = `git add in the worktree failed: ${add.stderr.trim()}`;
            continue;
          }
          await io.rm(abs);
          swept.push(leg.path);
          continue;
        }

        // Tracked entry — composite state becomes one staged change.
        if (exists) {
          if (await isSymlinkPath(abs, io)) {
            refused[leg.path] = "symlink — recreate the link inside the worktree by hand";
            continue;
          }
          await io.mkdir(dirname(wtAbs));
          await io.copyFile(abs, wtAbs);
          const add = await git(worktree, io, ["add", "--", leg.path]);
          if (add.exitCode !== 0) {
            refused[leg.path] = `git add in the worktree failed: ${add.stderr.trim()}`;
            continue;
          }
        } else if (inHead) {
          // Deleted in the primary — replicate the deletion in the index.
          const rm = await git(worktree, io, ["rm", "-q", "--ignore-unmatch", "--", leg.path]);
          if (rm.exitCode !== 0) {
            refused[leg.path] = `git rm in the worktree failed: ${rm.stderr.trim()}`;
            continue;
          }
        }
        // else: staged-add deleted in the worktree — composite clean; only
        // the staged index entry is dropped below.

        await git(primary, io, ["reset", "-q", "HEAD", "--", leg.path]);
        if (inHead) {
          const restore = await git(primary, io, ["checkout-index", "-f", "--", leg.path]);
          if (restore.exitCode !== 0) {
            refused[leg.path] = `primary restore failed: ${restore.stderr.trim()}`;
            continue;
          }
        } else if (exists) {
          await io.rm(abs);
        }
        swept.push(leg.path);
      } catch (error) {
        refused[leg.path] = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { swept, refused };
}

// ─── foreignDirt audit ───────────────────────────────────────────────────

export interface ForeignDirtEntry {
  path: string;
  /** Registry branch name when the path attributes to exactly one live
   * session; null for unattributed dirt (operator edits, ambiguous matches). */
  owningSession: string | null;
}

/** Governance-id tokens — case-insensitive so a lowercase file path
 * (docs/rfcs/rfc-1599-…md) attributes to an uppercase brief token (RFC-1599). */
const ID_TOKEN_RE = /(?:RFC|ADR|PLAN|F)-\d{3,}/gi;

function idTokens(text: string): string[] {
  return (text.match(ID_TOKEN_RE) ?? []).map((t) => t.toUpperCase());
}

/**
 * Tracked mutations in the primary while a live session worktree exists —
 * the leak RFC-1599 audits. Attribution: governance-id tokens in the dirty
 * path matched against each live session's brief; exactly one unambiguous
 * match names the owner, anything else reports null.
 */
export async function computeForeignDirt(
  common: string,
  primaryDirtyPaths: string[],
  io: WorkspaceIO,
  opts: { worktreeExists?: (path: string) => Promise<boolean> } = {},
): Promise<ForeignDirtEntry[]> {
  if (primaryDirtyPaths.length === 0) return [];
  let liveSessions: Array<{ name: string; brief: string | null }>;
  try {
    const registry = await readRegistry(io, common);
    const live = registry.branches.filter((b) => b.held === null && b.worktree !== null);
    const exists = opts.worktreeExists ?? ((p: string) => io.exists(p));
    const checked: Array<{ name: string; brief: string | null }> = [];
    for (const b of live) {
      if (await exists(b.worktree as string)) {
        checked.push({ name: b.name, brief: b.brief });
      }
    }
    liveSessions = checked;
  } catch {
    return [];
  }
  if (liveSessions.length === 0) return [];

  const sessionTokens = liveSessions.map((s) => ({
    name: s.name,
    tokens: new Set(idTokens(s.brief ?? "")),
  }));

  return primaryDirtyPaths.map((path) => {
    const pathTokens = idTokens(path);
    const matches = new Set(
      sessionTokens.filter((s) => pathTokens.some((t) => s.tokens.has(t))).map((s) => s.name),
    );
    return { path, owningSession: matches.size === 1 ? [...matches][0]! : null };
  });
}
