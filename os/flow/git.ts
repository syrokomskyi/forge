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
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 1 — fixed branch-model grammar, marker detection contracts, git helpers</item>
  <item>RFC-1486: step 1 — branch grammar, marker detection, git helpers</item>
  <item>RFC-1486: review r1 — committed-state adoption gate, uncommitted-hook committedness, step-failure trail, idempotency declaration, lazy asset resolution</item>
</CHANGE_SUMMARY>
*/

import type { ExecResult, WorkspaceIO } from "../../src/types.ts";

export const MIN_GIT_VERSION = "2.30";

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
  return result.exitCode === 0 ? result.stdout.trim() : null;
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
        path: current.path,
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
 * Tracked modifications in a worktree — `git status --porcelain
 * --untracked-files=no`; untracked and ignored files never count (missions/,
 * releases/, node_modules/ are operational state, not tracked content).
 */
export async function statusTracked(worktree: string, io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await git(worktree, io, ["status", "--porcelain", "--untracked-files=no"]),
    "git status --porcelain",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
