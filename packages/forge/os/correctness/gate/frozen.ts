/*
<MODULE_CONTRACT>
<purpose>RFC-1580: the frozen set read at `--base` and the weakening diff
against the judged HEAD (CORR-GATE-02). Frozen: the manifest at the base
binding path, `checkRun` / `correctnessManifest` / `oracleReviewsDir`,
`correctness.mode` / `tier` / `audit.allow[]`, every oracle check file,
capture and sidecar named by a base entry, every file matched by the base
`support` globs, and the statements of the anchors base entries bind.</purpose>
<non-goals>
  <item>No edit classifier — any byte change of a frozen file is a weakening unless the last commit touching it carries the verifier trailer pair (operator decision).</item>
  <item>No acceptance decision — run.ts applies --accept-weakening.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-05 findings

N1 bootstrap degrade only while the base has not adopted the contour (a forge downgrade refuses); N2 L3 on data/lifecycle counts at its attested level; N3 anchor events bound to the attested handle; N4 new support-glob files are frozen additions; N5/N6 isolated sessions may touch anchor files and only frozen forge.yaml keys; N7 RFC body amended; N8 regression tests; N9 run root in finally and grandchildren reaped; N10 every declared capture loaded. DEV-7 recorded; DEV-5 narrowed pending operator confirmation.</item>
  <item>RFC-1615: declare and freeze the policy surface at integration</item>
  <item>RFC-1615: malformed-policy CORR-GATE-01, absent-policy note, scaffold tests

AC-7 conformance: a malformed policy: refuses as CORR-GATE-01 in both modes; --policy-only on an undeclared policy reports 'no policy surface declared'. AC-8: defaultForgeConfig carries the block; upgrade patches it only when absent.</item>
  <history>RFC-1580</history>
</CHANGE_SUMMARY>
*/

import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

import { invariantStatementSha } from "../../../src/compass/invariant-parser.ts";
import { anchorsFromSource, buildAnchorIndex, isAnchorSourceCandidate } from "../anchors.ts";
import {
  CAPTURE_SIDECAR_SUFFIX,
  correctnessManifestSchema,
  substrateRank,
  type CorrectnessManifest,
} from "../manifest-schema.ts";
import { normalizeCheckRef, normalizeRelPath } from "../workspace.ts";
import { checkTarget, type GateRepo } from "./repo.ts";
import type { Weakening } from "./types.ts";

export interface PolicySurface {
  mutable: string[];
  additive: string[];
  freezeFiles: string[];
}

export interface CorrectnessSide {
  manifestPath: string | null;
  checkRun: string | null;
  reviewsDir: string | null;
  mode: string;
  tier: string;
  allow: { check: string; subject: string }[];
  manifest: CorrectnessManifest | null;
  compassDocs: string[];
  invariantsFile: string | null;
  /**
   * RFC-1615: the declared policy surface (`policy:`), or null when the base
   * declares none — an undeclared policy leaves the policy checks inert.
   * A malformed section parses to empty lists (deny-by-default).
   */
  policy: PolicySurface | null;
  /** RFC-1615: `policy:` is present but not a `{mutable?, additive?, freezeFiles?}` string-list map. */
  policyMalformed: boolean;
  /** Parsed top-level forge.yaml keys, for the policy-key diff. */
  forgeDoc: Record<string, unknown>;
}

