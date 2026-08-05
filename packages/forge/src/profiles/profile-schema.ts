/*
<MODULE_CONTRACT>
<purpose>Domain-neutral profile schema extensions — optional fields that allow a stack profile to declare its domain model (terminology, artifacts, workspace types, invariants, register) without breaking backward compatibility.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not define enforcement logic for invariants — that lives in the invariant engine module.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0638: initial domain-neutral profile schema extensions with six optional fields.</item>
  <item>RFC-0674: add profileDevServerSchema and devServer field for lifecycle commands.</item>
  <item>RFC-0675: add profileInvariantCheckSchema and check field to profileInvariantSchema for enforcement.</item>
  <item>RFC-0679: add profileAssetSchema and assets field for asset management commands.</item>
  <item>RFC-0680: add profileReleaseSchema and release field for release lifecycle commands.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

// ---------------------------------------------------------------------------
// Universal terminology key catalog
// ---------------------------------------------------------------------------

export const UNIVERSAL_TERMINOLOGY_KEYS = [
  "artifact",
  "artifactPlural",
  "module",
  "source",
  "output",
  "verify",
  "operator",
] as const;

export const TERMINOLOGY_DEFAULTS: Record<string, string> = {
  artifact: "artifact",
  artifactPlural: "artifacts",
  module: "module",
  source: "source file",
  output: "output",
  verify: "verify",
  operator: "operator",
};

// ---------------------------------------------------------------------------
// Profile artifact schema
// ---------------------------------------------------------------------------

export const profileArtifactSchema = z.object({
  id: z.string().min(1),
  extensions: z.array(z.string().min(1)),
  produce: z
    .object({
      command: z.string().min(1),
      output: z.string().optional(),
    })
    .optional(),
  validate: z
    .object({
      command: z.string().min(1),
      outputFormat: z.enum(["plain", "json"]).optional(),
      violationPattern: z.string().optional(),
    })
    .optional(),
  determinism: z
    .object({
      hashable: z.boolean(),
      inputs: z.array(z.string()),
    })
    .optional(),
});

export interface ProfileArtifact {
  id: string;
  extensions: string[];
  produce?: {
    command: string;
    output?: string;
  };
  validate?: {
    command: string;
    outputFormat?: "plain" | "json";
    violationPattern?: string;
  };
  determinism?: {
    hashable: boolean;
    inputs: string[];
  };
}

// ---------------------------------------------------------------------------
// Profile workspace type schema
// ---------------------------------------------------------------------------

export const profileWorkspaceTypeSchema = z.object({
  id: z.string().min(1),
  detect: z.object({
    glob: z.string().optional(),
    contains: z.string().optional(),
    packageJsonDep: z.string().optional(),
  }),
  skills: z.array(z.string()).optional(),
  agentsMdTemplate: z.string().optional(),
});

export interface ProfileWorkspaceType {
  id: string;
  detect: {
    glob?: string;
    contains?: string;
    packageJsonDep?: string;
  };
  skills?: string[];
  agentsMdTemplate?: string;
}

// ---------------------------------------------------------------------------
// Profile invariant schema
// ---------------------------------------------------------------------------

export const profileInvariantCheckSchema = z
  .object({
    kind: z.enum([
      "filename-pattern",
      "file-contains",
      "file-not-contains",
      "html-attribute-pattern",
    ]),
    glob: z.string().optional(),
    pattern: z.string().optional(),
    negatedPattern: z.string().optional(),
    element: z.string().optional(),
    attribute: z.string().optional(),
  })
  .refine(
    (v) =>
      v.kind !== "html-attribute-pattern" ||
      (v.element != null && v.attribute != null && v.pattern != null),
    {
      message: "element, attribute, and pattern are required for kind: html-attribute-pattern",
    },
  );

export interface ProfileInvariantCheck {
  kind: "filename-pattern" | "file-contains" | "file-not-contains" | "html-attribute-pattern";
  glob?: string;
  pattern?: string;
  negatedPattern?: string;
  element?: string;
  attribute?: string;
}

export const profileInvariantSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Z]+-\d+$/, "Invariant id must match ^[A-Z]+-\\d+$ (e.g. VIDEO-01)"),
  rule: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  check: profileInvariantCheckSchema.optional(),
});

export interface ProfileInvariant {
  id: string;
  rule: string;
  severity: "error" | "warning";
  check?: ProfileInvariantCheck;
}

// ---------------------------------------------------------------------------
// Profile dev server schema (RFC-0674)
// ---------------------------------------------------------------------------

export const profileDevServerSchema = z.object({
  command: z.string().min(1),
  port: z.number().int().positive().optional(),
  readinessTimeout: z.number().int().positive().optional(),
});

export interface ProfileDevServer {
  command: string;
  port?: number;
  readinessTimeout?: number;
}

// ---------------------------------------------------------------------------
// Profile asset schema (RFC-0679)
// ---------------------------------------------------------------------------

export const profileAssetTypeSchema = z.object({
  id: z.string().min(1),
  extensions: z.array(z.string().min(1)),
  referencePattern: z.string().optional(),
});

export interface ProfileAssetType {
  id: string;
  extensions: string[];
  referencePattern?: string;
}

export const profileAssetSchema = z.object({
  dir: z.string().min(1),
  types: z.array(profileAssetTypeSchema),
});

export interface ProfileAsset {
  dir: string;
  types: ProfileAssetType[];
}

// ---------------------------------------------------------------------------
// Profile release schema (RFC-0680)
// ---------------------------------------------------------------------------

export const profileReleaseSchema = z.object({
  target: z.enum(["local", "r2", "s3"]),
  outputDir: z.string().min(1),
  manifestName: z.string().default("release-manifest.json"),
  includeArtifacts: z.array(z.string()).optional(),
  r2: z
    .object({
      bucket: z.string().min(1),
      accountId: z.string().min(1),
      prefix: z.string().default(""),
    })
    .optional(),
});

export interface ProfileRelease {
  target: "local" | "r2" | "s3";
  outputDir: string;
  manifestName: string;
  includeArtifacts?: string[];
  r2?: {
    bucket: string;
    accountId: string;
    prefix: string;
  };
}

// ---------------------------------------------------------------------------
// Stack profile domain fields
// ---------------------------------------------------------------------------

export const stackProfileDomainFieldsSchema = z.object({
  domain: z.string().optional(),
  terminology: z.record(z.string(), z.string()).optional(),
  artifacts: z.array(profileArtifactSchema).optional(),
  workspaceTypes: z.array(profileWorkspaceTypeSchema).optional(),
  invariants: z.array(profileInvariantSchema).optional(),
  register: z.enum(["business", "creative"]).optional(),
  devServer: profileDevServerSchema.optional(),
  assets: profileAssetSchema.optional(),
  release: profileReleaseSchema.optional(),
});

export interface StackProfileDomainFields {
  domain?: string;
  terminology?: Record<string, string>;
  artifacts?: ProfileArtifact[];
  workspaceTypes?: ProfileWorkspaceType[];
  invariants?: ProfileInvariant[];
  register?: "business" | "creative";
  devServer?: ProfileDevServer;
  assets?: ProfileAsset;
  release?: ProfileRelease;
}
