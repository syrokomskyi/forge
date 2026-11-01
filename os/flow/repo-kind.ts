/*
<MODULE_CONTRACT>
<purpose>Repository-kind detection for the fixed branch model (RFC-1486) —
classifies a repository as governed (forge.yaml, no marker), exempt
(forge.generated.yaml carrying the forge/generated@1 schema) or ungoverned.
Generated repositories are never blocked by the guard or by flow.check.</purpose>
<non-goals>
  <item>No flow.check rule evaluation — handlers turn detection results into diagnostics.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A marker that fails the schema is a structured error (FLOW-05 material), never an exemption — implicit exemption by malformed file would silently unprotect a governed repo.</item>
  <item>Bare repositories read root files via `git show HEAD:<name>` — they carry no working tree.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 1 — fixed branch-model grammar, marker detection contracts, git helpers</item>
  <item>RFC-1486: step 1 — branch grammar, marker detection, git helpers</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { parse as yamlParse } from "yaml";
import { z } from "zod";

import type { WorkspaceIO } from "../../src/types.ts";

export const GENERATED_MARKER_FILE = "forge.generated.yaml";
export const FORGE_CONFIG_FILE = "forge.yaml";

export const generatedMarkerSchema = z
  .object({
    schema: z.literal("forge/generated@1"),
    generator: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();
export type GeneratedMarker = z.infer<typeof generatedMarkerSchema>;

export type RepoKind =
  | { kind: "governed" } // forge.yaml present, no marker
  | { kind: "exempt"; marker: GeneratedMarker }
  | { kind: "ungoverned" }; // no forge.yaml

export type RepoKindDetection =
  | { ok: true; repoKind: RepoKind }
  /** The marker exists but fails forge/generated@1 — FLOW-05 material. */
  | { ok: false; reason: "invalid-marker"; detail: string };

/**
 * Detect the repository kind from committed/working state only (DNA-105) —
 * the working-tree marker for non-bare repositories, `HEAD:<file>` for bare
 * ones. Never consults process-global state.
 */
export async function detectRepoKind(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<RepoKindDetection> {
  const bare = await isBareRepo(repoRoot, io);
  const markerText = await readRepoRootFile(repoRoot, GENERATED_MARKER_FILE, io, bare);
  if (markerText !== null) {
    let markerData: unknown;
    try {
      markerData = yamlParse(markerText);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid-marker",
        detail: `${GENERATED_MARKER_FILE} is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const parsed = generatedMarkerSchema.safeParse(markerData);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid-marker",
        detail: `${GENERATED_MARKER_FILE} fails the forge/generated@1 schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      };
    }
    return { ok: true, repoKind: { kind: "exempt", marker: parsed.data } };
  }
  const forgeConfig = await readRepoRootFile(repoRoot, FORGE_CONFIG_FILE, io, bare);
  return {
    ok: true,
    repoKind: forgeConfig !== null ? { kind: "governed" } : { kind: "ungoverned" },
  };
}

async function isBareRepo(repoRoot: string, io: WorkspaceIO): Promise<boolean> {
  const result = await io.exec("git", ["-C", repoRoot, "rev-parse", "--is-bare-repository"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * Read a file at the repository top level: from the working tree for non-bare
 * repositories, from `git show HEAD:<name>` for bare ones. Returns null when
 * the file does not exist.
 */
async function readRepoRootFile(
  repoRoot: string,
  name: string,
  io: WorkspaceIO,
  bare: boolean,
): Promise<string | null> {
  if (bare) {
    const result = await io.exec("git", ["-C", repoRoot, "show", `HEAD:${name}`]);
    return result.exitCode === 0 ? result.stdout : null;
  }
  const path = join(repoRoot, name);
  return (await io.exists(path)) ? io.readFile(path) : null;
}