/** Correctness settings + manifest as recorded in one forge.yaml/manifest text pair. */
export function sideFrom(
  forgeYaml: string | null,
  readManifest: (rel: string) => string | null,
): CorrectnessSide {
  let doc: Record<string, unknown> = {};
  try {
    doc = (forgeYaml ? parseYaml(forgeYaml) : {}) ?? {};
  } catch {
    doc = {};
  }
  const bindings = (doc["bindings"] ?? {}) as {
    commands?: Record<string, unknown>;
    paths?: Record<string, unknown>;
  };
  const section = (doc["correctness"] ?? {}) as Record<string, unknown>;
  const manifestPath =
    typeof bindings.paths?.["correctnessManifest"] === "string"
      ? (bindings.paths["correctnessManifest"] as string)
      : null;
  let manifest: CorrectnessManifest | null = null;
  if (manifestPath) {
    const raw = readManifest(manifestPath);
    if (raw) {
      try {
        const parsed = correctnessManifestSchema.safeParse(parseYaml(raw) ?? {});
        if (parsed.success) manifest = parsed.data;
      } catch {
        manifest = null;
      }
    }
  }
  const allowRaw = ((section["audit"] ?? {}) as { allow?: unknown }).allow;
  return {
    manifestPath,
    checkRun:
      typeof bindings.commands?.["checkRun"] === "string"
        ? (bindings.commands["checkRun"] as string)
        : null,
    reviewsDir:
      typeof bindings.paths?.["oracleReviewsDir"] === "string"
        ? (bindings.paths["oracleReviewsDir"] as string)
        : null,
    mode: typeof section["mode"] === "string" ? (section["mode"] as string) : "warn",
    tier: typeof section["tier"] === "string" ? (section["tier"] as string) : "standard",
    allow: Array.isArray(allowRaw)
      ? (allowRaw as { check?: unknown; subject?: unknown }[]).map((a) => ({
          check: String(a?.check ?? ""),
          subject: String(a?.subject ?? ""),
        }))
      : [],
    manifest,
    compassDocs: Array.isArray(bindings.paths?.["compassDocs"])
      ? (bindings.paths["compassDocs"] as string[])
      : [],
    invariantsFile:
      typeof bindings.paths?.["invariantsFile"] === "string"
        ? (bindings.paths["invariantsFile"] as string)
        : null,
    policy: parsePolicySurface(doc["policy"]).surface,
    policyMalformed: parsePolicySurface(doc["policy"]).malformed,
    forgeDoc: doc,
  };
}

/**
 * Loose parse of `policy:` — the section must exist to arm the policy checks;
 * a malformed value degrades to empty lists (deny-by-default), never fails
 * open, and is reported via `malformed` so the gate can refuse as CORR-GATE-01.
 */
function parsePolicySurface(raw: unknown): {
  surface: PolicySurface | null;
  malformed: boolean;
} {
  if (raw === undefined || raw === null) return { surface: null, malformed: false };
  const isMap = typeof raw === "object" && !Array.isArray(raw);
  const obj = (isMap ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const declared = ["mutable", "additive", "freezeFiles"] as const;
  const malformed = !isMap || declared.some((k) => obj[k] !== undefined && !Array.isArray(obj[k]));
  return {
    surface: {
      mutable: list(obj["mutable"]),
      additive: list(obj["additive"]),
      freezeFiles: list(obj["freezeFiles"]),
    },
    malformed,
  };
}

/** Stable serialization: object keys sorted recursively so key order never diffs. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Leaf map of a value: object keys compose `a.b.c`, array elements address by
 * index. Appending to an array adds leaves; every other change to an existing
 * leaf is visible as a changed or missing entry.
 */
export function policyLeaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      for (const [k, leaf] of policyLeaves(v, `${prefix}[${i}]`)) out.set(k, leaf);
    });
    if (value.length === 0) out.set(prefix, []);
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      for (const [lk, leaf] of policyLeaves(v, prefix ? `${prefix}.${k}` : k)) out.set(lk, leaf);
    }
    if (entries.length === 0) out.set(prefix, {});
    return out;
  }
  out.set(prefix, value);
  return out;
}

const TIER_RANK: Record<string, number> = { standard: 0, high: 1, formal: 2 };

