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
  <item>RFC-1615: close RFC-1615 round-14 counterexamples — binding adds, base-side rfc namespace, governed acceptance provenance, unreadable listings</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r11 trust-boundary counterexamples

Independent clean-context verification (round 11, candidate 029219ca9)
returned REFUTED with seven live counterexamples against the
r10-remediated channel — this commit closes all of them.

- `.git/info/attributes` joins the shape-violation paths (CX-125): the
  r6 reasoning covered only program reach, but working-tree-encoding /
  text / eol / ident are built-in clean-side conversions that rewrite
  what the zero-stat index content-hash sees with no external program.
- Index-consulting classification is argv-exact (CX-126/127/128):
  isIndexConsultingRead replaces the token-counting isUnprovenIndexRead —
  ambiguous diff forms (a nonrev second positional is a pathspec, not a
  rev) refuse under an unproven index, describe --dirty/--broken are
  index-consuming, and grep is parsed option-aware so a worktree grep
  with no rev token refuses while `-e`/`-f` + rev tree greps proceed.
- The verifier claims index has no discoverable path (CX-129): a
  self-serialized DIRC v2 image lives in an anonymous O_TMPFILE inode
  opened on os.tmpdir(), handed to git as GIT_INDEX_FILE=/dev/fd/<n>
  through a freshly opened independent file description per spawn;
  the named flat-file fallback re-proves its bytes against the expected
  image before every spawn, and child descriptors close on every return
  path.
- `cat-file --batch` specs are sanitized (CX-130): runBatchBytes rejects
  empty specs and any spec containing \n/\r/\0 (and `:`-leading index
  specs under an unproven index), answering positional nulls so the
  record stream can never desynchronize spec attribution.
- Trusted transports refuse file-class targets and URL rewrites
  (CX-131): url.*.insteadOf / .pushInsteadOf are refused at preflight,
  and ls-remote/fetch spawn with protocol.file.allow=never so file:
  URLs and bare-path remotes fail honestly; the pin is transport-only
  so verifierScratchGit's judged `clone <path>` still works. Test
  origins moved from local path/file remotes to a loopback git daemon
  so fixtures keep exercising real fetch/ls-remote behavior.

The port commit that follows carries the ported cx11 probe file plus
the round-11 acceptance report.</item>
  <history>RFC-1578, RFC-1615</history>
</CHANGE_SUMMARY>
*/

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  forgeConfigSchema,
  loadForgeConfig,
  type ForgeConfig,
} from "../../src/config/forge-config.ts";
import { verifierGit } from "../../src/utils/verifier-git.ts";
import {
  CORRECTNESS_MODES,
  CORRECTNESS_TIERS,
  type CorrectnessMode,
  type CorrectnessTier,
} from "./manifest-schema.ts";

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

/**
 * Every workspace file (tracked + untracked-non-ignored), POSIX-relative,
 * sorted. The fs walk ignores .gitignore — a failed `git ls-files` WIDENS the
 * set with ignored files, and a caller judging coverage over it would read
 * fabricated anchors (CX-81): the fallback is disclosed via `onGitFailure`
 * so the gate can flag it like every other failed git read.
 */
export async function listWorkspaceFiles(
  workspaceRoot: string,
  onGitFailure?: (label: string) => void,
): Promise<string[]> {
  if (existsSync(path.join(workspaceRoot, ".git"))) {
    // verifierGit: ambient GIT_* selectors and a session-written
    // `.git/index` cannot redirect the cached set — the channel's
    // claims-rebuilt verifier index enumerates the staged claims plus
    // real untracked files (CX-121/CX-122/CX-129).
    const r = await verifierGit(
      workspaceRoot,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    if (r.exitCode === 0) {
      return [...new Set(r.stdout.split("\0").filter((f) => f.length > 0))]
        .filter((f) => existsSync(path.join(workspaceRoot, f)))
        .sort();
    }
    onGitFailure?.("ls-files --cached --others --exclude-standard");
    // fall through to the fs walk
  }
  const out: string[] = [];
  walk(workspaceRoot, "", out);
  return out.sort();
}
