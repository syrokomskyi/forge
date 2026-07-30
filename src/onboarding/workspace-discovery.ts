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
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { hasGeneratedMarker } from "../utils/index.ts";

export type WorkspaceType = "app" | "service" | "package";

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

export function detectWorkspaceType(dirPath: string): WorkspaceType | null {
  if (!fs.existsSync(path.join(dirPath, "package.json"))) return null;

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

export function discoverWorkspaces(workspaceRoot: string): WorkspaceDir[] {
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
      const type = detectWorkspaceType(childPath);

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