export interface FrozenSet {
  base: CorrectnessSide;
  /** Frozen file paths (oracles, captures, sidecars, support matches) at base. */
  files: string[];
  /** Anchor id → normalized statement sha at base (anchors bound by base entries). */
  anchors: Map<string, string>;
  /** Requirement, DNA, and manifest-entry refs that existed at base (deferred exemptions for them are weakenings). */
  baseRefs: Set<string>;
  /** True when the base binds a manifest file that exists but does not parse. */
  baseManifestUnreadable: boolean;
  /** Base `support` globs (new files matching them are frozen-set additions). */
  supportGlobs: string[];
  /** Files at base that declare a frozen anchor (an isolated anchor change touches them). */
  anchorFiles: string[];
  /** Every file path at base. */
  baseFiles: string[];
  /** RFC-1615: base `policy.freezeFiles` globs. */
  policyGlobs: string[];
  /** RFC-1615: base files matching `policy.freezeFiles` (byte-frozen). */
  policyFiles: string[];
}

export async function readFrozenSet(repo: GateRepo, base: string): Promise<FrozenSet> {
  const forgeYaml = await repo.show(base, "forge.yaml");
  const manifests = new Map<string, string | null>();
  const baseManifestPath = sideFrom(forgeYaml, () => null).manifestPath;
  if (baseManifestPath)
    manifests.set(baseManifestPath, await repo.show(base, normalizeRelPath(baseManifestPath)));
  const side = sideFrom(forgeYaml, (rel) => manifests.get(rel) ?? null);
  // A bound base manifest that exists but does not parse must not freeze
  // nothing (fail-open) — the gate refuses until it is readable.
  const baseManifestUnreadable =
    baseManifestPath !== null &&
    (manifests.get(baseManifestPath) ?? null) !== null &&
    side.manifest === null;
  const files = new Set<string>();
  const baseFiles = await repo.files(base);
  if (side.manifest) {
    for (const entry of side.manifest.entries) {
      for (const oracle of entry.oracles) {
        const target = checkTarget(oracle.check);
        if (target) files.add(normalizeRelPath(target));
        for (const c of oracle.captures ?? []) {
          files.add(normalizeRelPath(c));
          files.add(`${normalizeRelPath(c)}${CAPTURE_SIDECAR_SUFFIX}`);
        }
      }
    }
    for (const glob of side.manifest.support) {
      const match = picomatch(normalizeRelPath(glob), { dot: true });
      for (const f of baseFiles) if (match(f)) files.add(f);
    }
  }
  // Anchor statements at base, for ids bound by base entries.
  const wanted = new Set((side.manifest?.entries ?? []).flatMap((e) => e.anchors));
  const anchors = new Map<string, string>();
  const anchorFiles = new Set<string>();
  if (wanted.size > 0) {
    const grep = await repo.git.run(["grep", "-l", "-z", "-F", "@ai-invariant[", base, "--"]);
    const hits = (grep ?? "")
      .split("\0")
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith(`${base}:`) ? l.slice(base.length + 1) : l))
      .filter(isAnchorSourceCandidate);
    for (const rel of hits) {
      const text = await repo.show(base, rel);
      if (!text) continue;
      for (const a of anchorsFromSource(rel, text)) {
        if (wanted.has(a.id)) anchorFiles.add(rel);
        if (wanted.has(a.id) && !anchors.has(a.id))
          anchors.set(a.id, invariantStatementSha(a.statement));
      }
    }
  }
  // Requirement / DNA ids at base.
  const baseRefs = new Set<string>();
  for (const rel of side.compassDocs) {
    const text = await repo.show(base, normalizeRelPath(rel));
    if (text && /<document-id>\s*requirements\s*<\/document-id>/.test(text)) {
      for (const m of text.matchAll(/<requirement\b[^>]*?\bid\s*=\s*"([^"]+)"/g))
        baseRefs.add(m[1]!);
    }
  }
  if (side.invariantsFile) {
    const text = await repo.show(base, normalizeRelPath(side.invariantsFile));
    for (const m of (text ?? "").matchAll(/^##\s+DNA-(\d+)\b/gm)) baseRefs.add(`DNA-${m[1]}`);
  }
  for (const e of side.manifest?.entries ?? []) if (e.ref) baseRefs.add(e.ref);
  // RFC-1615: `policy.freezeFiles` globs freeze their base matches byte-wise.
  const policyGlobs = side.policy?.freezeFiles ?? [];
  const policyFiles = new Set<string>();
  for (const glob of policyGlobs) {
    const match = picomatch(normalizeRelPath(glob), { dot: true });
    for (const f of baseFiles) if (match(f)) policyFiles.add(f);
  }
  return {
    base: side,
    files: [...files].sort(),
    anchors,
    baseRefs,
    baseManifestUnreadable,
    supportGlobs: side.manifest?.support ?? [],
    anchorFiles: [...anchorFiles].sort(),
    baseFiles,
    policyGlobs,
    policyFiles: [...policyFiles].sort(),
  };
}

/** The judged side, read from the working tree of the session worktree. */
export function readHeadSide(
  root: string,
  readFile: (rel: string) => string | null,
): CorrectnessSide {
  return sideFrom(readFile("forge.yaml"), (rel) => readFile(normalizeRelPath(rel)));
}

/** Structural weakenings: bindings, correctness section, entries, oracles, exemptions. */
export function diffWeakenings(frozen: FrozenSet, now: CorrectnessSide): Weakening[] {
  const base = frozen.base;
  const out: Weakening[] = [];
  const add = (kind: string, subject: string, message: string) =>
    out.push({ kind, subject, message });

  // Bindings and the correctness section.
  for (const [key, before, after] of [
    ["bindings.paths.correctnessManifest", base.manifestPath, now.manifestPath],
    ["bindings.commands.checkRun", base.checkRun, now.checkRun],
    ["bindings.paths.oracleReviewsDir", base.reviewsDir, now.reviewsDir],
  ] as const) {
    if (before !== null && before !== after)
      add(
        "binding",
        key,
        `${key} changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      );
  }
  if (base.mode === "enforce" && now.mode !== "enforce")
    add("mode", "correctness.mode", `correctness.mode changed from enforce to ${now.mode}`);
  // A session must not exempt itself (it would also drop CORR-AUDIT-04, RFC-1579).
  else if (base.mode !== "exempt" && now.mode === "exempt")
    add("mode", "correctness.mode", `correctness.mode changed from ${base.mode} to exempt`);
  if ((TIER_RANK[now.tier] ?? 0) < (TIER_RANK[base.tier] ?? 0))
    add("tier", "correctness.tier", `correctness.tier lowered from ${base.tier} to ${now.tier}`);
  const baseAllow = new Set(base.allow.map((a) => `${a.check}\0${a.subject}`));
  for (const a of now.allow) {
    if (!baseAllow.has(`${a.check}\0${a.subject}`))
      add(
        "allow",
        `${a.check}:${a.subject}`,
        `correctness.audit.allow[] gained ${a.check} ${a.subject}`,
      );
  }

  // Manifest entries.
  const nowEntries = new Map((now.manifest?.entries ?? []).map((e) => [e.id, e]));
  for (const e of base.manifest?.entries ?? []) {
    const n = nowEntries.get(e.id);
    if (!n) {
      add("entry-deleted", e.id, `manifest entry ${e.id} was deleted`);
      continue;
    }
    if ((n.ref ?? null) !== (e.ref ?? null))
      add("entry-changed", e.id, `${e.id} ref changed from ${e.ref ?? "∅"} to ${n.ref ?? "∅"}`);
    if (n.seam !== e.seam)
      add("entry-changed", e.id, `${e.id} seam changed from ${e.seam} to ${n.seam}`);
    if (n.source !== e.source)
      add("entry-changed", e.id, `${e.id} source changed from ${e.source} to ${n.source}`);
    if ((n.statement ?? null) !== (e.statement ?? null))
      add("entry-changed", e.id, `${e.id} statement changed`);
    if ([...n.anchors].sort().join(",") !== [...e.anchors].sort().join(","))
      add("entry-changed", e.id, `${e.id} anchors changed`);
    const nowOracles = new Map(n.oracles.map((o) => [normalizeCheckRef(o.check), o]));
    for (const o of e.oracles) {
      const m = nowOracles.get(normalizeCheckRef(o.check));
      if (!m)
        add("oracle-removed", `${e.id}:${o.check}`, `${e.id} lost (or rebound) oracle ${o.check}`);
      else {
        // Any substrate change of a frozen oracle is a weakening: lowering
        // drops rigor, raising re-declares what the oracle runs on.
        if (m.substrate !== o.substrate) {
          add(
            substrateRank(m.substrate) < substrateRank(o.substrate)
              ? "substrate-lowered"
              : "substrate-changed",
            `${e.id}:${o.check}`,
            `${e.id} oracle ${o.check} substrate changed from ${o.substrate} to ${m.substrate}`,
          );
        }
        const kept = new Set((m.captures ?? []).map(normalizeRelPath));
        for (const c of o.captures ?? []) {
          if (!kept.has(normalizeRelPath(c))) {
            add(
              "capture-dropped",
              `${e.id}:${o.check}`,
              `${e.id} oracle ${o.check} dropped capture ${c}`,
            );
          }
        }
      }
    }
  }

  // Exemptions.
  const baseEx = new Set((base.manifest?.exemptions ?? []).map((x) => `${x.ref}\0${x.kind}`));
  for (const x of now.manifest?.exemptions ?? []) {
    if (baseEx.has(`${x.ref}\0${x.kind}`)) continue;
    if (x.kind === "unverifiable")
      add("exemption", x.ref, `unverifiable exemption added for ${x.ref} (an operator decision)`);
    else if (frozen.baseRefs.has(x.ref))
      add(
        "exemption",
        x.ref,
        `deferred exemption added for ${x.ref}, which existed at the base revision`,
      );
  }

  return out;
}

/**
 * RFC-1615 policy weakenings, armed only when the base declares `policy:`:
 * `policy-decl` — the declaration itself changed (self-frozen); `policy-key` —
 * a top-level key outside `mutable` changed, an `additive` key lost or changed
 * an existing leaf, or a new top-level key appeared undeclared.
 */
export function policyWeakenings(frozen: FrozenSet, now: CorrectnessSide): Weakening[] {
  const policy = frozen.base.policy;
  if (!policy) return [];
  const out: Weakening[] = [];
  const baseDoc = frozen.base.forgeDoc;
  const nowDoc = now.forgeDoc;

  if (canon(baseDoc["policy"]) !== canon(nowDoc["policy"])) {
    out.push({
      kind: "policy-decl",
      subject: "policy",
      message: "the policy: declaration changed — a session cannot amend its own policy surface",
    });
  }

  const mutable = new Set(policy.mutable);
  const additive = new Set(policy.additive);
  const keys = new Set([...Object.keys(baseDoc), ...Object.keys(nowDoc)]);
  keys.delete("policy");
  for (const key of [...keys].sort()) {
    const before = baseDoc[key];
    const after = nowDoc[key];
    if (canon(before) === canon(after)) continue;
    if (mutable.has(key)) continue;
    if (additive.has(key)) {
      if (before === undefined) continue; // every leaf is new
      const nowLeaves = policyLeaves(after);
      const broken = [...policyLeaves(before)].filter(
        ([p, v]) => !nowLeaves.has(p) || canon(nowLeaves.get(p)) !== canon(v),
      );
      if (broken.length === 0) continue;
      out.push({
        kind: "policy-key",
        subject: key,
        message: `${key} is additive — existing leaves changed or were removed (${broken
          .slice(0, 3)
          .map(([p]) => p)
          .join(", ")}${broken.length > 3 ? " …" : ""})`,
      });
      continue;
    }
    out.push({
      kind: "policy-key",
      subject: key,
      message:
        before === undefined
          ? `new top-level key ${key} is not declared in policy.mutable or policy.additive`
          : after === undefined
            ? `frozen top-level key ${key} was removed`
            : `frozen top-level key ${key} changed — declare it under policy.mutable or policy.additive to permit this`,
    });
  }
  return out;
}

/** Byte-change weakenings: a frozen file whose blob differs at HEAD, unless a verifier commit made the last change. */
export async function byteWeakenings(
  repo: GateRepo,
  base: string,
  head: string,
  files: string[],
  kind = "frozen-file",
): Promise<Weakening[]> {
  const out: Weakening[] = [];
  for (const rel of files) {
    const before = await repo.blob(base, rel);
    const after = await repo.blob(head, rel);
    if (before === after) continue;
    if (after !== null && (await repo.lastTouchIsVerifier(head, rel))) continue;
    out.push({
      kind,
      subject: rel,
      message:
        after === null
          ? `frozen file ${rel} was deleted`
          : `frozen file ${rel} changed without the verifier trailer pair on its last commit`,
    });
  }
  return out;
}

/** Anchor weakenings: a frozen anchor id removed, or its normalized statement changed. */
/**
 * Files new at HEAD that match a base `support` glob (a new runner config or
 * setup file shapes how frozen oracles run) — weakenings unless a verifier
 * commit added them.
 */
export async function supportAdditions(
  repo: GateRepo,
  base: string,
  head: string,
  frozen: FrozenSet,
): Promise<Weakening[]> {
  void base;
  return globAdditions(
    repo,
    head,
    frozen.baseFiles,
    frozen.supportGlobs,
    "frozen-file",
    "a frozen support glob",
  );
}

/**
 * RFC-1615: files new at HEAD matching a base `policy.freezeFiles` glob —
 * an agent must not extend a frozen surface (new hook, new workflow) without
 * a verifier commit.
 */
export async function policyFileAdditions(
  repo: GateRepo,
  head: string,
  frozen: FrozenSet,
): Promise<Weakening[]> {
  return globAdditions(
    repo,
    head,
    frozen.baseFiles,
    frozen.policyGlobs,
    "policy-file",
    "a policy.freezeFiles glob",
  );
}

async function globAdditions(
  repo: GateRepo,
  head: string,
  baseFiles: string[],
  globs: string[],
  kind: string,
  globLabel: string,
): Promise<Weakening[]> {
  if (globs.length === 0) return [];
  const before = new Set(baseFiles);
  const matchers = globs.map((g) => picomatch(normalizeRelPath(g), { dot: true }));
  const out: Weakening[] = [];
  for (const rel of await repo.files(head)) {
    if (before.has(rel) || !matchers.some((m) => m(rel))) continue;
    if (await repo.lastTouchIsVerifier(head, rel)) continue;
    out.push({
      kind,
      subject: rel,
      message: `new file ${rel} matches ${globLabel} and was not added by a verifier commit`,
    });
  }
  return out;
}

export function anchorWeakenings(root: string, files: string[], frozen: FrozenSet): Weakening[] {
  if (frozen.anchors.size === 0) return [];
  const index = buildAnchorIndex(root, files, [...frozen.anchors.keys()]);
  const out: Weakening[] = [];
  for (const [id, sha] of frozen.anchors) {
    const now = index.anchors.get(id) ?? [];
    if (now.length === 0)
      out.push({ kind: "anchor-removed", subject: id, message: `frozen anchor ${id} was removed` });
    // Every copy must keep the frozen statement — a duplicate comment carrying
    // the old text must not mask a reworded real anchor.
    else if (!now.every((a) => invariantStatementSha(a.statement) === sha)) {
      out.push({
        kind: "anchor-reworded",
        subject: id,
        message: `frozen anchor ${id} statement changed`,
      });
    }
  }
  return out;
}
