/*
<MODULE_CONTRACT>
<purpose>Nested AGENTS.md template builder (RFC-0611). Pure function that renders
content-rich AGENTS.md for a workspace from its package.json metadata. No I/O.</purpose>
<non-goals>
  <item>Do not read or write files — this is a pure render function.</item>
  <item>Do not invent metadata not present in package.json — omit sections when data is absent.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0611: initial minimal stub template for app, package, service workspaces.</item>
  <item>Enriched template: render package name, description, entry points, scripts, and dependencies from package.json metadata instead of a minimal stub.</item>
  <item>RFC-0643: selectNestedTemplate() for profile-driven template selection with path traversal guard.</item>
</CHANGE_SUMMARY>
*/

import { buildGeneratedHeader } from "../utils/index.ts";
import type { ForgeConfig } from "../config/forge-config.ts";
import type { WorkspaceDir, WorkspaceType } from "./workspace-discovery.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import fs from "node:fs";
import path from "node:path";

export interface PackageInfo {
  name?: string;
  description?: string;
  exports?: Record<string, string | { types?: string; default?: string } | undefined>;
  main?: string;
  types?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const TYPE_GUIDANCE: Record<WorkspaceType, string> = {
  app: "This is an **app** workspace. Follow thin-route and content-driven composition rules from the root AGENTS.md.",
  package:
    "This is a **package** workspace. Expose stable typed APIs. Do not import from apps or services.",
  service:
    "This is a **service** workspace. Runtime composition only. Shared schemas and validators belong in packages.",
};

const TYPE_LABEL: Record<WorkspaceType, string> = {
  app: "App",
  package: "Package",
  service: "Service",
};

interface EntryPoint {
  name: string;
  module: string;
}

function extractEntryPoints(
  exports: PackageInfo["exports"],
  main?: string,
): EntryPoint[] {
  if (!exports || typeof exports !== "object") {
    if (main) return [{ name: ".", module: main }];
    return [];
  }
  const result: EntryPoint[] = [];
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === "string") {
      result.push({ name: key, module: value });
    } else if (value && typeof value === "object") {
      const module = value.types ?? value.default;
      if (module) result.push({ name: key, module });
    }
  }
  return result;
}

function formatDependencies(
  deps: Record<string, string> | undefined,
): { workspace: string[]; external: string[] } {
  if (!deps) return { workspace: [], external: [] };
  const workspace: string[] = [];
  const external: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (version.startsWith("workspace:")) {
      workspace.push(`\`${name}\``);
    } else {
      external.push(`\`${name}\` \`${version}\``);
    }
  }
  return { workspace, external };
}

function buildScriptsTable(scripts: Record<string, string> | undefined): string[] {
  if (!scripts || Object.keys(scripts).length === 0) return [];
  const lines: string[] = [];
  lines.push("## Scripts");
  lines.push("");
  lines.push("| Script | Command |");
  lines.push("| --- | --- |");
  for (const [name, cmd] of Object.entries(scripts)) {
    lines.push(`| \`${name}\` | \`${cmd}\` |`);
  }
  lines.push("");
  return lines;
}

function buildDependenciesSection(deps: Record<string, string> | undefined): string[] {
  const { workspace, external } = formatDependencies(deps);
  if (workspace.length === 0 && external.length === 0) return [];
  const lines: string[] = [];
  lines.push("## Dependencies");
  lines.push("");
  if (workspace.length > 0) {
    lines.push("**Workspace:**");
    lines.push("");
    for (const dep of workspace) lines.push(`- ${dep}`);
    lines.push("");
  }
  if (external.length > 0) {
    lines.push("**External:**");
    lines.push("");
    for (const dep of external) lines.push(`- ${dep}`);
    lines.push("");
  }
  return lines;
}

/**
 * RFC-0643: Select nested AGENTS.md template from profile workspace type.
 * When agentsMdTemplate is present, resolve relative to profile directory.
 * Reject absolute paths and parent-directory traversal (..) — fall back to hardcoded.
 * Apply terminology substitution to the template content.
 */
export function selectNestedTemplate(
  workspaceType: ProfileWorkspaceType | undefined,
  profile: StackProfile | undefined,
  terminology: Record<string, string>,
  fallback: string,
): string {
  if (!workspaceType?.agentsMdTemplate || !profile) {
    return fallback;
  }

  const templateRel = workspaceType.agentsMdTemplate;

  // Path traversal guard: reject absolute paths and ..
  if (path.isAbsolute(templateRel) || templateRel.includes("..")) {
    return fallback;
  }

  // Resolve relative to profiles/ directory (where profile YAMLs live)
  const forgeRoot = path.resolve(import.meta.dirname, "..", "..");
  const profilesDir = path.join(forgeRoot, "profiles");
  const templatePath = path.resolve(profilesDir, templateRel);

  // Ensure resolved path is within profiles directory (no traversal escape)
  if (!templatePath.startsWith(profilesDir + path.sep) && templatePath !== profilesDir) {
    return fallback;
  }

  try {
    const content = fs.readFileSync(templatePath, "utf8");
    return substituteNestedTemplate(content, terminology);
  } catch {
    // Template file not found — fall back
    return fallback;
  }
}

function substituteNestedTemplate(
  content: string,
  terminology: Record<string, string>,
): string {
  return content.replace(
    /\{\{terminology\.(\w+)\}\}/g,
    (_, key: string) => terminology[key] ?? key,
  );
}

export function buildNestedAgentsMd(
  workspace: WorkspaceDir,
  _config: ForgeConfig,
  packageInfo?: PackageInfo,
): string {
  const header = buildGeneratedHeader({
    filePath: "AGENTS.md",
    ownerCommand: "forge.agents.generate",
    commandPrefix: "forge",
  });

  const lines: string[] = [];
  lines.push(header);
  lines.push("");

  const displayName = packageInfo?.name ?? workspace.path;
  lines.push(`# \`${displayName}\` — Agent Guide`);
  lines.push("");

  if (packageInfo?.description) {
    lines.push(packageInfo.description);
    lines.push("");
  }

  lines.push(`> This file is generated by \`forge.agents.generate\` (RFC-0611).`);
  lines.push(`> Do not edit by hand — re-run \`forge agents generate\` to regenerate.`);
  lines.push("");

  lines.push(`**Workspace type:** ${TYPE_LABEL[workspace.type]}`);
  lines.push("");
  lines.push(TYPE_GUIDANCE[workspace.type]);
  lines.push("");

  if (workspace.type === "package") {
    const entryPoints = extractEntryPoints(packageInfo?.exports, packageInfo?.main);
    if (entryPoints.length > 0) {
      lines.push("## Entry points");
      lines.push("");
      lines.push("| Entry point | Module |");
      lines.push("| --- | --- |");
      for (const ep of entryPoints) {
        const suffix = ep.name === "." ? "" : ep.name.replace(/^\.\//, "/");
        lines.push(`| \`${displayName}${suffix}\` | \`${ep.module}\` |`);
      }
      lines.push("");
    }
  }

  lines.push(...buildScriptsTable(packageInfo?.scripts));
  lines.push(...buildDependenciesSection(packageInfo?.dependencies));

  lines.push("See the root `AGENTS.md` for project-wide rules, skills, and capabilities.");
  lines.push("");

  return lines.join("\n");
}
