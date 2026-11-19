/*
<MODULE_CONTRACT>
<purpose>Git revision and worktree-dirtiness lookup by file path. Moved from
@warpgogol/site-kernel-integrity to @warpgogol/forge for full autonomous mode (RFC-0556).
Provides getRevisionByPath with integrity-registry lookup and git-history fallback,
plus getFileRevisionFromHistory and the porcelain dirty-path helpers
(repoTopLevel/listDirtyPaths/isDirtyPath) shared by write-refusing commands.</purpose>
<non-goals>
  <item>Do not compute a new per-file counter — reuse the existing integrity revision.</item>
  <item>Do not modify the registry or write any files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r14 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r16 trust-boundary counterexamples</item>
  <item>RFC-1616: close r19 counterexamples CX-166 through CX-171</item>
  <item>RFC-1616: close r22 counterexamples — spawn-window watch, topology honor, !! provenance</item>
  <history>RFC-0352, RFC-0556, RFC-1318</history>
</CHANGE_SUMMARY>
*/

import { ambientIo } from "../../../src/utils/io.ts";
import { canonicalRepoDir } from "../../../src/utils/repo-path.ts";
import {
  repoShaped,
  sessionIgnoreRulePaths,
  unprovenIgnoredPaths,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { createHash } from "node:crypto";

import { resolve, join } from "node:path";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;

export const DIRTY_LIST_CAP = 20;

// Re-exported for the compass handlers that canonicalize through this
// module's git seam; the implementation lives in src/utils/repo-path.ts.
export { canonicalRepoDir };

/** The repository top-level containing `repoRoot` — null when not a git repo. */
export async function repoTopLevel(repoRoot: string): Promise<string | null> {
  const r = await verifierGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  const out = r.stdout.trim();
  return r.exitCode === 0 && out.length > 0 ? out : null;
}

export interface DirtyPathResult {
  /** Porcelain paths — null when the workspace is not a git repo. */
  paths: string[] | null;
  /**
   * True when the trusted channel refused to answer (a session-forged repo
   * surface — object/config/shape violation — made the dirty verdict
   * unprovable). Callers must treat refusal as dirty: a write guard that
   * skips on refusal fails open on exactly the forgery it guards (CX-121).
   */
  refused: boolean;
  reason?: string;
}

/** Paths with uncommitted changes under `repoRoot` — see DirtyPathResult. */
export async function listDirtyPaths(repoRoot: string): Promise<DirtyPathResult> {
  // Anchor the enumeration at the worktree toplevel — porcelain paths
  // are cwd-relative by default, so a subdirectory cwd would emit
  // `../`-truncated bases `isDirtyPath` can never match against
  // repo-relative callers (CX-167). A refused/absent resolution falls
  // back to the given cwd — the status call below re-judges it anyway.
  const top = await repoTopLevel(repoRoot);
  const scanRoot = top ?? repoRoot;
  const r = await verifierGit(scanRoot, ["status", "--porcelain"]);
  if (r.exitCode !== 0) {
    // Not-a-repo answers the same non-zero way a refused channel does —
    // `git rev-parse` separates the two (a plain missing repo must still
    // read as "nothing to protect", a refused verdict must block). The
    // probe rides the same channel, so a channel-wide refusal ALSO
    // answers -1 — the fs-level repoShaped check is the second witness:
    // git state exists to forge and the failed read stays unverifiable,
    // never the benign not-a-repo shape (CX-151/152/156).
    const probe = await verifierGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    const isRepo = probe.exitCode === 0 && probe.stdout.trim() === "true";
    const refused = isRepo || repoShaped(repoRoot);
    return {
      paths: null,
      refused,
      reason: refused ? r.stderr.trim() : undefined,
    };
  }
  const base = r.stdout
    .split("\n")
    // `!!` entries are committed-rule ignores — not dirty (the injected
    // `--ignored` only makes them VISIBLE, CX-142).
    .filter((line) => line.length >= 3 && !line.startsWith("!! "))
    .map((line) => {
      // Porcelain is `XY <path>` — slice the raw line so leading-space
      // status pairs (e.g. " M") keep their offsets. A stray \r survives
      // the split when git output is CRLF-terminated — never part of a path.
      let path = line.slice(3).replace(/\r$/, "");
      // Rename entries read `old -> new`; the live path is the target.
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      return path.replace(/^"|"$/g, "");
    })
    .filter(Boolean);
  // Session-authored ignore rules: an untracked `.gitignore` hides
  // itself and every covered path from status entirely — only an fs
  // walk + tracked-set check can prove a rule session-authored, and it
  // always counts as dirt (CX-142). A failed tracked read counts every
  // found rule — fail closed.
  // Session-authored ignore rules: an untracked `.gitignore` hides
  // itself and every covered path from status entirely — only an fs
  // walk + tracked-set check can prove a rule session-authored, and it
  // always counts as dirt (CX-142). A failed tracked read counts every
  // found rule — fail closed. `null` means the worktree toplevel could
  // not be resolved on the channel that JUST answered status — a
  // mid-call sabotage class; the dirty set is unverifiable, not empty
  // (CX-167).
  const sessionRules = await sessionIgnoreRulePaths(repoRoot, async (paths, root) => {
    const t = await verifierGit(root, ["ls-files", "-z", "--", ...paths]);
    return t.exitCode === 0 ? new Set(t.stdout.split("\0").filter((p) => p.length > 0)) : null;
  });
  if (sessionRules === null) {
    return {
      paths: null,
      refused: true,
      reason: "worktree toplevel unresolvable — session ignore-rule set is unverifiable",
    };
  }
  // `!!` provenance (CX-r22): each ignored claim must trace to a
  // TRACKED `.gitignore` — a `.gitignore` planted inside the child's own
  // lifetime reclassifies `??` payloads as `!!` while its rule source
  // was never checkable, so an unproven `!!` path rejoins the dirty set.
  const unprovenIgnored = await unprovenIgnoredPaths(
    scanRoot,
    r.stdout
      .split("\n")
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3)),
  );
  if (unprovenIgnored === null) {
    return {
      paths: null,
      refused: true,
      reason: "ignored-path rule provenance unverifiable",
    };
  }
  return {
    paths: [...new Set([...base, ...sessionRules, ...unprovenIgnored])],
    refused: false,
  };
}

