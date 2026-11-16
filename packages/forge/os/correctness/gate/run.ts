/*
<MODULE_CONTRACT>
<purpose>RFC-1580 `correctness.gate` pipeline — (1) validate the manifest at
HEAD (RFC-1578), (2) weakening diff against the frozen set at `--base`,
(3) oracle origin, (4) tier, (5) run non-self oracles through the frozen
`checkRun`, (6) substrate attestation, (7) anchor events, (8) coverage,
(9) bundle, (10) verdict: enforce refuses on any error; warn downgrades
CORR-GATE-03..08; CORR-GATE-02 refuses in both modes unless an isolated
weakening session is accepted.</purpose>
<non-goals>
  <item>Never runs in-process inside flow.integrate — the primary install spawns it.</item>
  <item>No writes except the bundle under the git common dir.</item>
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
  <item>RFC-1615: close RFC-1615 round-11 counterexamples (CX-61..67)</item>
  <item>RFC-1615: close RFC-1615 round-12 counterexamples (CX-68..72)</item>
  <item>RFC-1615: close RFC-1615 round-14 counterexamples — binding adds, base-side rfc namespace, governed acceptance provenance, unreadable listings</item>
  <history>RFC-1580, RFC-1615</history>
</CHANGE_SUMMARY>
*/

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import path from "node:path";

import {
  ANCHOR_EVENTS_FILE,
  ATTESTATION_FILE,
  CAPTURES_FILE,
  type AnchorEventResult,
  type SubstrateAttestation,
} from "../../../src/correctness/index.ts";
import { schemaHashOf } from "../../../src/correctness/schema-hash.ts";
import { closeSchemas, discoverSchemas } from "../audit/schema-db.ts";
import { loadSnapshot } from "../audit/snapshot.ts";
import { declaredWriters } from "../audit/state-transitions-coverage.ts";
import { evaluateCapture, validateCorrectnessManifest } from "../handlers/validate.ts";
import { SEAM_MINIMUM, substrateRank, type Substrate } from "../manifest-schema.ts";
import { normalizeRelPath, settingsFromForgeDoc } from "../workspace.ts";
import {
  anchorWeakenings,
  byteWeakenings,
  canon,
  diffWeakenings,
  modeWeakenings,
  policyFileAdditions,
  policyWeakenings,
  readFrozenSet,
  sideFrom,
  supportAdditions,
} from "./frozen.ts";
import { deriveOrigin, readReviewRecords } from "./origin.ts";
import { checkTarget, GateRepo, sha256 } from "./repo.ts";
import { runOracle } from "./runner.ts";
import {
  BUNDLE_LIMITATIONS,
  CORRECTNESS_BUNDLE_SCHEMA,
  DEFAULT_ORACLE_REVIEWS_DIR,
  DEFAULT_ORACLE_TIMEOUT_MS,
  type BundleEntry,
  type BundleOracle,
  type CorrectnessBundle,
  type CorrectnessGateResult,
  type GateRuleId,
  type GateViolation,
  type Weakening,
} from "./types.ts";

export interface GateOptions {
  base: string;
  acceptWeakening?: string;
  /** Override the bundle directory (tests); default `<git-common-dir>/forge/gate-reports`. */
  bundleDir?: string;
  /** Proof checker for `tier: formal` (`proof:` oracles); default: forge proof.check in-process. */
  proveSpec?: (specRel: string) => Promise<"proved" | string>;
  /** Forge version recorded in the bundle. */
  forgeVersion?: string;
  forgePath?: string;
  /**
   * RFC-1615: judge only the declared policy surface (policy-key/policy-decl/
   * policy-file weakenings) — the cheap mode CI runs on forge.yaml and frozen
   * file diffs without loading the manifest or running oracles.
   */
  policyOnly?: boolean;
}

export type GateOutcome =
  | { ok: true; result: CorrectnessGateResult; bundle: CorrectnessBundle }
  | { ok: false; usageError: string };

const DOWNGRADE_IN_WARN: ReadonlySet<GateRuleId> = new Set([
  "CORR-GATE-03",
  "CORR-GATE-04",
  "CORR-GATE-05",
  "CORR-GATE-06",
  "CORR-GATE-07",
  "CORR-GATE-08",
]);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function defaultProve(root: string, specRel: string): Promise<string> {
  const { runProofCheckCommand } = await import("../../formal/handlers/proof-check.ts");
  const res = await runProofCheckCommand(
    { argv: [], flags: { spec: specRel } },
    {
      workspaceRoot: root,
      dryRun: false,
      outputFormat: "json",
      logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
    },
  );
  const verdict = (res.data?.verdict as { verdict?: string } | null)?.verdict;
  return verdict ?? "error";
}

