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
  <item>Exit 1 is a legitimate probe-command answer — helpers map it to typed answers; unexpected failures throw.</item>
  <item>flow.check/flow.install require git >= 2.30 — requireGit fails through the standard error path naming the detected version.</item>
  <item>FORGE_STATE_FILES is an exact-path/prefix allowlist; removers delete tolerated paths right before worktree removal.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>RFC-1515: close rfc-1515 review findings — delete tolerated paths before worktree remove, prune vanished registrations, verified branch -D, shared held-lock render, gated e2e throw, journal toleratedState, edge tests</item>
  <item>RFC-1515: record rfc-1515 review r1 fixes, key decisions and corrected probe path</item>
  <item>ADR-0124: enable git rerere in flow-managed repositories</item>
  <item>RFC-1531: worktreeAdd for --reattach; isForgeStatePath exported for the shared dirty classifier</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
  <history>RFC-1486, RFC-1487, RFC-1490, RFC-1491, RFC-1515</history>
</CHANGE_SUMMARY>
*/

import type { ExecResult, WorkspaceIO } from "../../src/types.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";
import { execFile } from "node:child_process";
import {
  resolveGitBin,
  verifierGitEnv,
  filterEvidenceExtraEnv,
  EVIDENCE_CONFIG_ARGS,
} from "../../src/utils/verifier-git.ts";

export const MIN_GIT_VERSION = "2.33";

/**
 * One argv-shaped allowlist entry — mirrors the ReadOnlyGitQuery shape in
 * @warpgogol/werkstatt-shared kernel/workspace-io.ts. Forge's `src/` is
 * autonomous (no runtime imports from werkstatt-shared), so the evidence
 * channel keeps its own mirror; the parity test asserts this table never
 * admits an argv the shared read-only table (plus the one pinned fetch
 * form) would not.
 */
interface EvidenceGitQuery {
  prefix: readonly string[];
  forbid?: readonly string[];
  maxPositionals?: number;
}

const BRANCH_WRITE_FLAGS = [
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
] as const;

/**
 * The argv space `gitEvidence` may spawn — a mirror of the shared
 * READ_ONLY_GIT_QUERIES table plus `fetch`, the one mutating op the
 * channel legitimately runs (it refreshes remote-tracking refs; the
 * `--upload-pack`/`--exec` levers that exec a repo-config program on the
 * remote side stay forbidden). `config` is admitted only in its
 * `config --get*` forms — a bare `config` argv could write repo state on
 * the trusted channel.
 */
const EVIDENCE_GIT_QUERIES: readonly EvidenceGitQuery[] = [
  { prefix: ["--version"], maxPositionals: 0 },
  { prefix: ["rev-parse"] },
  { prefix: ["worktree", "list"] },
  { prefix: ["ls-files"] },
  { prefix: ["ls-tree"] },
  { prefix: ["cat-file"] },
  { prefix: ["rev-list"], forbid: ["--output"] },
  { prefix: ["merge-base"] },
  { prefix: ["for-each-ref"] },
  { prefix: ["show-ref"] },
  { prefix: ["describe"] },
  { prefix: ["status"] },
  { prefix: ["log"], forbid: ["--output", "--ext-diff"] },
  { prefix: ["diff"], forbid: ["--output", "--ext-diff"] },
  { prefix: ["show"], forbid: ["--output", "--ext-diff"] },
  { prefix: ["symbolic-ref"], forbid: ["-d", "--delete", "-m"], maxPositionals: 1 },
  { prefix: ["config", "--get"] },
  { prefix: ["config", "--get-all"] },
  { prefix: ["config", "--get-regexp"] },
  { prefix: ["remote", "get-url"] },
  { prefix: ["ls-remote"], forbid: ["--upload-pack", "--exec", "-u"] },
  { prefix: ["branch", "--show-current"], maxPositionals: 0 },
  { prefix: ["branch", "--list"], forbid: BRANCH_WRITE_FLAGS },
  { prefix: ["fetch"], forbid: ["--upload-pack", "--exec", "-u"] },
];

/**
 * Same forbidden-argument judgment as the shared table: a long flag
 * exactly, with `=value`, or abbreviated; a short flag alone or inside a
 * cluster. Over-matching a harmless arg only refuses a read — safe.
 */
