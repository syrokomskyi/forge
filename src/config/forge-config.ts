/*
<MODULE_CONTRACT>
<purpose>Forge project configuration — forge.yaml schema, loader, forge root resolver, and bindings contract. Single source of truth for how forge is deployed in a project.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0391: initial forge-config module with zod schema, loadForgeConfig, resolveForgeRoot.</item>
  <item>RFC-0393: added ForgeBindings schema, resolveBinding with placeholder substitution.</item>
  <item>RFC-0538: added optional compass binding section (fileExtensions, testPatterns).</item>
  <item>RFC-0537: added sessionsDir to paths and bindings.paths schemas.</item>
  <item>RFC-0539: added ForgeSkillPack schema and skillPacks to forge config for project-declared skill packs.</item>
  <item>RFC-0540: added implementStamp to bindings schema, FORGE_CLI_BINDING_DEFAULTS, PM_RUNNER_MAP, resolvePmRunner, applyCliBindingDefaults.</item>
  <item>RFC-0540 fix: eliminated type casts — applyCliBindingDefaults returns ForgeBindings["commands"] directly, resolvePackageManager validates pm against enum.</item>
  <item>RFC-0543: added optional forge.syncedVersion field to forgeConfigSchema and defaultForgeConfig for consumer upgrade tracking.</item>
  <item>RFC-0546: added optional migrationAdapters field to forgeConfigSchema for migration-adapter registry discovery.</item>
  <item>RFC-0639: added 5 semantic command keys (validate, produce, verify, preview, lint), terminology promoted from .optional() to .default({}), resolveTerminology function.</item>
  <item>RFC-0640: added optional domain field to project section for domain-aware bootstrapping and health checks.</item>
  <item>RFC-0643: added optional profile field to forgeConfigSchema and ForgeConfig; loadForgeConfig loads profiles/<id>.yaml when present.</item>
  <item>RFC-0661: added optional knowledge.budgets binding for hot/warm layer character budget overrides.</item>
  <item>RFC-0662: added optional knowledge.retentionDays and knowledge.staleDays bindings for compaction overrides.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { TERMINOLOGY_DEFAULTS } from "../profiles/profile-schema.ts";
import { listStackProfiles, type StackProfile } from "../profiles/stack-profile.ts";

// ---------------------------------------------------------------------------
// Bindings schema (forge/bindings@1) — RFC-0393
// ---------------------------------------------------------------------------

export const forgeBindingsSchema = z.object({
  schema: z.literal("forge/bindings@1"),
  commands: z.object({
    validateRfc: z.string().nullable().default(null),
    validateAdr: z.string().nullable().default(null),
    implementStamp: z.string().nullable().default(null),
    typecheck: z.string().nullable().default(null),
    test: z.string().nullable().default(null),
    scopedBuild: z.string().nullable().default(null),
    specValidate: z.string().nullable().default(null),
    sessionSave: z.string().nullable().default(null),
    // Semantic keys (RFC-0639) — domain-neutral, optional
    validate: z.string().nullable().default(null),
    produce: z.string().nullable().default(null),
    verify: z.string().nullable().default(null),
    preview: z.string().nullable().default(null),
    lint: z.string().nullable().default(null),
  }),
  paths: z.object({
    invariantsFile: z.string().nullable().default(null),
    compassDocs: z.array(z.string()).default([]),
    reviewsDir: z.string().nullable().default(null),
    handoffsDir: z.string().nullable().default(null),
    sessionsDir: z.string().nullable().default(null),
  }),
  terminology: z.record(z.string(), z.string()).default({}),
  compass: z
    .object({
      fileExtensions: z.array(z.string()).optional(),
      testPatterns: z.array(z.string()).optional(),
    })
    .optional(),
  // RFC-0661: optional knowledge layer character budget overrides
  // RFC-0662: optional retention/stale day overrides
  knowledge: z
    .object({
      budgets: z
        .object({
          hot: z.number().positive(),
          warm: z.number().positive(),
        })
        .optional(),
      retentionDays: z.number().positive().optional(),
      staleDays: z.number().positive().optional(),
    })
    .optional(),
  // RFC-0664: optional memory layer budget override (MEMORY.md hot store)
  memory: z
    .object({
      budget: z.number().int().positive().default(4096),
    })
    .optional(),
});

export interface ForgeBindings {
  schema: "forge/bindings@1";
  commands: {
    validateRfc: string | null;
    validateAdr: string | null;
    implementStamp: string | null;
    typecheck: string | null;
    test: string | null;
    scopedBuild: string | null;
    specValidate: string | null;
    sessionSave: string | null;
    // Semantic keys (RFC-0639) — domain-neutral, optional
    validate: string | null;
    produce: string | null;
    verify: string | null;
    preview: string | null;
    lint: string | null;
  };
  paths: {
    invariantsFile: string | null;
    compassDocs: string[];
    reviewsDir: string | null;
    handoffsDir: string | null;
    sessionsDir: string | null;
  };
  terminology: Record<string, string>;
  compass?: {
    fileExtensions?: string[];
    testPatterns?: string[];
  };
  // RFC-0661: optional knowledge layer character budget overrides
  // RFC-0662: optional retention/stale day overrides
  knowledge?: {
    budgets?: {
      hot: number;
      warm: number;
    };
    retentionDays?: number;
    staleDays?: number;
  };
  // RFC-0664: optional memory layer budget override (MEMORY.md hot store)
  memory?: {
    budget: number;
  };
}

// ---------------------------------------------------------------------------
// Skill packs schema (RFC-0539)
// ---------------------------------------------------------------------------

export const forgeSkillPackSchema = z.object({
  prefix: z
    .string()
    .regex(
      /^[a-z][a-z0-9]{1,7}$/,
      "prefix must be 2-8 chars: lowercase letter followed by lowercase alphanumeric",
    )
    .refine((v) => v !== "fo", "fo prefix is reserved for forge"),
  dir: z.string().min(1),
});

export interface ForgeSkillPack {
  prefix: string;
  dir: string;
}

// ---------------------------------------------------------------------------
// Migration adapters schema (RFC-0546)
// ---------------------------------------------------------------------------

export const forgeMigrationAdapterSchema = z.object({
  id: z.string().min(1),
  module: z.string().optional(),
});

export interface ForgeMigrationAdapter {
  id: string;
  module?: string;
}

// ---------------------------------------------------------------------------
// Schema (forge/config@1)
// ---------------------------------------------------------------------------

export const forgeConfigSchema = z.object({
  schema: z.literal("forge/config@1"),
  project: z.object({
    name: z.string().min(1),
    stack: z.array(z.string()).default([]),
    packageManager: z.enum(["pnpm", "npm", "yarn", "bun", "none"]).default("pnpm"),
    // RFC-0640: optional domain field — absent means software-domain fallback
    domain: z.string().optional(),
  }),
  paths: z.object({
    rfcsDir: z.string().default("docs/rfcs"),
    adrsDir: z.string().default("docs/adrs"),
    plansDir: z.string().default("docs/plans"),
    auditsDir: z.string().default("docs/audits"),
    specsDir: z.string().default("docs/specs"),
    skillsDir: z.string().default(".agents/skills"),
    sessionsDir: z.string().default("docs/sessions"),
  }),
  /** Bindings contract (RFC-0393). Optional — absent means no bindings. */
  bindings: forgeBindingsSchema.optional(),
  /** Skill packs (RFC-0539). Optional — absent means no project-local packs. */
  skillPacks: z.array(forgeSkillPackSchema).optional(),
  /** Migration adapters (RFC-0546). Optional — absent means built-in adapters only. */
  migrationAdapters: z.array(forgeMigrationAdapterSchema).optional(),
  /** Forge sync metadata (RFC-0543). Optional — absent means never synced. */
  forge: z
    .object({
      syncedVersion: z.string().nullable().default(null),
    })
    .optional(),
  /** RFC-0643: profile id — when present, loadForgeConfig loads the corresponding profiles/<id>.yaml */
  profile: z.string().optional(),
});