/**
 * True when forge.yaml differs between base and head only in the frozen
 * correctness/policy keys. RFC-1615: the comparison keeps only the declared
 * `mutable`/`additive` top-level keys (minus the individually frozen binding
 * subkeys) — every other top-level key is frozen by the policy surface, so a
 * diff there is exactly what an isolated weakening session looks like.
 */
async function forgeYamlOnlyFrozenKeys(
  repo: GateRepo,
  base: string,
  head: string,
  policy: { mutable: string[]; additive: string[] } | null,
): Promise<boolean> {
  const strip = (text: string | null): string => {
    let parsed: unknown;
    try {
      parsed = text === null ? {} : parseYaml(text, { intAsBigInt: true });
    } catch {
      return "\0unparseable";
    }
    // A scalar/array forge.yaml carries no keys to strip — canon the value
    // as-is. The unreadable-side check already refused it (CX-46: `delete`
    // on a String index throws TypeError — never reach the key loop).
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return canon(parsed);
    // structuredClone preserves BigInt leaves (intAsBigInt parse) and anchor
    // cycles — JSON.stringify crashes on both (RFC-1615 review CX-27/CX-28).
    const copy = structuredClone(parsed) as Record<string, unknown>;
    if (policy === null) {
      // No declared policy: keep the RFC-1580 semantics — only the frozen
      // correctness keys are stripped, everything else must match. `policy:`
      // drops too — adopting a policy surface is the opt-in the diff itself
      // declares, not a foreign-path change (RFC-1615 review CX-36).
      delete copy["policy"];
      delete copy["correctness"];
      const b = copy["bindings"] as
        { commands?: Record<string, unknown>; paths?: Record<string, unknown> } | undefined;
      if (b?.commands) delete b.commands["checkRun"];
      if (b?.paths) {
        delete b.paths["correctnessManifest"];
        delete b.paths["oracleReviewsDir"];
      }
    } else {
      // RFC-1615 (CX-10): only `mutable` keys participate — everything else is
      // either frozen (diff = the weakening being accepted) or additive (any
      // weakening inside it is reported and covered by the same accept).
      // `policy:`/`correctness` are self-frozen regardless of a meaningless
      // `mutable` membership — their diffs are their own weakening kinds and
      // must never make the file foreign (RFC-1615 review CX-24).
      for (const key of Object.keys(copy)) {
        if (!policy.mutable.includes(key)) delete copy[key];
      }
      delete copy["policy"];
      delete copy["correctness"];
      // The RFC-1580 frozen binding subkeys stay frozen even when `bindings`
      // itself is declared mutable — their diff is a real weakening kind, so
      // strip them or every checkRun/manifest rebind dead-ends as
      // `mixed-weakening` (RFC-1615 review CX-51).
      const b = copy["bindings"] as
        { commands?: Record<string, unknown>; paths?: Record<string, unknown> } | undefined;
      if (b?.commands) delete b.commands["checkRun"];
      if (b?.paths) {
        delete b.paths["correctnessManifest"];
        delete b.paths["oracleReviewsDir"];
      }
    }
    return canon(copy);
  };
  return strip(await repo.show(base, "forge.yaml")) === strip(await repo.show(head, "forge.yaml"));
}

