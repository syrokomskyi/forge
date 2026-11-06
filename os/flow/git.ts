/*
<MODULE_CONTRACT>
<purpose>Thin git helpers for os/flow handlers (RFC-1486) — every git
invocation goes through io.exec with an argument vector (DNA-89), exit codes
are checked (DNA-106), and each helper expresses exactly one git fact.</purpose>
<non-goals>
  <item>No branch-model policy — helpers report git facts; handlers decide.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Exit code 1 is a legitimate answer for probe-style commands (is-ancestor, config --get, symbolic-ref, rev-parse --verify, show HEAD:file) — helpers map it to a typed answer and throw only on unexpected failures.</item>
  <item>flow.check/flow.install require git >= 2.30 — requireGit fails through the standard error path naming the detected version.</item>
  <item>FORGE_STATE_FILES is an exact-path/prefix allowlist, never a glob — and because tolerated paths stay untracked-not-ignored on disk, removers must delete them right before `git worktree remove` or the dirty verdict stops predicting removability (RFC-1515 r1).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>RFC-1515: close rfc-1515 review findings — delete tolerated paths before worktree remove, prune vanished registrations, verified branch -D, shared held-lock render, gated e2e throw, journal toleratedState, edge tests</item>
  <item>RFC-1515: record rfc-1515 review r1 fixes, key decisions and corrected probe path</item>
  <history>RFC-1486, RFC-1487</history>
</CHANGE_SUMMARY>
*/

import type { ExecResult, WorkspaceIO } from "../../src/types.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";

export const MIN_GIT_VERSION = "2.33";

export interface FlowWorktree {
  path: string;
  head: string;
  /** Short branch name when the worktree carries one; null when detached or bare. */
  branch: string | null;
  bare: boolean;
}