/**
 * Whether `path` is covered by the dirty set. Git collapses untracked
 * directories to `?? dir/`, so a dirty directory prefix counts as dirty too.
 */
export function isDirtyPath(path: string, dirty: readonly string[]): boolean {
  return dirty.some((d) => path === d || (d.endsWith("/") && path.startsWith(d)));
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const r = await verifierGit(cwd, args, { timeoutMs: 15_000, maxBuffer: 20 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r.stdout.trimEnd();
}

/**
 * Count of history revisions touching `repoPath` — `null` when the
 * history cannot be read (refused channel, dead git). `1` means "no
 * recorded history" — a real answer — and is only ever returned when
 * the channel genuinely succeeded with empty output. A refused read
 * collapsed to `1` let audit gates treat sabotage as a current/clean
 * revision (CX-168).
 */
export async function getFileRevisionFromHistory(
  cwd: string,
  repoPath: string,
): Promise<number | null> {
  try {
    const output = await runGit(cwd, [
      "log",
      "--follow",
      "--diff-filter=AMT",
      "--format=%H",
      "--",
      repoPath,
    ]);

    if (!output) {
      return 1;
    }

    const revisions = output.split("\n").filter(Boolean).length;
    return Math.max(1, revisions);
  } catch {
    return null;
  }
}

interface RegistryEntity {
  currentPath: string;
  firstPath?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  contentHash: string;
  gitSha: string;
  status: "active" | "deleted";
  moves?: Array<{ from: string; to: string; detectedAt: string; method: string }>;
}

type EntitiesById = Record<string, RegistryEntity>;
type PathsCurrent = Record<string, string>;

async function loadEntitiesById(cwd: string): Promise<EntitiesById> {
  const filePath = join(cwd, ".integrity", "index", "entities.by-id.json");
  try {
    const content = await io.readFile(filePath);
    return JSON.parse(content) as EntitiesById;
  } catch {
    return {};
  }
}

async function loadPathsCurrent(cwd: string): Promise<PathsCurrent> {
  const filePath = join(cwd, ".integrity", "index", "paths.current.json");
  try {
    const content = await io.readFile(filePath);
    return JSON.parse(content) as PathsCurrent;
  } catch {
    return {};
  }
}

export interface RevisionByPathResult {
  /**
   * The file's revision — `null` when neither the registry nor git
   * history could prove it (refused channel, dead git). Callers treat
   * `null` as UNVERIFIABLE — never as "revision 1" or "no history"
   * (CX-168).
   */
  revision: number | null;
  entityId: string | null;
  contentHash: string;
}

export async function getRevisionByPath(
  cwd: string,
  repoPath: string,
): Promise<RevisionByPathResult> {
  const paths = await loadPathsCurrent(cwd);
  const entityId = paths[repoPath];

  if (entityId) {
    const entities = await loadEntitiesById(cwd);
    const entity = entities[entityId];
    if (entity) {
      let contentHash = entity.contentHash;
      try {
        const abs = resolve(cwd, repoPath);
        const content = await io.readFile(abs);
        contentHash = "sha256-" + createHash("sha256").update(content).digest("hex");
      } catch {
        // keep registry hash
      }
      return {
        revision: entity.revision,
        entityId,
        contentHash,
      };
    }
  }

  const revision = await getFileRevisionFromHistory(cwd, repoPath);
  let contentHash = "";
  try {
    const abs = resolve(cwd, repoPath);
    const content = await io.readFile(abs);
    contentHash = "sha256-" + createHash("sha256").update(content).digest("hex");
  } catch {
    // file may not exist
  }

  return { revision, entityId: null, contentHash };
}