export async function runCorrectnessGate(root: string, options: GateOptions): Promise<GateOutcome> {
  const repo = new GateRepo(root);
  const base = await repo.revParse(options.base);
  if (!base)
    return { ok: false, usageError: `--base ${options.base} does not resolve to a commit` };
  const head = (await repo.revParse("HEAD")) ?? "HEAD";
  const violations: GateViolation[] = [];
  const add = (rule: GateRuleId, message: string, extra: { entry?: string; check?: string } = {}) =>
    violations.push({ rule, severity: "error", message, ...extra });

  // The gate runs oracles on the working tree but derives origin from HEAD.
  const statusOut = await repo.git.run(["status", "--porcelain", "--untracked-files=no"]);
  if (statusOut === null) {
    // A failed status read is not a clean tree — the dirtiness verdict could
    // not be verified, so the read joins the fail-closed set (CX-66).
    repo.unreadableReads.push("git status");
  }
  // Hoisted out of `finish` — the unreadable-reads verdict emits before any
  // finish() call, so a failure here must flag early to count.
  const branchOut = await repo.git.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  // Detached HEAD legitimately resolves to "HEAD" — a null read is a real
  // failure, not a detached checkout.
  if (branchOut === null) repo.unreadableReads.push("rev-parse --abbrev-ref HEAD");
  const dirty = statusOut?.trim() ?? "";
  if (dirty.length > 0) {
    violations.push({
      rule: "CORR-GATE-01",
      severity: "warning",
      message:
        "the session worktree has uncommitted tracked changes — oracles ran on the working tree while origins were derived from HEAD",
    });
  }

  // (1) Frozen set + judged HEAD side FIRST — every verdict input derives
  // from commits (CX-16/17/30..33): the worktree is the oracle-run surface
  // only. `now` must precede validation so the manifest validator can be
  // handed the committed config snapshot instead of the worktree's.
  const frozen = await readFrozenSet(repo, base);
  const headForgeYaml = await repo.show(head, "forge.yaml");
  const headManifestPath = sideFrom(headForgeYaml, () => null).manifestPath;
  const headManifestText = headManifestPath
    ? await repo.show(head, normalizeRelPath(headManifestPath))
    : null;
  const now = sideFrom(headForgeYaml, () => headManifestText);

  // (2) Validate at HEAD — committed flavor: mode/tier/binding checks and
  // every injected violation judge the committed forge.yaml, so an
  // uncommitted `mode:`/`tier:`/`oracleTimeoutMs` flip can neither mask a
  // committed weakening nor fabricate a failure. Manifest CONTENT is still
  // read from the worktree — the same deliberate flavor as the oracle runs
  // (disclosed by the dirty warning above).
  const committedSettings = settingsFromForgeDoc(now.forgeDoc, now.forgeYamlUnreadable);
  const validation = await validateCorrectnessManifest(root, {
    settings: committedSettings,
    onGitFailure: (label) => repo.unreadableReads.push(`git ${label}`),
  });
  // The RFC namespace resolves at the integration base under the BASE-side
  // binding — a HEAD rebind must not redirect `rfc-ac` refs at a planted dir
  // (CX-78). The rebind itself is judged as a binding weakening.
  const baseRfcsDir = settingsFromForgeDoc(
    frozen.base.forgeDoc,
    frozen.base.forgeYamlUnreadable,
  ).rfcsDir;
  const mode = validation.mode;
  const projectName = (now.forgeDoc["project"] as { name?: unknown } | undefined)?.name;
  const bundleBase = {
    schema: CORRECTNESS_BUNDLE_SCHEMA,
    repository: typeof projectName === "string" ? projectName : path.basename(root),
    base,
    head,
    mode,
    tier: validation.tier,
    gateBuild: {
      forge: options.forgeVersion ?? "unknown",
      path: options.forgePath ?? "$FLOW_PRIMARY/node_modules/.bin/forge",
    },
    limitations: BUNDLE_LIMITATIONS,
  };
  const finish = async (
    status: CorrectnessGateResult["status"],
    entries: BundleEntry[],
    weakenings: (Weakening & { accepted: boolean })[],
    accepted: string | null,
  ): Promise<GateOutcome> => {
    // commonDir's own read can flag — resolve it before the late check so the
    // flag counts (CX-69).
    const gitCommon = await repo.commonDir();
    // Reads still flag after the early CORR-GATE-01 emit — oracle origin
    // derivation, review-record listings, commonDir — a late failure is
    // surfaced and re-judges the verdict here (CX-69).
    if (repo.unreadableReads.length > 0) {
      if (!violations.some((v) => v.message.includes("a git read failed"))) {
        violations.push({
          rule: "CORR-GATE-01",
          severity: "error",
          message: `a git read failed (${repo.unreadableReads.slice(0, 3).join(", ")}${repo.unreadableReads.length > 3 ? " …" : ""}) — the weakening judgement is incomplete; refusing (fail closed)`,
        });
      }
      if (status !== "fail") status = "fail";
    }
    const bundle: CorrectnessBundle = {
      ...bundleBase,
      entries,
      weakenings,
      violations,
      ...(repo.unreadableReads.length > 0 ? { unreadableReads: [...repo.unreadableReads] } : {}),
    };
    // A linked worktree's `.git` is a FILE — never mkdir under it (ENOTDIR);
    // when the common dir is unreadable the bundle lands in tmp instead.
    const dotGit = path.join(root, ".git");
    const dir =
      options.bundleDir ??
      path.join(
        gitCommon ??
          (existsSync(dotGit) && statSync(dotGit).isDirectory()
            ? dotGit
            : mkdtempSync(path.join(os.tmpdir(), "forge-gate-"))),
        "forge",
        "gate-reports",
      );
    mkdirSync(dir, { recursive: true });
    // RFC-1532 naming (`<branch>-<ts>…json`) so the gate-report retention pruner covers bundles.
    const branch = (branchOut?.trim() || "detached").replace(/[^A-Za-z0-9._-]+/g, "-");
    const runId = `${branch}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${process.pid}`;
    const bundlePath = path.join(dir, `${runId}.correctness.json`);
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    return {
      ok: true,
      bundle,
      result: {
        command: "correctness.gate",
        mode,
        status,
        bundlePath,
        violations,
        weakenings,
        acceptedWeakening: accepted,
      },
    };
  };
  // (2) Frozen set first: `mode: exempt` ends the gate only when the base was
  // exempt too — a session cannot exempt itself (that is a CORR-GATE-02).
  // A *declared* `policy:` is a separate opt-in (RFC-1615 review CX-29): an
  // exempt×exempt contour still judges the policy surface, or a session could
  // weaken it unjudged and launder the diff under the exempt umbrella.
  //
  // Both contour legs are judged from COMMITS (CX-30/CX-31): the HEAD side is
  // computed above so a HEAD-adopted malformed `policy:` refuses CORR-GATE-01
  // on any contour, and an uncommitted worktree `mode:` flip can neither mask
  // a committed weakening nor fabricate a failure.
  const exemptContour = frozen.base.mode === "exempt" && now.mode === "exempt";
  // RFC-1615 (CX-34/CX-41): the inert-policy note rides EVERY contour —
  // including the pure-exempt early return — a no-policy repo's bundle must
  // disclose that the policy checks never armed.
  if (frozen.base.policy === null && !frozen.base.policyMalformed) {
    violations.push({
      rule: "CORR-GATE-01",
      severity: "warning",
      message:
        now.policy === null && !now.policyMalformed
          ? "no policy surface declared — policy checks inert (adopt policy: to arm them)"
          : now.policyMalformed
            ? "no policy surface declared at --base — policy checks inert for this diff; the HEAD-adopted policy: is malformed and refuses CORR-GATE-01"
            : "no policy surface declared at --base — policy checks inert for this diff; the HEAD-adopted policy: binds the next integration",
    });
  }
  if (
    exemptContour &&
    frozen.base.policy === null &&
    !frozen.base.policyMalformed &&
    now.policy === null &&
    !now.policyMalformed
  )
    return finish("exempt", [], [], null);
  // Manifest-validation violations judge committed-mode semantics — they
  // stay silent on --policy-only and on the exempt contour, which reports
  // the policy surface only (CX-29/CX-33).
  for (const v of validation.violations) {
    if (v.severity === "error" && !options.policyOnly && !exemptContour)
      add("CORR-GATE-01", `${v.rule}${v.entry ? ` ${v.entry}` : ""}: ${v.message}`);
  }
  if (!now.manifestPath && !options.policyOnly) {
    violations.push({
      rule: "CORR-GATE-01",
      severity: "warning",
      message: "no correctness manifest bound — the gate checks only weakenings",
    });
  }

  // Weakening diff against the frozen set.
  const readWorking = (rel: string): string | null => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  // RFC-1615: a forge.yaml that exists but is not a readable YAML map cannot
  // be judged — refuse structured, never crash or silently inert (CX-15/CX-19).
  if (frozen.base.forgeYamlUnreadable || now.forgeYamlUnreadable) {
    add(
      "CORR-GATE-01",
      `forge.yaml ${frozen.base.forgeYamlUnreadable ? "at --base" : "at HEAD"} does not parse to a YAML map — the policy surface cannot be read (fail closed)`,
    );
  }
  // RFC-1615: a malformed policy: declaration cannot be honoured — refuse as
  // CORR-GATE-01 (invalid configuration at HEAD), in both modes.
  if (now.policyMalformed || frozen.base.policyMalformed) {
    add(
      "CORR-GATE-01",
      `the policy: declaration ${frozen.base.policyMalformed ? "at --base" : "at HEAD"} is malformed — expected { mutable?: string[], additive?: string[], freezeFiles?: string[] }`,
    );
  }
  // A `!`-negation in base manifest `support:` would silently freeze the
  // complement — same refusal class as a malformed `policy:` (CX-53).
  if (frozen.supportMalformed) {
    add(
      "CORR-GATE-01",
      `the base manifest ${frozen.base.manifestPath} support: glob uses a \`!\` negation — negation silently freezes the complement; rename the glob to what it must cover`,
    );
  }
  if (frozen.baseManifestUnreadable && !options.policyOnly) {
    add(
      "CORR-GATE-02",
      `the base manifest ${frozen.base.manifestPath} does not parse with this forge — the frozen set cannot be read; integrate with a forge that reads it`,
    );
  }
  // The changed-paths diff is computed once — git skips identical subtrees,
  // so a corrupt off-path tree object does not blind it the way `ls-tree -r`
  // enumeration is blinded (CX-59). Glob-frozen members lost to a failed
  // enumeration are recovered from it below.
  const changed = await repo.changedPaths(base, head);
  // CX-59: a changed path matching a frozen glob that existed at base is an
  // edit of a glob-frozen file — judgeable via path-scoped blob reads even
  // when the full-tree enumeration failed.
  const globExtraChanged = async (
    globs: string[],
    listed: readonly string[],
  ): Promise<string[]> => {
    if (globs.length === 0) return [];
    const known = new Set(listed);
    const matchers = globs.map((g) => picomatch(normalizeRelPath(g), { dot: true }));
    const out: string[] = [];
    for (const rel of changed) {
      if (known.has(rel) || !matchers.some((m) => m(rel))) continue;
      if ((await repo.blob(base, rel)) !== null) out.push(rel);
    }
    return out;
  };
  const supportExtra = await globExtraChanged(frozen.supportGlobs, frozen.files);
  // forge.yaml is never a byte-frozen POLICY file — the same exclusion the
  // enumerated path applies (CX-52), or `*.yaml`/`x/../forge.yaml` globs
  // would smuggle it into policy-file reporting through the diff fallback.
  const policyExtra = (await globExtraChanged(frozen.policyGlobs, frozen.policyFiles)).filter(
    (rel) => rel !== "forge.yaml",
  );
  const frozenFiles = [...frozen.files, ...supportExtra];
  const frozenPolicyFiles = [...frozen.policyFiles, ...policyExtra];
  const weakenings: Weakening[] =
    options.policyOnly || exemptContour
      ? [
          // RFC-1615 --policy-only / exempt-contour: the declared policy
          // surface, nothing else (CX-29 — policy: is its own opt-in).
          ...policyWeakenings(frozen, now),
          ...(await byteWeakenings(repo, base, head, frozenPolicyFiles, "policy-file")),
          ...(await modeWeakenings(repo, base, head, frozenPolicyFiles)),
          ...(await policyFileAdditions(repo, base, head, frozen, changed)),
        ]
      : [
          ...diffWeakenings(frozen, now),
          ...(await byteWeakenings(repo, base, head, frozenFiles)),
          ...(await modeWeakenings(repo, base, head, frozenFiles)),
          ...(await supportAdditions(repo, base, head, frozen, changed)),
          ...(await anchorWeakenings(repo, head, frozen, changed)),
          // RFC-1615: the declared policy surface is judged in the same gate run.
          ...policyWeakenings(frozen, now),
          ...(await byteWeakenings(repo, base, head, frozenPolicyFiles, "policy-file")),
          ...(await modeWeakenings(repo, base, head, frozenPolicyFiles)),
          ...(await policyFileAdditions(repo, base, head, frozen, changed)),
        ];
  let acceptedReason: string | null = null;
  if (weakenings.length > 0) {
    const reason = options.acceptWeakening?.trim();
    if (reason) {
      const forgeYamlIsolated = await forgeYamlOnlyFrozenKeys(repo, base, head, frozen.base.policy);
      // In --policy-only the weakening list never contains RFC-1580 kinds, so
      // the accept path must whitelist only the paths it actually reported —
      // oracle/manifest paths stay foreign here (they'd be accepted silently).
      const policyScope = options.policyOnly || exemptContour;
      const frozenPaths = new Set([
        ...(policyScope ? [] : frozen.files),
        ...(policyScope ? [] : frozen.anchorFiles),
        ...frozen.policyFiles,
        ...(forgeYamlIsolated ? ["forge.yaml"] : []),
        ...(policyScope
          ? []
          : [frozen.base.manifestPath, now.manifestPath]
              .filter((p): p is string => !!p)
              .map(normalizeRelPath)),
      ]);
      // Additions inside a frozen glob (support glob or policy.freezeFiles)
      // are themselves the reported weakenings being accepted — they count as
      // frozen-set paths even though the base set cannot contain them yet
      // (RFC-1615 review CX-11).
      const frozenGlobs = [...(policyScope ? [] : frozen.supportGlobs), ...frozen.policyGlobs].map(
        (g) => picomatch(normalizeRelPath(g), { dot: true }),
      );
      const foreign = changed.filter((p) =>
        // forge.yaml's isolation is judged by the key-strip alone — a
        // `freezeFiles` glob that happens to match it (*.yaml) must not
        // whitelist a non-isolated diff (RFC-1615 review CX-52).
        p === "forge.yaml"
          ? !forgeYamlIsolated
          : !frozenPaths.has(p) && !frozenGlobs.some((m) => m(p)),
      );
      // An accept granted on an unreadable diff would launder foreign files
      // (CX-60) — a failed listing read means the isolation verdict cannot be
      // proven, which is refused with the same mixed-weakening class.
      if (foreign.length === 0 && repo.unreadableReads.length === 0) {
        acceptedReason = reason;
      } else {
        add(
          "CORR-GATE-02",
          repo.unreadableReads.length > 0
            ? `mixed-weakening: a git read failed (${repo.unreadableReads.slice(0, 3).join(", ")}${repo.unreadableReads.length > 3 ? " …" : ""}) — --accept-weakening cannot prove the diff is isolated`
            : `mixed-weakening: --accept-weakening needs a session whose diff touches frozen-set paths only; also changed: ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? " …" : ""}`,
        );
      }
    }
    if (acceptedReason === null)
      for (const w of weakenings) add("CORR-GATE-02", `weakening (${w.kind}): ${w.message}`);
  }
  // A failed git listing read (corrupt object, spawn failure, timeout,
  // maxBuffer) mapped to an empty result silently empties the frozen set or
  // the changed-paths isolation — the verdict above was computed on an
  // incomplete picture, so fail closed (RFC-1615 review CX-59/CX-60).
  if (repo.unreadableReads.length > 0) {
    add(
      "CORR-GATE-01",
      `a git read failed (${repo.unreadableReads.slice(0, 3).join(", ")}${repo.unreadableReads.length > 3 ? " …" : ""}) — the weakening judgement is incomplete; refusing (fail closed)`,
    );
  }
  const weakeningRecords = weakenings.map((w) => ({ ...w, accepted: acceptedReason !== null }));

  // RFC-1615: --policy-only ends after the weakening verdict — no oracle
  // runs. Same for an exempt contour judging a declared policy surface
  // (CX-29): the contour runs no oracles, only the policy diff.
  if (options.policyOnly || exemptContour) {
    if (mode === "warn") {
      for (const v of violations) if (DOWNGRADE_IN_WARN.has(v.rule)) v.severity = "warning";
    }
    const status = violations.some((v) => v.severity === "error") ? "fail" : "pass";
    return finish(status, [], weakeningRecords, acceptedReason);
  }

  // (3)–(8) per entry.
  const entries: BundleEntry[] = [];
  const manifest = now.manifest;
  const reviews = await readReviewRecords(repo, head, now.reviewsDir ?? DEFAULT_ORACLE_REVIEWS_DIR);
  const checkRun = frozen.base.checkRun ?? now.checkRun;
  // Committed-side knobs only (CX-33): a worktree oracleTimeoutMs/manifest
  // flip must not change the verdict — same commit-derived surface as the
  // manifest entries above.
  const section = (now.forgeDoc["correctness"] ?? {}) as Record<string, unknown>;
  const rawTimeout = section["oracleTimeoutMs"];
  // intAsBigInt parses every YAML int as BigInt — coerce before the >0 check.
  const parsedTimeout = typeof rawTimeout === "bigint" ? Number(rawTimeout) : rawTimeout;
  // CX-39/CX-48: Infinity or > 2³¹−1 overflows Node's setTimeout into a
  // ~1ms fire — fabricated CORR-GATE-07. A sub-millisecond value (0.5) is
  // the same class — it can never bound an oracle run; fall to default.
  const timeoutMs =
    typeof parsedTimeout === "number" &&
    Number.isFinite(parsedTimeout) &&
    parsedTimeout >= 1 &&
    parsedTimeout <= 0x7fffffff
      ? parsedTimeout
      : DEFAULT_ORACLE_TIMEOUT_MS;
  const runRoot = mkdtempSync(path.join(os.tmpdir(), "forge-correctness-run-"));
  let expectedHashes: Set<string> | null = null;
  const expected = async (): Promise<Set<string>> => {
    if (expectedHashes) return expectedHashes;
    const snap = await loadSnapshot(root, { kind: "worktree" }, declaredWriters);
    const discovery = snap ? discoverSchemas(snap) : null;
    expectedHashes = new Set(discovery ? discovery.schemas.map((s) => schemaHashOf(s.db)) : []);
    if (discovery) closeSchemas(discovery);
    return expectedHashes;
  };
  const tier = validation.tier;

  try {
    for (const entry of manifest?.entries ?? []) {
      const bundleEntry: BundleEntry = {
        id: entry.id,
        ref: entry.ref ?? null,
        seam: entry.seam,
        covered: false,
        oracles: [],
      };
      let anyNonSelf = false;
      let anyTierOk = false;
      let anyRunOk = false;
      let anyAttested = false;
      for (const [i, oracle] of entry.oracles.entries()) {
        const file = checkTarget(oracle.check);
        const origin = await deriveOrigin({
          repo,
          head,
          check: oracle.check,
          source: entry.source,
          ref: entry.ref ?? null,
          rfcsDir: baseRfcsDir,
          reviews,
          checkFile: file,
          integrationBase: base,
        });
        const record: BundleOracle = {
          check: oracle.check,
          origin: origin.origin,
          originDetail: origin.detail,
          declaredSubstrate: oracle.substrate,
          attestation: null,
          command: null,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          anchorEvents: [],
          covers: false,
        };
        bundleEntry.oracles.push(record);
        if (origin.origin === "self") continue;
        anyNonSelf = true;
        const tierOk = tier === "high" || tier === "formal" ? origin.viaTrailer : true;
        if (tierOk) anyTierOk = true;
        // proof: oracles are judged by proof.check (tier formal), never through checkRun.
        if (oracle.check.startsWith("proof:")) {
          record.covers = false;
          continue;
        }
        if (!checkRun || !file) {
          add(
            "CORR-GATE-07",
            `${entry.id}: oracle ${oracle.check} cannot run — ${!checkRun ? "bindings.commands.checkRun is unset" : "check has no file"}`,
            { entry: entry.id, check: oracle.check },
          );
          continue;
        }
        // (5) Run in a fresh per-oracle directory.
        const runDir = path.join(runRoot, entry.id, `o${i}`);
        mkdirSync(runDir, { recursive: true });
        const run = await runOracle({ cwd: root, template: checkRun, file, runDir, timeoutMs });
        record.command = run.command;
        record.exitCode = run.exitCode;
        record.timedOut = run.timedOut;
        record.durationMs = run.durationMs;
        if (run.failureClass !== "none") {
          add(
            "CORR-GATE-07",
            `${entry.id}: oracle ${oracle.check} ${run.timedOut ? `timed out after ${timeoutMs}ms (timeout class)` : run.failureClass === "spawn" ? `could not start: ${run.outputTail}` : `exited ${run.exitCode}`}`,
            { entry: entry.id, check: oracle.check },
          );
          continue;
        }
        anyRunOk = true;
        // (6) Attestation.
        let effective: Substrate = oracle.substrate;
        if (oracle.substrate === "L1" || oracle.substrate === "L2") {
          const att = readJson<SubstrateAttestation>(path.join(runDir, ATTESTATION_FILE));
          const hashes = await expected();
          const matches = !!att && att.level === oracle.substrate && hashes.has(att.schemaHash);
          record.attestation = att ? { ...att, matches } : null;
          if (!matches) {
            add(
              "CORR-GATE-04",
              `${entry.id}: oracle ${oracle.check} declares ${oracle.substrate} but ${att ? `its attestation (${att.level}, ${att.schemaHash.slice(0, 12)}) does not match the repository migrations` : "left no attestation (attestSubstrate)"} — counted as L0`,
              { entry: entry.id, check: oracle.check },
            );
            effective = "L0";
          }
        }
        // A declared L3 is never trusted on declaration alone: without declared,
        // fresh captures loaded through loadCapture it counts as L0.
        if (oracle.substrate === "L3" && (oracle.captures ?? []).length === 0) {
          add(
            "CORR-GATE-04",
            `${entry.id}: oracle ${oracle.check} declares L3 without captures — a live run leaves no evidence the gate can check; record captures (loadCapture) — counted as L0`,
            { entry: entry.id, check: oracle.check },
          );
          effective = "L0";
        }
        // On data/lifecycle seams an L3 claim is only as good as the schema it ran on:
        // it counts at its attested level (L1/L2), or L0 without a matching attestation.
        if (
          oracle.substrate === "L3" &&
          entry.seam !== "provider" &&
          entry.seam !== "other" &&
          effective !== "L0"
        ) {
          const att = readJson<SubstrateAttestation>(path.join(runDir, ATTESTATION_FILE));
          const hashes = await expected();
          const matches = !!att && hashes.has(att.schemaHash);
          record.attestation = att ? { ...att, matches } : null;
          effective = matches ? att!.level : "L0";
          if (!matches) {
            add(
              "CORR-GATE-04",
              `${entry.id}: oracle ${oracle.check} declares L3 on a ${entry.seam} seam without a schema attestation matching the migrations — counted as L0`,
              { entry: entry.id, check: oracle.check },
            );
          }
        }
        // Captures: loaded files must be the declared, fresh captures.
        if ((oracle.captures ?? []).length > 0) {
          const loaded =
            readJson<{ path: string; sha256: string }[]>(path.join(runDir, CAPTURES_FILE)) ?? [];
          const declared = new Set((oracle.captures ?? []).map(normalizeRelPath));
          const fresh = (oracle.captures ?? []).every(
            (c) => evaluateCapture(root, c, Date.now()).ok,
          );
          const loadedPaths = new Set(loaded.map((l) => normalizeRelPath(l.path)));
          const honest =
            [...declared].every((d) => loadedPaths.has(d)) &&
            loaded.every(
              (l) =>
                declared.has(normalizeRelPath(l.path)) &&
                sha256(readWorking(normalizeRelPath(l.path)) ?? "") === l.sha256,
            );
          if (fresh && honest && effective !== "L0") {
            if (entry.seam === "provider") effective = "L3";
          } else if (!honest) {
            effective = "L0";
            add(
              "CORR-GATE-04",
              `${entry.id}: oracle ${oracle.check} did not load its declared captures through loadCapture`,
              { entry: entry.id, check: oracle.check },
            );
          }
        }
        // (7) Anchor events.
        let anchorsOk = true;
        if (entry.seam === "lifecycle" && substrateRank(oracle.substrate) >= substrateRank("L2")) {
          const events = readJson<AnchorEventResult[]>(path.join(runDir, ANCHOR_EVENTS_FILE)) ?? [];
          record.anchorEvents = events;
          // Events count only when verified against the handle the oracle attested.
          const attestedHash = record.attestation?.matches ? record.attestation.schemaHash : null;
          for (const e of events) {
            if (e.ok && (attestedHash === null || e.schemaHash !== attestedHash)) {
              e.ok = false;
              e.reason = "event verified against a database other than the attested handle";
            }
          }
          const failed = events.filter((e) => !e.ok);
          for (const f of failed) {
            add(
              "CORR-GATE-05",
              `${entry.id}: forge.anchor ${f.anchor} failed verification — ${f.reason ?? "mismatch"}`,
              { entry: entry.id, check: oracle.check },
            );
          }
          const missing = entry.anchors.filter((a) => !events.some((e) => e.anchor === a && e.ok));
          for (const a of missing) {
            add(
              "CORR-GATE-05",
              `${entry.id}: no verified forge.anchor event for ${a} in the L2 run of ${oracle.check}`,
              { entry: entry.id, check: oracle.check },
            );
          }
          anchorsOk = failed.length === 0 && missing.length === 0;
        }
        const meetsSeam = substrateRank(effective) >= substrateRank(SEAM_MINIMUM[entry.seam]);
        if (meetsSeam && effective !== "L0") anyAttested = true;
        else if (entry.seam === "other") anyAttested = true;
        record.covers = tierOk && meetsSeam && anchorsOk;
      }
      // (4) Formal tier: a proved proof: oracle per entry.
      let formalOk = true;
      if (tier === "formal") {
        const proofs = entry.oracles
          .map((o, i) => ({ o, rec: bundleEntry.oracles[i]! }))
          .filter(({ o, rec }) => o.check.startsWith("proof:") && rec.origin !== "self");
        formalOk = false;
        for (const { o: p } of proofs) {
          const spec = checkTarget(p.check);
          if (!spec) continue;
          const verdict = await (options.proveSpec
            ? options.proveSpec(spec)
            : defaultProve(root, spec));
          if (verdict === "proved") formalOk = true;
        }
        if (!formalOk)
          add(
            "CORR-GATE-06",
            `${entry.id}: tier formal needs a non-self proof: oracle whose proof.check verdict is proved`,
            { entry: entry.id },
          );
      }
      if (!anyNonSelf)
        add(
          "CORR-GATE-03",
          `${entry.id}: every oracle has origin self — add a committed forge/oracle-review@1 record naming its sha256`,
          { entry: entry.id },
        );
      else if (!anyTierOk && (tier === "high" || tier === "formal")) {
        add(
          "CORR-GATE-06",
          `${entry.id}: tier ${tier} needs an oracle last changed by a verifier-trailer commit`,
          { entry: entry.id },
        );
      }
      bundleEntry.covered = formalOk && bundleEntry.oracles.some((o) => o.covers);
      if (!bundleEntry.covered) {
        add(
          "CORR-GATE-08",
          `${entry.id}: no oracle is non-self, passing, attested at or above ${SEAM_MINIMUM[entry.seam]}${entry.seam === "lifecycle" ? ", and anchor-verified" : ""}${anyRunOk && !anyAttested ? " (runs passed below the seam minimum)" : ""}`,
          { entry: entry.id },
        );
      }
      entries.push(bundleEntry);
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }

  // (10) Verdict.
  if (mode === "warn") {
    for (const v of violations) if (DOWNGRADE_IN_WARN.has(v.rule)) v.severity = "warning";
  }
  const status = violations.some((v) => v.severity === "error") ? "fail" : "pass";
  return finish(status, entries, weakeningRecords, acceptedReason);
}