export interface ForgeConfig {
  schema: "forge/config@1";
  project: {
    name: string;
    stack: string[];
    packageManager: "pnpm" | "npm" | "yarn" | "bun" | "none";
    /** RFC-0640: optional domain field — absent means software-domain fallback */
    domain?: string;
  };
  paths: {
    rfcsDir: string;
    adrsDir: string;
    plansDir: string;
    auditsDir: string;
    specsDir: string;
    skillsDir: string;
    sessionsDir: string;
  };
  /** Bindings contract (RFC-0393). Optional — absent means no bindings. */
  bindings?: ForgeBindings;
  /** Skill packs (RFC-0539). Optional — absent means no project-local packs. */
  skillPacks?: ForgeSkillPack[];
  /** Migration adapters (RFC-0546). Optional — absent means built-in adapters only. */
  migrationAdapters?: ForgeMigrationAdapter[];
  /** Forge sync metadata (RFC-0543). Optional — absent means never synced. */
  forge?: { syncedVersion: string | null };
  /** RFC-0643: loaded stack profile — present when forge.yaml has a `profile` field */
  profile?: StackProfile;
}

// ---------------------------------------------------------------------------
// CLI binding defaults (RFC-0540)
// ---------------------------------------------------------------------------

export interface ForgeCliBindingDefault {
  key: string;
  template: string;
}