function isForbiddenEvidenceArg(arg: string, forbid: readonly string[]): boolean {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0];
    if (name.length === 0) return false;
    return forbid.some((f) => f.startsWith("--") && f.slice(2).startsWith(name));
  }
  if (arg.startsWith("-") && arg.length > 1) {
    const cluster = arg.slice(1);
    return forbid.some((f) => /^-[^-]$/.test(f) && cluster.includes(f[1]));
  }
  return false;
}

/**
 * Runtime argv judgment for the evidence channel — the predicate the
 * static scan assumes exists behind `gitEvidence` the way
 * isReadOnlyGitQuery sits behind `git()` on io.exec (CX-70: a dynamic
 * argv tail like `["log", ...flags]` was static-exempt and ran unjudged,
 * so `--ext-diff`/`--output` could reach the trusted subprocess). The
 * body-owned `-C`/`-c` pins are added after this check and are not part
 * of the judged argv.
 */
export function isEvidenceGitQuery(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  return EVIDENCE_GIT_QUERIES.some((query) => {
    if (!query.prefix.every((part, i) => args[i] === part)) return false;
    const tail = args.slice(query.prefix.length);
    if (query.forbid !== undefined && tail.some((a) => isForbiddenEvidenceArg(a, query.forbid!))) {
      return false;
    }
    if (query.maxPositionals !== undefined) {
      const positionals = tail.filter((arg) => !arg.startsWith("-")).length;
      if (positionals > query.maxPositionals) return false;
    }
    return true;
  });
}

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
  // Writes and session-config ops (commit identity, credential helpers,
  // url.insteadOf, hooks) need the session environment — the scrubbed
  // evidence channel drops global config, which would break authenticated
  // push and configured commit identity for every consumer.
  return io.exec("git", ["-C", repoRoot, ...args], { env: opts?.env });
}

/**
 * RFC-1616: git on the trust boundary — same `-C <root>` call shape as
 * `git()`, but spawned on the resolved real binary with a scrubbed env:
 * session `GIT_*` variables are stripped wholesale (repo redirection,
 * config/URL rewrites, transport and exec-path overrides), `refs/replace`
 * substitution is off, global/system config reads `/dev/null`, and the
 * executable cannot be a session PATH shim — committed evidence the
 * verifier judges must be the object's real bytes (CX-46..CX-52). The
 * execFile call stays inside this argv-shaped body so the read-only scan's
 * git-allowlist model judges every callsite's argv the same way it judges
 * `git()` routes; `io.exec` merges env over `process.env` and could never
 * delete a hostile variable, which is why evidence reads do not go through
 * the io adapter. The ExecResult shape stays identical.
 */
export async function gitEvidence(
  repoRoot: string,
  args: string[],
  opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): Promise<ExecResult> {
  // Runtime argv judgment — the evidence channel spawns a trusted git, so
  // nothing beyond the read-only + pinned-fetch table may reach it, even
  // through a dynamic tail the static scan cannot see (CX-70).
  if (!isEvidenceGitQuery(args)) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `gitEvidence refused argv outside the evidence allowlist: git ${args.join(" ")}`,
    };
  }
  return new Promise((resolve) => {
    try {
      execFile(
        resolveGitBin(),
        ["-C", repoRoot, ...EVIDENCE_CONFIG_ARGS, ...args],
        {
          cwd: repoRoot,
          env: { ...verifierGitEnv(), ...filterEvidenceExtraEnv(opts?.extraEnv) },
          // Network-shaped ops are routed to git(); boundary reads are local
          // and still fast — the generous default mirrors io.exec callers.
          timeout: opts?.timeoutMs ?? 600_000,
          maxBuffer: 64 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: String(e) });
    }
  });
}

