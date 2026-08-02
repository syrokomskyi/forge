/*
<MODULE_CONTRACT>
<purpose>Workspace discovery for nested AGENTS.md generation (RFC-0611).
Scans the project root for directories containing package.json and auto-detects
workspace type (app, service, package) by content markers.</purpose>
<non-goals>
  <item>Do not scan node_modules, .git, dist, .turbo, .cache, .agents directories.</item>
  <item>Do not read package.json contents — only check existence for workspace detection.</item>
  <item>Do not add new workspace-type detection rules without an amending RFC.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0611: initial workspace discovery and type auto-detection.</item>
  <item>RFC-0640: accept optional workspaceTypes from profile for profile-driven detection, falling back to hardcoded detection when absent.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { hasGeneratedMarker } from "../utils/index.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";

export type WorkspaceType = "app" | "service" | "package" | string;

export interface WorkspaceDir {
  path: string;
  type: WorkspaceType;
  hasAgentsMd: boolean;
  isGenerated: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  ".cache",
  ".agents",
]);

export function detectWorkspaceType(
  dirPath: string,
  workspaceTypes?: ProfileWorkspaceType[],
): WorkspaceType | null {
  if (!fs.existsSync(path.join(dirPath, "package.json"))) return null;

  // RFC-0640: try profile-driven detection first
  if (workspaceTypes && workspaceTypes.length > 0) {
    for (const wt of workspaceTypes) {
      if (matchesWorkspaceType(dirPath, wt)) {
        return wt.id;
      }
    }
    // RFC-0640: when workspaceTypes is present, it fully replaces hardcoded detection
    // Directories matching no profile-declared workspace type are not classified
    return null;
  }

  // Fallback: hardcoded detection (software domain)
  if (
    fs.existsSync(path.join(dirPath, "astro.config.mjs")) ||
    fs.existsSync(path.join(dirPath, "astro.config.js")) ||
    fs.existsSync(path.join(dirPath, "astro.config.ts"))
  ) {
    return "app";
  }

  if (
    fs.existsSync(path.join(dirPath, "Dockerfile")) ||
    fs.existsSync(path.join(dirPath, "service.config.yaml")) ||
    fs.existsSync(path.join(dirPath, "service.config.yml"))
  ) {
    return "service";
  }

  return "package";
}

function matchesWorkspaceType(dirPath: string, wt: ProfileWorkspaceType): boolean {
  const { glob: globPattern, contains, packageJsonDep } = wt.detect;

  if (globPattern) {
    try {
      const entries = fs.readdirSync(dirPath);
      const regex = globToRegex(globPattern);
      if (entries.some((e) => regex.test(e))) return true;
    } catch {
      // dir not readable
    }
  }

  if (contains) {
    const filePath = path.join(dirPath, contains);
    if (fs.existsSync(filePath)) return true;
  }

  if (packageJsonDep) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf8"));
      const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      if (packageJsonDep in deps) return true;
    } catch {
      // package.json not readable
    }
  }

  return false;
}

export function discoverWorkspaces(
  workspaceRoot: string,
  workspaceTypes?: ProfileWorkspaceType[],
): WorkspaceDir[] {
  const results: WorkspaceDir[] = [];

  function scanDir(dirPath: string, depth: number): void {
    if (depth > 5) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const childPath = path.join(dirPath, entry.name);
      const type = detectWorkspaceType(childPath, workspaceTypes);

      if (type !== null) {
        const agentsMdPath = path.join(childPath, "AGENTS.md");
        const hasAgentsMd = fs.existsSync(agentsMdPath);
        let isGenerated = false;
        if (hasAgentsMd) {
          try {
            const content = fs.readFileSync(agentsMdPath, "utf8");
            isGenerated = hasGeneratedMarker(content);
          } catch {
            // unreadable — treat as not generated
          }
        }

        results.push({
          path: path.relative(workspaceRoot, childPath),
          type,
          hasAgentsMd,
          isGenerated,
        });

        scanDir(childPath, depth + 1);
      } else {
        scanDir(childPath, depth + 1);
      }
    }
  }

  scanDir(workspaceRoot, 0);
  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
