/*
<MODULE_CONTRACT>
<purpose>RFC-1578: workspace inputs of the correctness manifest validator —
forge.yaml correctness settings (raw, so invalid values surface as CORR-02),
the workspace file list (git tracked + untracked-non-ignored, fs walk
fallback), and path normalization shared by every reference comparison.</purpose>
<non-goals>
  <item>Do not evaluate rules — handlers/validate.ts owns CORR-* decisions.</item>
  <item>Do not write anything — read-only helpers.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial workspace helpers for correctness.manifest.validate.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { loadForgeConfig, type ForgeConfig } from "../../src/config/forge-config.ts";
import {
  CORRECTNESS_MODES,
  CORRECTNESS_TIERS,
  type CorrectnessMode,
  type CorrectnessTier,
} from "./manifest-schema.ts";

const execFileAsync = promisify(execFile);

export interface CorrectnessSettings {
  /** null when forge.yaml is absent or unreadable. */
  config: ForgeConfig | null;
  configError: string | null;
  mode: CorrectnessMode;
  tier: CorrectnessTier;
  /** Raw values that failed the closed sets (CORR-02 inputs). */
  invalid: { key: "mode" | "tier"; value: unknown }[];
  manifestPath: string | null;
  checkRun: string | null;
  invariantsFile: string | null;
  compassDocs: string[];
  rfcsDir: string;
}

/** Resolve the correctness settings of a workspace; never throws. */
export function readCorrectnessSettings(workspaceRoot: string): CorrectnessSettings {
  let config: ForgeConfig | null = null;
  let configError: string | null = null;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  const section = (config?.correctness ?? {}) as Record<string, unknown>;
  const invalid: CorrectnessSettings["invalid"] = [];
  const rawMode = section["mode"];
  const rawTier = section["tier"];
  let mode: CorrectnessMode = "warn";
  let tier: CorrectnessTier = "standard";
  if (rawMode !== undefined) {
    if (CORRECTNESS_MODES.includes(rawMode as CorrectnessMode)) mode = rawMode as CorrectnessMode;
    else invalid.push({ key: "mode", value: rawMode });
  }
  if (rawTier !== undefined) {
    if (CORRECTNESS_TIERS.includes(rawTier as CorrectnessTier)) tier = rawTier as CorrectnessTier;
    else invalid.push({ key: "tier", value: rawTier });
  }
  return {
    config,
    configError,
    mode,
    tier,
    invalid,
    manifestPath: config?.bindings?.paths?.correctnessManifest ?? null,
    checkRun: config?.bindings?.commands?.checkRun ?? null,
    invariantsFile: config?.bindings?.paths?.invariantsFile ?? null,
    compassDocs: config?.bindings?.paths?.compassDocs ?? [],
    rfcsDir: config?.paths?.rfcsDir ?? "docs/rfcs",
  };
}

/** Workspace-relative POSIX form of a path (`./a\\b` → `a/b`). */
export function normalizeRelPath(p: string): string {
  const posix = p.replace(/\\/g, "/").trim();
  return path.posix
    .normalize(posix)
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
}

/**
 * Normalize an RFC-1390 binding reference (`kind:target`) so the manifest
 * and the `checked-by` binding compare equal regardless of path spelling.
 * Path-bearing kinds (`test`, `type`, `proof`) normalize their target; `lint` trims.
 */
export function normalizeCheckRef(ref: string): string {
  const idx = ref.indexOf(":");
  if (idx === -1) return ref.trim();
  const kind = ref.slice(0, idx).trim();
  const target = ref.slice(idx + 1).trim();
  if (kind === "test" || kind === "type" || kind === "proof") {
    return `${kind}:${normalizeRelPath(target)}`;
  }
  return `${kind}:${target}`;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  ".astro",
  ".wrangler",
  ".cache",
]);

function walk(root: string, rel: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(path.join(root, rel));
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    let isDir = false;
    try {
      isDir = statSync(path.join(root, childRel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(root, childRel, out);
    else out.push(childRel);
  }
}

/** Every workspace file (tracked + untracked-non-ignored), POSIX-relative, sorted. */
export async function listWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  if (existsSync(path.join(workspaceRoot, ".git"))) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: workspaceRoot, maxBuffer: 256 * 1024 * 1024 },
      );
      const files = [...new Set(stdout.split("\0").filter((f) => f.length > 0))]
        .filter((f) => existsSync(path.join(workspaceRoot, f)))
        .sort();
      return files;
    } catch {
      // fall through to the fs walk
    }
  }
  const out: string[] = [];
  walk(workspaceRoot, "", out);
  return out.sort();
}