/** `topLevel` over the scrubbed boundary channel — same canonicalization. */
export async function verifierTopLevel(cwd: string): Promise<string | null> {
  const result = await gitEvidence(cwd, ["rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? canonicalRepoDir(result.stdout.trim()) : null;
}

/**
 * Normalize one `%(trailers:only)` output into `{key, value}` entries —
 * git's own parser decides what is a trailer, so `x-verifier-report:` and
 * `X-Verifier-Report :` spellings both appear here (case-insensitive key,
 * whitespace folded); a hand-rolled body regex cannot match this
 * normalization and misses Git-recognized trailer forms (CX-60).
 */
export function parseGitTrailers(stdout: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of stdout.split("\n")) {
    const m = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (m) out.push({ key: m[1]!.trim().toLowerCase(), value: m[2]!.trim() });
  }
  return out;
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

/** Require git >= 2.30 — the resolved real binary answers, not whatever a
 * session PATH shim reports for `git` (CX-52). */
export async function requireGit(io: WorkspaceIO): Promise<void> {
  void io;
  const result = await gitEvidence(process.cwd(), ["--version"]);
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
export async function topLevel(cwd: string, _io: WorkspaceIO): Promise<string | null> {
  const result = await gitEvidence(cwd, ["rev-parse", "--show-toplevel"]);
  // Canonicalize to the native real path — git reports forward slashes and
  // the on-disk long name, while callers hold whatever spelling the user
  // passed (possibly an 8.3 alias on Windows); the canonical form is what
  // downstream equality comparisons are written against.
  return result.exitCode === 0 ? canonicalRepoDir(result.stdout.trim()) : null;
}

export async function isBare(repoRoot: string, _io: WorkspaceIO): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--is-bare-repository"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Current branch short name; null on detached HEAD (symbolic-ref fails). */
export async function currentBranch(repoRoot: string, _io: WorkspaceIO): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** True when HEAD has no commit yet (unborn branch). */
export async function isUnborn(repoRoot: string, _io: WorkspaceIO): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.exitCode !== 0;
}

export async function listLocalBranches(repoRoot: string, _io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    "git for-each-ref",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remote-tracking refs under `refs/remotes` as `<remote>/<branch>` shorts. */
export async function listRemoteBranches(repoRoot: string, _io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
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
  _io: WorkspaceIO,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
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
  const result = await gitEvidence(repoRoot, ["log", "-1", "--format=%cI", ref]);
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

export async function branchExists(
  repoRoot: string,
  io: WorkspaceIO,
  name: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  return result.exitCode === 0;
}

/** Commit count in a rev range, e.g. "develop..main". */
export async function revListCount(
  repoRoot: string,
  io: WorkspaceIO,
  range: string,
): Promise<number> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["rev-list", "--count", range]),
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
  const result = await gitEvidence(repoRoot, ["rev-list", "-1", `--grep=${grep}`, ref]);
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
  const result = await gitEvidence(repoRoot, ["cat-file", "-e", `${ref}:${path}`]);
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
export async function worktreeList(repoRoot: string, _io: WorkspaceIO): Promise<FlowWorktree[]> {
  // Worktree topology feeds primary-checkout resolution on the boundary —
  // scrubbed channel so a session GIT_* cannot redirect it (CX-51 class).
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["worktree", "list", "--porcelain"]),
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

/**
 * RFC-1531: `git worktree add <path> <branch>` for an EXISTING branch — the
 * reattach leg of a vanished registered worktree. Thin wrapper: the caller
 * reads the exit code (FLOW-INT-17 on failure); it never throws.
 */
export async function worktreeAdd(
  repoRoot: string,
  io: WorkspaceIO,
  path: string,
  branch: string,
): Promise<ExecResult> {
  return git(repoRoot, io, ["worktree", "add", path, branch]);
}

/** `git config --get` — null when the key is unset (exit 1). */
export async function configGet(
  repoRoot: string,
  io: WorkspaceIO,
  key: string,
): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["config", "--get", key]);
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw new Error(
    `git config --get ${key} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/**
 * ADR-0124: flow-managed repositories keep `rerere.enabled` and
 * `rerere.autoupdate` set — an identical rebase conflict shape replays the
 * recorded resolution instead of demanding a fresh manual resolve on every
 * `develop` advance. Shared repository config: always write against the
 * repo root, never --worktree (rr-cache lives in the common git dir).
 * Returns human-readable failure strings; a write failure degrades to a
 * diagnostic, never a refusal.
 */
export async function ensureRerere(repoRoot: string, io: WorkspaceIO): Promise<string[]> {
  const failures: string[] = [];
  for (const [key, value] of [
    ["rerere.enabled", "true"],
    ["rerere.autoupdate", "true"],
  ] as const) {
    const r = await git(repoRoot, io, ["config", key, value]);
    if (r.exitCode !== 0) {
      failures.push(`git config ${key} ${value} failed: ${r.stderr.trim()}`);
    }
  }
  return failures;
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

/** Exported for the RFC-1531 dirty classifier — same path allowlist check. */
export function isForgeStatePath(path: string): boolean {
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
    await gitEvidence(worktree, ["status", "--porcelain", "--untracked-files=no"]),
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
    await gitEvidence(worktree, ["status", "--porcelain", "-uall"]),
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
