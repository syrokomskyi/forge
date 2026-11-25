/*
<MODULE_CONTRACT>
<purpose>
Git operations substrate for the integration queue (Werkstatt RFC-1647) — pure
plumbing, no worktrees: commit-chain replay via merge-tree --write-tree with the
replayed commit's parent as merge-base (exact cherry-pick semantics), commit
materialization via commit-tree into the repo's own object store. Squash is
forbidden: the chain replays commit-by-commit preserving messages, authorship
and governance trailers. Objects never leave the main object store, so the
candidate survives independent of any scratch lifetime.
</purpose>
<non-goals>
  <item>No evaluation or verdict logic — git mechanics only.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): plumbing-only — merge-tree/commit-tree, zero worktrees.</item>
</CHANGE_SUMMARY>
*/

import { execFileSync, spawnSync } from "node:child_process";

export interface GitExec {
  (args: string[], cwd: string): string;
}

export const defaultGitExec: GitExec = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function resolveRef(git: GitExec, repoDir: string, ref: string): string {
  return git(["rev-parse", ref], repoDir).trim();
}

export function treeOfCommit(git: GitExec, repoDir: string, commitSha: string): string {
  return git(["rev-parse", `${commitSha}^{tree}`], repoDir).trim();
}

export function commitExists(git: GitExec, repoDir: string, sha: string): boolean {
  try {
    git(["cat-file", "-e", sha], repoDir);
    return true;
  } catch {
    return false;
  }
}

export function commitTreeEquals(git: GitExec, repoDir: string, sha: string, treeDigest: string): boolean {
  try {
    return treeOfCommit(git, repoDir, sha) === treeDigest;
  } catch {
    return false;
  }
}

export interface ReplayResult {
  ok: true;
  candidateCommit: string;
  candidateTree: string;
  replayedCount: number;
}

export interface ReplayConflict {
  ok: false;
  conflictingPaths: string[];
  atCommit: string;
}

interface MergeTreeOutcome {
  conflicted: boolean;
  tree: string | null;
  conflictedPaths: string[];
}

/**
 * One merge-tree execution, exit status as the conflict signal. Output format:
 * first line the tree oid; on conflict a section of conflicted-file records
 * whose lines carry the path as the last whitespace-separated token.
 */
function runMergeTree(repoDir: string, base: string, ours: string, theirs: string): MergeTreeOutcome {
  const res = spawnSync("git", ["merge-tree", "--write-tree", "--merge-base", base, ours, theirs], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const out = res.stdout ?? "";
  const lines = out.split("\n");
  const tree = lines[0]?.trim() || null;
  const conflicted = res.status !== 0;
  const conflictedPaths = conflicted
    ? [
        ...new Set(
          lines
            .slice(1)
            .map((l) => l.trim())
            .filter((l) => /^\d+ \d+ [0-9a-f]{7,40} \d+\t?.+/i.test(l) || l.includes("\t"))
            .map((l) => l.split(/\s+/).pop() ?? "")
            .filter(Boolean),
        ),
      ]
    : [];
  return { conflicted, tree, conflictedPaths };
}

function commitMeta(git: GitExec, repoDir: string, commit: string): { message: string; authorName: string; authorEmail: string; authorDate: string } {
  const sep = "@@META@@";
  const message = git(["log", "-1", "--format=%B", commit], repoDir);
  const meta = git(["log", "-1", `--format=${sep}%an${sep}%ae${sep}%aI`, commit], repoDir).trim().split(sep).filter(Boolean);
  return {
    message: message.trimEnd(),
    authorName: meta[1] ?? "integration-queue",
    authorEmail: meta[2] ?? "queue@localhost",
    authorDate: meta[3] ?? new Date().toISOString(),
  };
}

/**
 * Rebase-materialize: replay the chain commit-by-commit onto the current head
 * using merge-tree with the commit's parent as merge-base — exact cherry-pick
 * tree semantics, no worktree, no checkout. Each step materializes its own
 * commit object (never squashed). First conflict stops the replay and names
 * the conflicting paths per-commit.
 */
export function replayChainOntoHead(
  git: GitExec,
  repoDir: string,
  headSha: string,
  commitChain: string[],
): ReplayResult | ReplayConflict {
  let tip = headSha;
  let replayed = 0;

  for (const commit of commitChain) {
    const parent = git(["rev-parse", `${commit}^`], repoDir).trim();
    const outcome = runMergeTree(repoDir, parent, tip, commit);
    if (outcome.conflicted || !outcome.tree) {
      return {
        ok: false,
        conflictingPaths: outcome.conflictedPaths.length > 0 ? outcome.conflictedPaths : ["(conflict — paths unparsed)"],
        atCommit: commit,
      };
    }

    const meta = commitMeta(git, repoDir, commit);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: meta.authorName,
      GIT_AUTHOR_EMAIL: meta.authorEmail,
      GIT_AUTHOR_DATE: meta.authorDate,
      GIT_COMMITTER_NAME: meta.authorName,
      GIT_COMMITTER_EMAIL: meta.authorEmail,
    };
    const newCommit = execFileSync("git", ["commit-tree", outcome.tree, "-p", tip, "-m", meta.message], {
      cwd: repoDir,
      encoding: "utf8",
      env,
    }).trim();
    tip = newCommit;
    replayed += 1;
  }

  const candidateTree = treeOfCommit(git, repoDir, tip);
  return { ok: true, candidateCommit: tip, candidateTree, replayedCount: replayed };
}

/**
 * Integrate the candidate into the governed ref — the single write point.
 * update-ref is atomic; the candidate commits already live in this object store.
 */
export function integrateCandidate(
  git: GitExec,
  repoDir: string,
  governedRef: string,
  candidateCommit: string,
): void {
  git(["update-ref", governedRef, candidateCommit], repoDir);
}
