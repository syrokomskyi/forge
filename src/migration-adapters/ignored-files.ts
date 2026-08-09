/*
<MODULE_CONTRACT>
<purpose>Discover and categorize git-ignored/untracked files in a source project for interactive transfer selection during onboarding.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not copy files — discovery and categorization only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial: discoverIgnoredFiles function that scans source for git-ignored files, categorizes them by type (config, data, runtime-state, cache, other), and returns sized categories for operator selection.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type IgnoredFileCategoryId = "config" | "data" | "runtime-state" | "cache" | "other";

export interface IgnoredFileCategory {
  id: IgnoredFileCategoryId;
  label: string;
  description: string;
  paths: string[];
  totalSizeBytes: number;
  fileCount: number;
}

interface CategoryDef {
  id: IgnoredFileCategoryId;
  label: string;
  description: string;
  matchers: ((relPath: string) => boolean)[];
}

const CONFIG_MATCHERS: ((p: string) => boolean)[] = [
  (p) => p === ".env" || p.startsWith(".env."),
  (p) => p.endsWith(".key") || p.endsWith(".pem") || p.endsWith(".crt"),
  (p) => p === ".secret" || p.startsWith("secret"),
  (p) => p.startsWith("secrets/"),
  (p) => p.includes("/.env") || p.includes("/.env."),
  (p) => p === ".envrc" || p.startsWith(".envrc."),
];

const DATA_MATCHERS: ((p: string) => boolean)[] = [
  (p) => p.startsWith(".input/") || p.includes("/.input/"),
  (p) => p.startsWith("input/") || p.includes("/input/"),
  (p) => p.startsWith("inputs/") || p.includes("/inputs/"),
  (p) => p.startsWith("data/") || p.includes("/data/"),
  (p) => p.startsWith("assets/") || p.includes("/assets/"),
  (p) => p.startsWith("batches/") || p.includes("/batches/"),
  (p) => p.endsWith(".db") || p.endsWith(".sqlite") || p.endsWith(".sqlite3"),
  (p) => p.endsWith(".ndjson") && !p.startsWith("bordbuch/"),
];

const RUNTIME_STATE_MATCHERS: ((p: string) => boolean)[] = [
  (p) => p.startsWith("storage/") || p.includes("/storage/"),
  (p) => p.startsWith(".state/") || p.includes("/.state/"),
  (p) => p.startsWith("state/") || p.includes("/state/"),
  (p) => p.endsWith(".log"),
];

const CACHE_MATCHERS: ((p: string) => boolean)[] = [
  (p) => p.startsWith(".cache/") || p.includes("/.cache/"),
  (p) => p.startsWith("cache/") || p.includes("/cache/"),
  (p) => p.includes(".playwright") || p.includes("browser-profile"),
  (p) => p.endsWith(".tmp") || p.startsWith(".tmp"),
];

const CATEGORY_DEFS: CategoryDef[] = [
  {
    id: "config",
    label: "Configuration & secrets",
    description:
      "Environment files, API keys, certificates, and local configuration needed for the project to run.",
    matchers: CONFIG_MATCHERS,
  },
  {
    id: "data",
    label: "Data & inputs",
    description: "Input data, datasets, databases, and batch files used by the project.",
    matchers: DATA_MATCHERS,
  },
  {
    id: "runtime-state",
    label: "Runtime state",
    description: "Crawlee state, logs, and other runtime artifacts from previous executions.",
    matchers: RUNTIME_STATE_MATCHERS,
  },
  {
    id: "cache",
    label: "Caches",
    description: "Browser profiles, temporary files, and build caches that can be regenerated.",
    matchers: CACHE_MATCHERS,
  },
  {
    id: "other",
    label: "Other ignored files",
    description: "Files matched by .gitignore that don't fit into any standard category.",
    matchers: [],
  },
];

const CATEGORY_PRIORITY: Record<IgnoredFileCategoryId, number> = {
  config: 0,
  data: 1,
  "runtime-state": 2,
  cache: 3,
  other: 4,
};

function categorizePath(relPath: string): CategoryDef {
  const normalized = relPath.replace(/\\/g, "/");
  for (const def of CATEGORY_DEFS) {
    if (def.matchers.some((m) => m(normalized))) {
      return def;
    }
  }
  return CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
}

function getDirStats(dirPath: string): { size: number; count: number } {
  let size = 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = getDirStats(fullPath);
        size += sub.size;
        count += sub.count;
      } else if (entry.isFile()) {
        try {
          size += fs.statSync(fullPath).size;
          count++;
        } catch {
          // File may have been removed
        }
      }
    }
  } catch {
    // Directory may have been removed
  }
  return { size, count };
}

function getPathSize(fullPath: string): { sizeBytes: number; fileCount: number } {
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const { size, count } = getDirStats(fullPath);
      return { sizeBytes: size, fileCount: count };
    }
    return { sizeBytes: stat.size, fileCount: 1 };
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }
}

export function discoverIgnoredFiles(sourceDir: string): IgnoredFileCategory[] {
  const hasGit = fs.existsSync(path.join(sourceDir, ".git"));
  let ignoredPaths: string[] = [];

  if (hasGit) {
    try {
      const output = execFileSync("git", ["-C", sourceDir, "status", "--ignored", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });
      ignoredPaths = output
        .split("\n")
        .filter((l) => l.startsWith("!! "))
        .map((l) => l.slice(3).trim())
        .filter((p) => p.length > 0);
    } catch {
      // git command failed — return empty
      return [];
    }
  }

  if (ignoredPaths.length === 0) {
    return [];
  }

  const categoryMap = new Map<IgnoredFileCategoryId, IgnoredFileCategory>();

  for (const relPath of ignoredPaths) {
    const fullPath = path.join(sourceDir, relPath);
    const def = categorizePath(relPath);
    const { sizeBytes, fileCount } = getPathSize(fullPath);

    if (!categoryMap.has(def.id)) {
      categoryMap.set(def.id, {
        id: def.id,
        label: def.label,
        description: def.description,
        paths: [],
        totalSizeBytes: 0,
        fileCount: 0,
      });
    }

    const cat = categoryMap.get(def.id)!;
    cat.paths.push(relPath);
    cat.totalSizeBytes += sizeBytes;
    cat.fileCount += fileCount;
  }

  return Array.from(categoryMap.values()).sort(
    (a, b) => CATEGORY_PRIORITY[a.id] - CATEGORY_PRIORITY[b.id],
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