export const FORGE_CLI_BINDING_DEFAULTS: ForgeCliBindingDefault[] = [
  { key: "commands.validateRfc", template: "forge rfc.validate --id {id} --json" },
  { key: "commands.validateAdr", template: "forge adr.validate --id {id} --json" },
  {
    key: "commands.implementStamp",
    template: "forge rfc.implement.stamp --id {id} --implementation-commit {commit}",
  },
  { key: "commands.specValidate", template: "forge spec.validate --spec={id} --json" },
  { key: "commands.sessionSave", template: "forge session.save --json" },
];

export const PM_RUNNER_MAP: Record<string, string> = {
  pnpm: "pnpm exec",
  npm: "npx",
  yarn: "yarn exec",
  bun: "bunx",
  none: "npx",
};

export function resolvePmRunner(pm: string): string {
  return PM_RUNNER_MAP[pm] ?? "npx";
}

export function applyCliBindingDefaults(pm: string): ForgeBindings["commands"] {
  const runner = resolvePmRunner(pm);
  const commands: ForgeBindings["commands"] = {
    validateRfc: null,
    validateAdr: null,
    implementStamp: null,
    typecheck: null,
    test: null,
    scopedBuild: null,
    specValidate: null,
    sessionSave: null,
    // Semantic keys (RFC-0639) — stack-dependent, not CLI-backed
    validate: null,
    produce: null,
    verify: null,
    preview: null,
    lint: null,
  };
  for (const entry of FORGE_CLI_BINDING_DEFAULTS) {
    const bareKey = entry.key.replace("commands.", "") as keyof ForgeBindings["commands"];
    commands[bareKey] = `${runner} ${entry.template}`;
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export type ForgePackageManager = ForgeConfig["project"]["packageManager"];

const VALID_PACKAGE_MANAGERS: readonly string[] = ["pnpm", "npm", "yarn", "bun", "none"];

export function resolvePackageManager(pm: string): ForgePackageManager {
  return VALID_PACKAGE_MANAGERS.includes(pm) ? (pm as ForgePackageManager) : "pnpm";
}

export function defaultForgeConfig(projectName: string, packageManager?: string): ForgeConfig {
  const pm = resolvePackageManager(packageManager ?? "pnpm");
  return {
    schema: "forge/config@1",
    project: {
      name: projectName,
      stack: [],
      packageManager: pm,
    },
    paths: {
      rfcsDir: "docs/rfcs",
      adrsDir: "docs/adrs",
      plansDir: "docs/plans",
      auditsDir: "docs/audits",
      specsDir: "docs/specs",
      skillsDir: ".agents/skills",
      sessionsDir: "docs/sessions",
    },
    bindings: {
      schema: "forge/bindings@1",
      commands: applyCliBindingDefaults(pm),
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: "docs/reviews",
        handoffsDir: "docs/handoffs",
        sessionsDir: "docs/sessions",
      },
      terminology: {},
      compass: {},
    },
    forge: { syncedVersion: null },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadForgeConfig(workspaceRoot: string): ForgeConfig {
  const configPath = path.join(workspaceRoot, "forge.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `forge.yaml not found at ${configPath}. Run 'forge create' to create project configuration.`,
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`forge.yaml at ${configPath} is not valid YAML: ${(err as Error).message}`);
  }

  const result = forgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `forge.yaml at ${configPath} failed schema validation:\n${issues}\nFix the listed fields or run 'forge create' to regenerate defaults.`,
    );
  }

  const rawData = result.data as Record<string, unknown>;
  const profileId = rawData["profile"] as string | undefined;

  // RFC-0643: load stack profile when `profile` field is present in forge.yaml
  let loadedProfile: StackProfile | undefined;
  if (profileId) {
    try {
      const forgeRoot = resolveForgeRoot(workspaceRoot);
      const profiles = listStackProfiles(forgeRoot);
      loadedProfile = profiles.find((p) => p.id === profileId);
    } catch {
      // forge root not resolvable — profile not loaded
    }
  }

  const config = { ...rawData } as unknown as ForgeConfig;
  if (loadedProfile) {
    config.profile = loadedProfile;
  } else {
    delete config.profile;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Forge root resolver — the single place that decides monorepo vs npm-installed
// ---------------------------------------------------------------------------

export function resolveForgeRoot(workspaceRoot: string): string {
  const monorepoPath = path.join(workspaceRoot, "packages", "forge");
  if (fs.existsSync(path.join(monorepoPath, "package.json"))) {
    return monorepoPath;
  }

  const npmPath = path.join(workspaceRoot, "node_modules", "@warpgogol", "forge");
  if (fs.existsSync(path.join(npmPath, "package.json"))) {
    return npmPath;
  }

  throw new Error(
    `Could not resolve forge root. Checked:\n  ${monorepoPath}\n  ${npmPath}\nEnsure @warpgogol/forge is installed or packages/forge exists.`,
  );
}

// ---------------------------------------------------------------------------
// Binding resolver — RFC-0393
// ---------------------------------------------------------------------------

/**
 * Resolve a binding key (e.g. "commands.validateRfc") from the config.
 * Returns the resolved string/array, or null if the binding is absent or explicitly null.
 * Supports placeholder substitution: {id}, {workspace}, {file}.
 */
export function resolveBinding(
  config: ForgeConfig,
  key: string,
  placeholders?: Record<string, string>,
): string | string[] | null {
  if (!config.bindings) {
    return null;
  }

  const parts = key.split(".");
  let current: unknown = config.bindings;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === null || current === undefined) {
    return null;
  }

  if (Array.isArray(current)) {
    return current as string[];
  }

  if (typeof current === "string") {
    if (placeholders) {
      return substitutePlaceholders(current, placeholders);
    }
    return current;
  }

  return null;
}

function substitutePlaceholders(template: string, placeholders: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Terminology resolver — RFC-0639
// ---------------------------------------------------------------------------

/**
 * Resolve a terminology key using a three-tier chain:
 * 1. Per-project override in bindings.terminology
 * 2. Caller-provided terminology map (typically from profile.terminology, RFC-0638)
 * 3. Universal default from TERMINOLOGY_DEFAULTS (RFC-0638)
 *
 * If the key is not found in any tier, the key itself is returned.
 */
export function resolveTerminology(
  config: ForgeConfig,
  terminology: Record<string, string> | undefined,
  key: string,
): string {
  if (config.bindings?.terminology?.[key]) {
    return config.bindings.terminology[key];
  }
  if (terminology?.[key]) {
    return terminology[key];
  }
  return TERMINOLOGY_DEFAULTS[key] ?? key;
}
