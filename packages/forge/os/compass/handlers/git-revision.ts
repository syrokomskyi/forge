/*
<MODULE_CONTRACT>
<purpose>Git revision and worktree-dirtiness lookup by file path. Moved from
@warpgogol/site-kernel-integrity to @warpgogol/forge for full autonomous mode (RFC-0556).
Provides getRevisionByPath with integrity-registry lookup and git-history fallback,
plus getFileRevisionFromHistory and the porcelain dirty-path helpers
(listDirtyPaths/isDirtyPath) shared by write-refusing commands.</purpose>
<non-goals>
  <item>Do not compute a new per-file counter — reuse the existing integrity revision.</item>
  <item>Do not modify the registry or write any files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0352: initial implementation of getRevisionByPath helper.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-integrity to @warpgogol/forge for autonomous mode.</item>
  <item>RFC-1318: add compass.header.scaffold codemod for mechanical header sweeps</item>
  <item>RFC-1318</item>
</CHANGE_SUMMARY>
*/

import { execFile, execFileSync } from "../../../src/utils/sync-fs.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { resolve, join } from "node:path";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

export const DIRTY_LIST_CAP = 20;

/** Paths with uncommitted changes under `repoRoot` — null when not a git repo. */
export function listDirtyPaths(repoRoot: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return out
      .split("\n")
      .filter((line) => line.length >= 3)
      .map((line) => {
        // Porcelain is `XY <path>` — slice the raw line so leading-space
        // status pairs (e.g. " M") keep their offsets.
        let path = line.slice(3);
        // Rename entries read `old -> new`; the live path is the target.
        const arrow = path.indexOf(" -> ");
        if (arrow >= 0) path = path.slice(arrow + 4);
        return path.replace(/^"|"$/g, "");
      })
      .filter(Boolean);
  } catch {
    // Not a git repository — nothing to protect, skip the check.
    return null;
  }
}

/**
 * Whether `path` is covered by the dirty set. Git collapses untracked
 * directories to `?? dir/`, so a dirty directory prefix counts as dirty too.
 */
export function isDirtyPath(path: string, dirty: readonly string[]): boolean {
  return dirty.some((d) => path === d || (d.endsWith("/") && path.startsWith(d)));
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trimEnd();
}

export async function getFileRevisionFromHistory(cwd: string, repoPath: string): Promise<number> {
  try {
    const output = await runGit(
      cwd,
      ["log", "--follow", "--diff-filter=AMT", "--format=%H", "--", repoPath],
      15_000,
    ).catch(() => "");

    if (!output) {
      return 1;
    }

    const revisions = output.split("\n").filter(Boolean).length;
    return Math.max(1, revisions);
  } catch {
    return 1;
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
  revision: number;
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
