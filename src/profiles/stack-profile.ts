/*
<MODULE_CONTRACT>
<purpose>Stack profile schema, loader, and detector. Defines what a supported stack looks like and how to detect it in an existing project.</purpose>
<non-goals>
  <item>Do not scaffold projects — that is scaffold-project.ts.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0392: initial stack profile module with zod schema, listStackProfiles, detectStack.</item>
  <item>RFC-0638: extended stackProfileSchema with optional domain-neutral fields (domain, terminology, artifacts, workspaceTypes, invariants, register).</item>
  <item>RFC-0674: add devServer field to stackProfileSchema for lifecycle commands.</item>
  <item>RFC-0679: add assets field to stackProfileSchema for asset management commands.</item>
  <item>RFC-0680: add release field to stackProfileSchema for release lifecycle commands.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { stackProfileDomainFieldsSchema, type StackProfileDomainFields } from "./profile-schema.ts";

// ---------------------------------------------------------------------------
// Schema (forge/stack-profile@1)
// ---------------------------------------------------------------------------

export const stackProfileSchema = z.object({
  schema: z.literal("forge/stack-profile@1"),
  id: z.string().min(1),
  displayName: z.string().min(1),
  detect: z.object({
    anyOf: z.array(z.string()).min(1),
  }),
  workspace: z.object({
    dirs: z.array(z.string()).min(1),
    files: z.array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    ),
  }),
  install: z.array(z.string()).default([]),
  firstWorkspace: z
    .object({
      path: z.string().min(1),
      files: z.array(
        z.object({
          path: z.string().min(1),
          content: z.string(),
        }),
      ),
      install: z.array(z.string()).default([]),
    })
    .optional(),
  // RFC-0638: Domain-neutral optional fields
  domain: stackProfileDomainFieldsSchema.shape.domain,
  terminology: stackProfileDomainFieldsSchema.shape.terminology,
  artifacts: stackProfileDomainFieldsSchema.shape.artifacts,
  workspaceTypes: stackProfileDomainFieldsSchema.shape.workspaceTypes,
  invariants: stackProfileDomainFieldsSchema.shape.invariants,
  register: stackProfileDomainFieldsSchema.shape.register,
  // RFC-0674: Dev server declaration for lifecycle commands
  devServer: stackProfileDomainFieldsSchema.shape.devServer,
  // RFC-0679: Asset management declaration
  assets: stackProfileDomainFieldsSchema.shape.assets,
  // RFC-0680: Release lifecycle declaration
  release: stackProfileDomainFieldsSchema.shape.release,
  // Prerequisites: system-level dependency checks (e.g. FFmpeg)
  prerequisites: stackProfileDomainFieldsSchema.shape.prerequisites,
  // Templates: multi-template profiles (e.g. React + HTML)
  templates: stackProfileDomainFieldsSchema.shape.templates,
});

export interface ProfileFile {
  path: string;
  content: string;
}

export interface StackProfile extends StackProfileDomainFields {
  schema: "forge/stack-profile@1";
  id: string;
  displayName: string;
  detect: { anyOf: string[] };
  workspace: {
    dirs: string[];
    files: ProfileFile[];
  };
  install: string[];
  firstWorkspace?: {
    path: string;
    files: ProfileFile[];
    install: string[];
  };
  prerequisites?: import("./profile-schema.ts").ProfilePrerequisite[];
  templates?: import("./profile-schema.ts").ProfileTemplate[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadStackProfile(profilePath: string): StackProfile {
  const raw = fs.readFileSync(profilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Stack profile at ${profilePath} is not valid YAML: ${(err as Error).message}`);
  }

  const result = stackProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Stack profile at ${profilePath} failed schema validation:\n${issues}`);
  }

  return result.data as StackProfile;
}

export function listStackProfiles(forgeRoot: string): StackProfile[] {
  const profilesDir = path.join(forgeRoot, "profiles");
  if (!fs.existsSync(profilesDir)) {
    return [];
  }

  const entries = fs.readdirSync(profilesDir);
  const profiles: StackProfile[] = [];

  for (const entry of entries) {
    if (entry.endsWith(".yaml") && !entry.startsWith(".")) {
      const profilePath = path.join(profilesDir, entry);
      profiles.push(loadStackProfile(profilePath));
    }
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectStack(projectRoot: string, profiles: StackProfile[]): StackProfile | null {
  for (const profile of profiles) {
    if (matchesAnyOf(projectRoot, profile.detect.anyOf)) {
      return profile;
    }
  }
  return null;
}

function matchesAnyOf(projectRoot: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globExists(projectRoot, pattern)) {
      return true;
    }
  }
  return false;
}

function globExists(dir: string, pattern: string): boolean {
  // Simple glob: support * and *.ext patterns at the root level
  if (!pattern.includes("*")) {
    return fs.existsSync(path.join(dir, pattern));
  }

  try {
    const entries = fs.readdirSync(dir);
    const regex = globToRegex(pattern);
    return entries.some((e) => regex.test(e));
  } catch {
    return false;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
