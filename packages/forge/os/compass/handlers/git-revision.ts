/*
<MODULE_CONTRACT>
<purpose>Git revision lookup by file path. Moved from @warpgogol/site-kernel-integrity
to @warpgogol/forge for full autonomous mode (RFC-0556). Provides getRevisionByPath
with integrity-registry lookup and git-history fallback, plus getFileRevisionFromHistory.</purpose>
<non-goals>
  <item>Do not compute a new per-file counter — reuse the existing integrity revision.</item>
  <item>Do not modify the registry or write any files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0352: initial implementation of getRevisionByPath helper.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-integrity to @warpgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

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
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as EntitiesById;
  } catch {
    return {};
  }
}

async function loadPathsCurrent(cwd: string): Promise<PathsCurrent> {
  const filePath = join(cwd, ".integrity", "index", "paths.current.json");
  try {
    const content = await readFile(filePath, "utf8");
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
        const content = await readFile(abs, "utf8");
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
    const content = await readFile(abs, "utf8");
    contentHash = "sha256-" + createHash("sha256").update(content).digest("hex");
  } catch {
    // file may not exist
  }

  return { revision, entityId: null, contentHash };
}
