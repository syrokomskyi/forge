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
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
  <item>RFC-1615: round-7 — committed-side verdict inputs (CX-32/33) + every-contour inert-policy note (CX-34)</item>
  <item>RFC-1615: close RFC-1615 round-8 counterexamples (CX-35/36/37/38/39/41/46)

settingsFromForgeDoc replicates the zod schema verdict as configError so
a committed forge.yaml that parses but fails validation cannot mask the
CORR-01 the worktree flavor reports (CX-35). forgeYamlOnlyFrozenKeys
strips policy:/correctness in the null-policy branch too — a legal
policy: adoption inside an accepted-weakening session no longer makes
forge.yaml foreign (CX-36) — and canons non-map YAML instead of running
delete on a String index (CX-46). anchorWeakenings judges the HEAD
commit via git grep + repo.show — a committed reword masked by an
uncommitted revert still reports; an uncommitted reword never fabricates
(CX-37). The inert-policy note emits once above the exempt early return
(CX-38/CX-41). Non-finite oracleTimeoutMs falls back to the default —
Infinity overflowed setTimeout into a ~1ms fabricated CORR-GATE-07
(CX-39).</item>
  <item>RFC-1615: close RFC-1615 round-9 counterexamples (CX-47..55)

sideFrom filters compassDocs elements (CX-47 TypeError crash).
schemaProbe passes non-plain YAML types through and unwinds seen per
branch — tagged scalars no longer mask configError and DAG aliases no
longer fabricate it; a cyclic alias flags cyclic like the loader's
overflow would (CX-49/CX-50). oracleTimeoutMs must be finite within
[1, 2^31-1] — setTimeout clamps both Infinity and int32 overflow into a
~1ms fabricated kill, and a sub-ms value can never bound a run
(CX-48). The isolation strip drops the RFC-1580 frozen binding subkeys
in the declared-policy branch too — mutable:[bindings] no longer
dead-ends every checkRun rebind (CX-51). forge.yaml is excluded from
policyFiles and judged by the key strip alone — a freezeFiles glob
matching it neither voids mutable nor whitelists a non-isolated diff
(CX-52). A !-negation in manifest support: is malformed like a
freezeFiles negation (CX-53). modeWeakenings compares git ls-tree modes
— a blob-equal 100755->100644 chmod on a frozen file reports frozen-file
(CX-54). The inert-policy note no longer claims a malformed HEAD-adopted
policy binds the next integration (CX-55).</item>
  <item>RFC-1615: close RFC-1615 round-10 counterexamples (CX-56..60)</item>
  <history>RFC-1578</history>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  forgeConfigSchema,
  loadForgeConfig,
  type ForgeConfig,
} from "../../src/config/forge-config.ts";
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

/**
 * The same settings resolved from an already-parsed forge.yaml document —
 * the commit-side flavor used when the judged revision is `git show`, not
 * the worktree (RFC-1615 review CX-32/CX-33: an uncommitted `mode:`/`tier:`/
 * `oracleTimeoutMs` flip must neither mask a committed weakening nor
 * fabricate a failure). `config` is null — consumers needing the parsed
 * config read `forgeDoc` themselves.
 */
export function settingsFromForgeDoc(
  doc: Record<string, unknown>,
  forgeYamlUnreadable: boolean,
): CorrectnessSettings {
  const section = (doc["correctness"] ?? {}) as Record<string, unknown>;
  const bindings = (doc["bindings"] ?? {}) as {
    commands?: Record<string, unknown>;
    paths?: Record<string, unknown>;
  };
  const topPaths = (doc["paths"] ?? {}) as Record<string, unknown>;
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
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  // CX-35: replicate `loadForgeConfig`'s schema verdict — a committed
  // forge.yaml that parses but fails the zod schema must surface the same
  // configError CORR-01 keys on (BigInt leaves normalize to Number for the
  // schema probe only; cyclic aliases are tolerated).
  let configError: string | null = forgeYamlUnreadable
    ? "forge.yaml does not parse to a YAML map"
    : null;
  if (configError === null) {
    try {
      const probe = forgeConfigSchema.safeParse(schemaProbe(doc));
      if (!probe.success) configError = "forge.yaml failed schema validation";
    } catch {
      configError = "forge.yaml failed schema validation";
    }
  }
  return {
    config: null,
    configError,
    mode,
    tier,
    invalid,
    manifestPath: str(bindings.paths?.["correctnessManifest"]),
    checkRun: str(bindings.commands?.["checkRun"]),
    invariantsFile: str(bindings.paths?.["invariantsFile"]),
    compassDocs: Array.isArray(bindings.paths?.["compassDocs"])
      ? (bindings.paths["compassDocs"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [],
    rfcsDir: str(topPaths["rfcsDir"]) ?? "docs/rfcs",
  };
}

/**
 * Structural clone for the schema probe: BigInt leaves become Number (zod
 * `.number()` rejects them — the plain parse produces a JS number there).
 * Non-plain objects (Date/Map/Set from `!!timestamp`/`!!omap`) pass through
 * unchanged, and the clone preserves alias structure — DAG shares AND true
 * cycles — via the `clones` map, so `safeParse` judges the same shape the
 * loader's plain parse produces (CX-49/CX-50/CX-58). A cyclic field zod
 * actually descends into stack-overflows exactly like the loader — the
 * catch maps it to configError either way.
 */
function schemaProbe(value: unknown, clones: Map<object, unknown> = new Map()): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object") return value;
  if (clones.has(value)) return clones.get(value);
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    clones.set(value, arr);
    for (const v of value) arr.push(schemaProbe(v, clones));
    return arr;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const rec: Record<string, unknown> = {};
  clones.set(value, rec);
  for (const [k, v] of Object.entries(value)) rec[k] = schemaProbe(v, clones);
  return rec;
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