export async function git(
  repoRoot: string,
  io: WorkspaceIO,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<ExecResult> {
  return io.exec("git", ["-C", repoRoot, ...args], { env: opts?.env });
}

/**
 * `git` with `FORGE_FLOW_COMMIT=<op>` in the child env — the informational
 * marker every flow-owned commit/merge/cherry-pick carries (RFC-1490). The
 * guard does not read this variable; `extraEnv` merges caller env (e.g.
 * `FORGE_FLOW_OP` where the guard vocabulary still applies).
 */
export async function gitCommit(
  worktree: string,
  io: WorkspaceIO,
  args: string[],
  op: string,
  extraEnv?: Record<string, string>,
): Promise<ExecResult> {
  return git(worktree, io, args, { env: { ...extraEnv, FORGE_FLOW_COMMIT: op } });
}

function throwOnFailure(result: ExecResult, what: string): ExecResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

/** Require git >= 2.30 — failure goes through the standard command error path. */
export async function requireGit(io: WorkspaceIO): Promise<void> {
  let result: ExecResult;
  try {
    result = await io.exec("git", ["--version"]);
  } catch (error) {
    throw new Error(
      `git is required for flow commands but could not be executed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error("git is required for flow commands but `git --version` failed");
  }
  const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
  if (!match) {
    throw new Error(`could not parse git version from "${result.stdout.trim()}"`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 30)) {
    throw new Error(`flow commands require git >= ${MIN_GIT_VERSION} (found ${match[0]})`);
  }
}

/** Absolute path of the repository top level; null when cwd is not a repo. */
export async function topLevel(cwd: string, io: WorkspaceIO): Promise<string | null> {
  const result = await git(cwd, io, ["rev-parse", "--show-toplevel"]);
  // Canonicalize to the native real path — git reports forward slashes and
  // the on-disk long name, while callers hold whatever spelling the user
  // passed (possibly an 8.3 alias on Windows); the canonical form is what
  // downstream equality comparisons are written against.
  return result.exitCode === 0 ? canonicalRepoDir(result.stdout.trim()) : null;
}

export async function isBare(repoRoot: string, io: WorkspaceIO): Promise<boolean> {
  const result = await git(repoRoot, io, ["rev-parse", "--is-bare-repository"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Current branch short name; null on detached HEAD (symbolic-ref fails). */
export async function currentBranch(repoRoot: string, io: WorkspaceIO): Promise<string | null> {
  const result = await git(repoRoot, io, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** True when HEAD has no commit yet (unborn branch). */
export async function isUnborn(repoRoot: string, io: WorkspaceIO): Promise<boolean> {
  const result = await git(repoRoot, io, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.exitCode !== 0;
}

export async function listLocalBranches(repoRoot: string, io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await git(repoRoot, io, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    "git for-each-ref",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remote-tracking refs under `refs/remotes` as `<remote>/<branch>` shorts. */
export async function listRemoteBranches(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<string[]> {
  const result = throwOnFailure(
    await git(repoRoot, io, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
    "git for-each-ref refs/remotes",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when `ancestor` is an ancestor of `descendant` (merge-base --is-ancestor). */
export async function isAncestor(
  repoRoot: string,
  io: WorkspaceIO,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repoRoot, io, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/** ISO committer timestamp of `ref`'s tip; null when the ref is missing. */
export async function lastCommitAt(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
): Promise<string | null> {
  const result = await git(repoRoot, io, ["log", "-1", "--format=%cI", ref]);
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout.trim()
    : null;
}

export async function branchExists(repoRoot: string, io: WorkspaceIO, name: string): Promise<boolean> {
  const result = await git(repoRoot, io, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  return result.exitCode === 0;
}

/** Commit count in a rev range, e.g. "develop..main". */
export async function revListCount(
  repoRoot: string,
  io: WorkspaceIO,
  range: string,
): Promise<number> {
  const result = throwOnFailure(
    await git(repoRoot, io, ["rev-list", "--count", range]),
    `git rev-list --count ${range}`,
  );
  return Number(result.stdout.trim());
}

/**
 * True when `ref` carries a commit whose subject matches `grep` — git's
 * default basic-regex --grep treats parentheses literally, so the adoption
 * subject `chore(flow): …` matches without escaping.
 */
export async function revListHasSubject(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
  grep: string,
): Promise<boolean> {
  const result = await git(repoRoot, io, ["rev-list", "-1", `--grep=${grep}`, ref]);
  if (result.exitCode !== 0) return false;
  return result.stdout.trim().length > 0;
}

/**
 * True when `path` exists in the tree of `ref` (e.g. `develop`,
 * `HEAD`). Uses `cat-file -e` — any non-zero exit means absent, including an
 * unborn `ref` (exit 128).
 */
export async function fileInTree(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
  path: string,
): Promise<boolean> {
  const result = await git(repoRoot, io, ["cat-file", "-e", `${ref}:${path}`]);
  return result.exitCode === 0;
}

/**
 * Decode one porcelain value — git C-quotes paths containing spaces or
 * specials (`"a b"` → `"a\040b"` is octal-escaped inside the quotes).
 */
function unquotePorcelain(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  return inner
    .replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          return ch;
      }
    });
}

/** Parse `git worktree list --porcelain`; first entry is always the primary. */
export async function worktreeList(repoRoot: string, io: WorkspaceIO): Promise<FlowWorktree[]> {
  const result = throwOnFailure(
    await git(repoRoot, io, ["worktree", "list", "--porcelain"]),
    "git worktree list",
  );
  const worktrees: FlowWorktree[] = [];
  let current: { path?: string; head?: string; branch: string | null; bare: boolean } | null = null;
  const flush = (): void => {
    if (current?.path) {
      worktrees.push({
        // Same canonicalization as topLevel — porcelain paths arrive in
        // git's resolved frame, consumers compare them to Node-side paths.
        path: canonicalRepoDir(current.path),
        head: current.head ?? "",
        branch: current.branch,
        bare: current.bare,
      });
    }
    current = null;
  };
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: unquotePorcelain(line.slice("worktree ".length)),
        branch: null,
        bare: false,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = unquotePorcelain(line.slice("branch refs/heads/".length));
    } else if (current && line === "detached") {
      current.branch = null;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  flush();
  return worktrees;
}

/** `git config --get` — null when the key is unset (exit 1). */
export async function configGet(
  repoRoot: string,
  io: WorkspaceIO,
  key: string,
): Promise<string | null> {
  const result = await git(repoRoot, io, ["config", "--get", key]);
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw new Error(`git config --get ${key} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

/**
 * RFC-1515: forge-local state that never counts as worktree dirt — exact
 * paths or explicit directory prefixes only (a trailing slash marks the
 * prefix form). A broad `.forge/` glob would mask real dirt: authored state
 * like `.forge/pinned.yaml` is tracked and stays a blocker (AC-7).
 */
export const FORGE_STATE_FILES: readonly string[] = [
  ".forge/knowledge-conflicts.txt",
  ".forge/task/",
];

/** Typed status verdict (RFC-1513's helpers return this under RFC-1515). */
export interface DirtyStatus {
  /** Porcelain lines that still count as uncommitted changes. */
  entries: string[];
  /** FORGE_STATE_FILES-matched untracked paths — journal data, never a blocker. */
  toleratedState: string[];
  /** True when the worktree path does not exist on disk — no git call ran. */
  vanished: boolean;
}

function isForgeStatePath(path: string): boolean {
  return FORGE_STATE_FILES.some((entry) =>
    entry.endsWith("/") ? path === entry || path.startsWith(entry) : path === entry,
  );
}

function porcelainLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * Tracked modifications in a worktree — `git status --porcelain
 * --untracked-files=no`; untracked and ignored files never count (missions/,
 * releases/, node_modules/ are operational state, not tracked content).
 * RFC-1515: a vanished worktree reports `vanished: true` instead of a raw
 * git exit-128 — callers classify the lifecycle state, not a crash.
 */
export async function statusTracked(worktree: string, io: WorkspaceIO): Promise<DirtyStatus> {
  if (!(await io.exists(worktree))) {
    return { entries: [], toleratedState: [], vanished: true };
  }
  const result = throwOnFailure(
    await git(worktree, io, ["status", "--porcelain", "--untracked-files=no"]),
    "git status --porcelain",
  );
  return { entries: porcelainLines(result.stdout), toleratedState: [], vanished: false };
}

/**
 * All uncommitted changes — `git status --porcelain -uall` (untracked `??`
 * entries included, ignored files still excluded). This is the dirty
 * definition `git worktree remove` enforces; use it wherever a check predicts
 * worktree-removability or asks "is this checkout dirty". `-uall` expands
 * untracked directories into their member files — the FORGE_STATE_FILES
 * partition must see `.forge/task/x`, never the collapsed `?? .forge/` line
 * (RFC-1515). Matched paths partition into `toleratedState` (journal data,
 * never a blocker); a vanished worktree reports `vanished: true` instead of
 * propagating exit-128.
 */
export async function statusDirty(worktree: string, io: WorkspaceIO): Promise<DirtyStatus> {
  if (!(await io.exists(worktree))) {
    return { entries: [], toleratedState: [], vanished: true };
  }
  const result = throwOnFailure(
    await git(worktree, io, ["status", "--porcelain", "-uall"]),
    "git status --porcelain",
  );
  const entries: string[] = [];
  const toleratedState: string[] = [];
  for (const line of porcelainLines(result.stdout)) {
    const path = line.slice(3);
    // Porcelain C-quotes unusual bytes ("dir/na\303\257ve.ts") — a quoted
    // path never matches the allowlist and stays a blocker (fail-closed).
    if (line.startsWith("?? ") && isForgeStatePath(path)) toleratedState.push(path);
    else entries.push(line);
  }
  return { entries, toleratedState, vanished: false };
}
