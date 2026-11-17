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
  <item>RFC-1615: wire range derivation into unreadable-reads, blob-only path reads, suppress unsupported anchor-removed</item>
  <item>RFC-1615: close RFC-1615 round-14 counterexamples — binding adds, base-side rfc namespace, governed acceptance provenance, unreadable listings</item>
  <item>RFC-1615: close RFC-1615 round-15 counterexamples — live rfcsDir key, base-anchored governing-reference resolution, judged compassDocs</item>
  <item>RFC-1615: harden round-15 observations — judge invariantsFile, parity rfc scope, strip binding keys, drop dead readHeadSide</item>
  <item>RFC-1615: close round-18 counterexamples — traversal-order rfc parity, literal history pathspecs, normalized binding compare, plain-object prune</item>
  <history>RFC-1580, RFC-1615</history>
</CHANGE_SUMMARY>
*/

import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

import { invariantStatementSha } from "../../../src/compass/invariant-parser.ts";
import { anchorsFromSource, isAnchorSourceCandidate } from "../anchors.ts";
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
  rfcsDir: string | null;
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
  /** RFC-1615: forge.yaml exists but does not parse to a YAML map — fail closed. */
  forgeYamlUnreadable: boolean;
  /** Parsed top-level forge.yaml keys, for the policy-key diff. */
  forgeDoc: Record<string, unknown>;
}

/** Correctness settings + manifest as recorded in one forge.yaml/manifest text pair. */
/**
 * True for a plain YAML mapping — `typeof "object"` alone is too loose:
 * `!!set`/`!!omap`/`!!timestamp`/`!!binary` produce Set/Map/Date/Buffer
 * roots that carry no readable keys and would silently inert the surface
 * (RFC-1615 review CX-56/CX-57).
 */
function isPlainMap(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function sideFrom(
  forgeYaml: string | null,
  readManifest: (rel: string) => string | null,
): CorrectnessSide {
  let doc: Record<string, unknown> = {};
  // A forge.yaml that exists but parses to a non-map (or not at all) is
  // *unreadable*, never "no surface declared" — the whole frozen set would
  // otherwise silently inert (RFC-1615 review CX-15/CX-19).
  let forgeYamlUnreadable = false;
  try {
    // intAsBigInt — `9007199254740993` and `9007199254740992` collapse to one
    // double in JS; the policy diff must see them as distinct (CX-22).
    const parsed = forgeYaml !== null ? parseYaml(forgeYaml, { intAsBigInt: true }) : {};
    // A root that is not a PLAIN map — scalar, array, or a tagged type like
    // `!!set`/`!!omap`/`!!timestamp`/`!!binary` (Set/Map/Date/Buffer pass
    // `typeof "object"` but carry no readable keys) — is unreadable, never
    // "no surface declared" (RFC-1615 review CX-56).
    if (parsed === null || !isPlainMap(parsed)) {
      forgeYamlUnreadable = forgeYaml !== null;
    } else {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    forgeYamlUnreadable = forgeYaml !== null;
  }
  const bindings = (doc["bindings"] ?? {}) as {
    commands?: Record<string, unknown>;
    paths?: Record<string, unknown>;
  };
  const section = (doc["correctness"] ?? {}) as Record<string, unknown>;
  // Binding values are compared and resolved normalized: a `./`-respelled
  // path or a whitespace-respelled checkRun argv names the SAME target —
  // judging it a weakening fabricates a violation (CX-118).
  const rel = (v: unknown): string | null => (typeof v === "string" ? normalizeRelPath(v) : null);
  const manifestPath = rel(bindings.paths?.["correctnessManifest"]);
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
        ? (bindings.commands["checkRun"] as string).replace(/\s+/g, " ").trim()
        : null,
    reviewsDir: rel(bindings.paths?.["oracleReviewsDir"]),
    // The RFC namespace is frozen too — a session rebind makes planted
    // `status: accepted` files resolve as governing RFCs (CX-78). The LIVE
    // key is the top-level `paths:` object (forge-config schema); a
    // `bindings.paths.rfcsDir` key is stripped by the loader and read by no
    // consumer — judging it would be a dead check (CX-82).
    rfcsDir: rel((doc["paths"] as Record<string, unknown> | undefined)?.["rfcsDir"]),
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
      ? (bindings.paths["compassDocs"] as unknown[])
          .filter(
            // element check — `compassDocs: [1]` must not throw `p.replace`
            // downstream where the strings are normalized (CX-47).
            (x): x is string => typeof x === "string",
          )
          .map(normalizeRelPath)
      : [],
    invariantsFile: rel(bindings.paths?.["invariantsFile"]),
    policy: parsePolicySurface(doc["policy"]).surface,
    policyMalformed: parsePolicySurface(doc["policy"]).malformed,
    forgeYamlUnreadable,
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
  // `policy:` absent vs `policy: null` — only the absent form is undeclared;
  // a declared-but-empty (null) section is malformed (RFC-1615 review CX-8).
  if (raw === undefined) return { surface: null, malformed: false };
  const isMap = isPlainMap(raw);
  const obj = (isMap ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const declared = ["mutable", "additive", "freezeFiles"] as const;
  const malformed =
    !isMap ||
    declared.some(
      (k) =>
        obj[k] !== undefined &&
        (!Array.isArray(obj[k]) ||
          // silently dropping non-string members would fail open on a declared
          // freeze (freezeFiles: [1] binds zero globs) — malformed instead
          (obj[k] as unknown[]).some((m) => typeof m !== "string")),
    ) ||
    // a `!`-prefixed freezeFiles glob is a picomatch negation — it would
    // freeze the *complement* (the whole repo): refuse the declaration.
    list(obj["freezeFiles"]).some((g) => g.startsWith("!"));
  return {
    surface: {
      mutable: list(obj["mutable"]),
      additive: list(obj["additive"]),
      freezeFiles: list(obj["freezeFiles"]),
    },
    malformed,
  };
}

/**
 * Stable serialization: object keys sorted recursively so key order never
 * diffs. Tagged YAML scalars stay distinguishable — `!!timestamp`/Date, Map,
 * Set, binary views carry constructor tags, and non-finite numbers keep their
 * value (`JSON.stringify(NaN)` collides with YAML null — RFC-1615 review
 * CX-14). A cycle sentinel prevents RangeError on recursive anchors.
 */
export function canon(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (typeof value === "bigint") return `int:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `num:${value}`;
    if (Object.is(value, -0)) return "num:-0"; // `-0` ≠ `0` (RFC-1615 review CX-22)
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (seen.has(value)) return '"cycle"';
  seen.add(value);
  try {
    if (value instanceof Date) return `date:${value.getTime()}`;
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) => [canon(k, seen), canon(v, seen)] as const,
      );
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `map:{${entries.map(([k, v]) => `${k}:${v}`).join(",")}}`;
    }
    if (value instanceof Set) {
      return `set:{${[...value]
        .map((v) => canon(v, seen))
        .sort()
        .join(",")}}`;
    }
    if (ArrayBuffer.isView(value)) {
      return `bin:${Array.from(value as Uint8Array).join(",")}`;
    }
    if (Array.isArray(value)) return `[${value.map((v) => canon(v, seen)).join(",")}]`;
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Quoted path segment: every object key becomes `["key"]` so a literal dotted
 * key (`{"a.b": 1}`) can never conflate with a nested path (`{a: {b: 1}}` →
 * `["a"]["b"]`) — RFC-1615 review CX-1.
 */
const seg = (key: string): string => `["${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

/** Display form of a leaf path: `["a"]["b"][0]` → `root.a.b[0]`. */
function displayLeaf(root: string, leafPath: string): string {
  const shown = leafPath.replace(
    /\["((?:[^"\\]|\\.)*)"\]/g,
    (_m, k: string) => `.${k.replace(/\\"/g, '"').replace(/\\\\/g, "\\")}`,
  );
  return `${root}${shown}`;
}

/**
 * Leaf map of a value: object keys address by quoted segment, array elements
 * by index. Empty containers contribute no leaves — the first element added
 * to `{}`/`[]` under an `additive` key is a pure addition, not a removal
 * (RFC-1615 review CX-2).
 */
export function policyLeaves(
  value: unknown,
  prefix = "",
  seen: WeakSet<object> = new WeakSet(),
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  // `null`/`undefined` carry no leaves — `key:` (YAML null) is an empty
  // container for additive purposes, and an absent key leaves nothing
  // (RFC-1615 review CX-6/CX-7). Tagged scalars (Date/Map/Set/binary views)
  // are leaves — only plain objects and arrays walk deeper (CX-14).
  if (value === null || value === undefined) return out;
  if (typeof value === "object") {
    if (seen.has(value)) {
      out.set(prefix, "<cycle>");
      return out;
    }
    seen.add(value);
  }
  try {
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        for (const [k, leaf] of policyLeaves(v, `${prefix}[${i}]`, seen)) out.set(k, leaf);
      });
      return out;
    }
    if (
      typeof value === "object" &&
      !(value instanceof Date) &&
      !(value instanceof Map) &&
      !(value instanceof Set) &&
      !ArrayBuffer.isView(value)
    ) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        for (const [lk, leaf] of policyLeaves(v, `${prefix}${seg(k)}`, seen)) out.set(lk, leaf);
      }
      return out;
    }
  } finally {
    // Unwind — `seen` guards ancestor cycles only; a shared (aliased) node
    // revisited from a sibling branch must leaf normally, or an anchor
    // re-point becomes invisible (RFC-1615 review CX-21).
    if (typeof value === "object") seen.delete(value);
  }
  out.set(prefix, value);
  return out;
}

/** The first leaf path (sorted) whose scalar differs between two values, or null. */
function firstLeafDiff(before: unknown, after: unknown): string | null {
  const b = policyLeaves(before);
  const a = policyLeaves(after);
  for (const path of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    if (!a.has(path) || !b.has(path) || canon(a.get(path)) !== canon(b.get(path))) return path;
  }
  return null;
}

const TIER_RANK: Record<string, number> = { standard: 0, high: 1, formal: 2 };

export interface FrozenSet {
  base: CorrectnessSide;
  /** Frozen file paths (oracles, captures, sidecars, support matches) at base. */
  files: string[];
  /**
   * Anchor id → normalized statement shas at base (anchors bound by base
   * entries). One id can legitimately carry divergent statement copies — the
   * frozen set keeps every sha seen at base, not a first-found winner
   * (CX-70).
   */
  anchors: Map<string, Set<string>>;
  /** Requirement, DNA, and manifest-entry refs that existed at base (deferred exemptions for them are weakenings). */
  baseRefs: Set<string>;
  /** True when the base binds a manifest file that exists but does not parse. */
  baseManifestUnreadable: boolean;
  /**
   * Base `support` globs (new files matching them are frozen-set additions).
   * A `!`-prefixed glob is a picomatch negation — it would freeze the
   * *complement* of the intended set (same refusal as `policy.freezeFiles`,
   * RFC-1615 review CX-53).
   */
  supportGlobs: string[];
  /** True when a base `support` glob carries a `!` negation. */
  supportMalformed: boolean;
  /** Files at base that declare a frozen anchor (an isolated anchor change touches them). */
  anchorFiles: string[];
  /** Per-id carrier files at base — an anchor in an unchanged file cannot reword (CX-59). */
  anchorCarriers: Map<string, Set<string>>;
  /** Every file path at base. */
  baseFiles: string[];
  /**
   * True when the base `ls-tree -r` enumeration completed — when it failed
   * `baseFiles` is partial and "not in the base set" is not evidence of an
   * addition, so glob additions re-check membership per path (CX-76).
   */
  baseFilesComplete: boolean;
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
  const u0Files = repo.unreadableReads.length;
  const baseFiles = await repo.files(base);
  const baseFilesComplete = repo.unreadableReads.length === u0Files;
  // CX-53: a `!`-prefixed support glob is a picomatch negation — silently
  // freezing the complement fabricates frozen-file weakenings on every
  // unrelated change. Refuse like a malformed `policy.freezeFiles` glob.
  const supportGlobs = side.manifest?.support ?? [];
  const supportMalformed = supportGlobs.some((g) => g.startsWith("!"));
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
    for (const glob of supportMalformed ? [] : supportGlobs) {
      const match = picomatch(normalizeRelPath(glob), { dot: true });
      for (const f of baseFiles) if (match(f)) files.add(f);
    }
  }
  // Anchor statements at base, for ids bound by base entries.
  const wanted = new Set((side.manifest?.entries ?? []).flatMap((e) => e.anchors));
  const anchors = new Map<string, Set<string>>();
  const anchorFiles = new Set<string>();
  const anchorCarriers = new Map<string, Set<string>>();
  if (wanted.size > 0) {
    // `git grep` exit 1 (zero matches) is a valid empty listing — grepList
    // passes it through; only a real failure flags (CX-67).
    const grep = await repo.grepList(base, "@ai-invariant[");
    const hits = grep
      .map((l) => (l.startsWith(`${base}:`) ? l.slice(base.length + 1) : l))
      .filter(isAnchorSourceCandidate);
    for (const rel of hits) {
      const text = await repo.show(base, rel);
      if (!text) continue;
      for (const a of anchorsFromSource(rel, text)) {
        if (!wanted.has(a.id)) continue;
        anchorFiles.add(rel);
        const carriers = anchorCarriers.get(a.id) ?? new Set<string>();
        carriers.add(rel);
        anchorCarriers.set(a.id, carriers);
        const shas = anchors.get(a.id) ?? new Set<string>();
        shas.add(invariantStatementSha(a.statement));
        anchors.set(a.id, shas);
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
  // `forge.yaml` itself is never a byte-frozen policy file — its surface is
  // judged by policyWeakenings/the isolation strip; a `freezeFiles` glob that
  // happens to match it (forge.yaml, *.yaml, x/../forge.yaml) must neither
  // turn every edit into `policy-file` nor whitelist the path in the accept
  // check (RFC-1615 review CX-52).
  // A malformed `policy:` (including a `!`-negation freezeFiles glob, which
  // parsePolicySurface already flags) resolves to NOTHING — the complement
  // match must not fabricate policy-file claims nor whitelist foreign paths
  // in the accept check (CX-80, mirror of the CX-53 support-glob rule).
  const policyGlobs = side.policyMalformed ? [] : (side.policy?.freezeFiles ?? []);
  const policyFiles = new Set<string>();
  for (const glob of policyGlobs) {
    const match = picomatch(normalizeRelPath(glob), { dot: true });
    for (const f of baseFiles) if (f !== "forge.yaml" && match(f)) policyFiles.add(f);
  }
  return {
    base: side,
    files: [...files].sort(),
    anchors,
    baseRefs,
    baseManifestUnreadable,
    // A malformed support glob resolves to NOTHING — the complement match
    // must not fabricate frozen-file weakenings/additions downstream.
    supportGlobs: supportMalformed ? [] : supportGlobs,
    supportMalformed,
    anchorFiles: [...anchorFiles].sort(),
    anchorCarriers,
    baseFiles,
    baseFilesComplete,
    policyGlobs,
    policyFiles: [...policyFiles].sort(),
  };
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
    ["paths.rfcsDir", base.rfcsDir, now.rfcsDir],
    ["bindings.paths.invariantsFile", base.invariantsFile, now.invariantsFile],
  ] as const) {
    if (before !== null && before !== after)
      add(
        "binding",
        key,
        `${key} changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      );
    // ADDING a binding under a declared contour is a substrate change too —
    // a session-bound checkRun runs its own runner, a planted reviewsDir
    // reads its own records, a rebound rfcsDir resolves planted RFCs
    // (CX-77/CX-78). A base with no contour is adopting, not weakening.
    else if (before === null && after !== null && base.manifestPath !== null)
      add(
        "binding",
        key,
        `${key} added ${JSON.stringify(after)} where the base contour bound none`,
      );
  }
  // The requirements-document binding is list-valued: any add, drop, or
  // reorder under a declared contour redirects CORR-03's requirement
  // resolution — a session-planted compass doc must not mint requirement
  // provenance unjudged (CX-83).
  if (base.manifestPath !== null && canon(base.compassDocs) !== canon(now.compassDocs))
    add(
      "binding",
      "bindings.paths.compassDocs",
      `bindings.paths.compassDocs changed from ${JSON.stringify(base.compassDocs)} to ${JSON.stringify(now.compassDocs)}`,
    );
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
    // Presence is judged independently of value — `key:` (null) at base and
    // the key absent are not the same thing (RFC-1615 review CX-7). And `in`
    // consults the prototype chain — `hasOwnProperty:`/`constructor:`/
    // `__proto__:` must not read as always-present (RFC-1615 review CX-13).
    const had = Object.hasOwn(baseDoc, key);
    const has = Object.hasOwn(nowDoc, key);
    const before = had ? baseDoc[key] : undefined;
    const after = has ? nowDoc[key] : undefined;
    if (had === has && canon(before) === canon(after)) continue;
    if (mutable.has(key)) continue;
    if (additive.has(key)) {
      if (!had || before === null || before === undefined) continue; // every leaf is new
      const nowLeaves = policyLeaves(after);
      const broken = [...policyLeaves(before)].filter(
        ([p, v]) => !nowLeaves.has(p) || canon(nowLeaves.get(p)) !== canon(v),
      );
      if (broken.length === 0) continue;
      const shown = broken.map(([p]) => displayLeaf(key, p));
      out.push({
        kind: "policy-key",
        subject: shown[0]!,
        message: `${key} is additive — existing leaves changed or were removed (${shown
          .slice(0, 3)
          .join(", ")}${shown.length > 3 ? " …" : ""})`,
      });
      continue;
    }
    // New/removed keys are reported by their own name — a leaf path only
    // applies when both sides carry the key (RFC-1615 review CX-7 follow-up).
    const leaf = had && has ? firstLeafDiff(before, after) : null;
    // The subject names the nearest keyed ancestor — a deny: [] change is
    // `agentTools.deny`, not `agentTools.deny[0]` (RFC-1615 review CX-5).
    const subject =
      leaf === null || leaf === "" ? key : displayLeaf(key, leaf).replace(/(\[\d+\])+$/, "");
    out.push({
      kind: "policy-key",
      subject,
      message: !had
        ? `new top-level key ${key} is not declared in policy.mutable or policy.additive`
        : !has
          ? `frozen top-level key ${key} was removed`
          : `frozen key ${subject} changed — declare ${key} under policy.mutable or policy.additive to permit this`,
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
    // The verifier trailer check applies to deletions too — a `git rm`
    // commit can carry the pair like any other touch (RFC-1615 review CX-25).
    if (await repo.lastTouchIsVerifier(head, rel)) continue;
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
  changed: string[],
): Promise<Weakening[]> {
  return globAdditions(
    repo,
    base,
    head,
    frozen.baseFiles,
    frozen.baseFilesComplete,
    frozen.supportGlobs,
    "frozen-file",
    "a frozen support glob",
    changed,
  );
}

/**
 * RFC-1615: files new at HEAD matching a base `policy.freezeFiles` glob —
 * an agent must not extend a frozen surface (new hook, new workflow) without
 * a verifier commit.
 */
export async function policyFileAdditions(
  repo: GateRepo,
  base: string,
  head: string,
  frozen: FrozenSet,
  changed: string[],
): Promise<Weakening[]> {
  return globAdditions(
    repo,
    base,
    head,
    frozen.baseFiles,
    frozen.baseFilesComplete,
    frozen.policyGlobs,
    "policy-file",
    "a policy.freezeFiles glob",
    changed,
  );
}

async function globAdditions(
  repo: GateRepo,
  base: string,
  head: string,
  baseFiles: string[],
  baseComplete: boolean,
  globs: string[],
  kind: string,
  globLabel: string,
  changed: string[],
): Promise<Weakening[]> {
  if (globs.length === 0) return [];
  const before = new Set(baseFiles);
  const matchers = globs.map((g) => picomatch(normalizeRelPath(g), { dot: true }));
  const out: Weakening[] = [];
  // Enumeration is the primary source; when `ls-tree` fails the diff still
  // names every touched path — git skips identical subtrees, so a corrupt
  // off-path object cannot hide an addition (CX-59). `files()` flagged the
  // failure in repo.unreadableReads already.
  const u0 = repo.unreadableReads.length;
  const headFiles = await repo.files(head);
  const enumerated = repo.unreadableReads.length === u0;
  const candidates = enumerated ? headFiles : changed;
  for (const rel of candidates) {
    if (before.has(rel) || !matchers.some((m) => m(rel))) continue;
    // Membership at base is judged per-path whenever ANY enumeration is
    // incomplete — the HEAD-fallback because `before` is the only source,
    // the base-failure because a partial `baseFiles` is not evidence of an
    // addition (a changed path that existed at base is an edit —
    // byteWeakenings' domain — never a fabricated "new file", CX-76).
    if (!enumerated || !baseComplete) {
      const u0b = repo.unreadableReads.length;
      const atBase = await repo.blob(base, rel);
      if (atBase !== null) continue;
      // The path-scoped read failed too — "new file" is a claim the failed
      // read cannot support; the flag carries the refusal (same class CX-75).
      if (repo.unreadableReads.length > u0b) continue;
    }
    if (await repo.lastTouchIsVerifier(head, rel)) continue;
    out.push({
      kind,
      subject: rel,
      message: `new file ${rel} matches ${globLabel} and was not added by a verifier commit`,
    });
  }
  return out;
}

/**
 * Anchor weakenings judged at the HEAD COMMIT (RFC-1615 review CX-37): the
 * anchor text comes from `git show`, never the worktree — an uncommitted
 * reword can neither mask a committed weakening nor fabricate one.
 */
export async function anchorWeakenings(
  repo: GateRepo,
  head: string,
  frozen: FrozenSet,
  changed: string[],
): Promise<Weakening[]> {
  if (frozen.anchors.size === 0) return [];
  const wanted = new Set(frozen.anchors.keys());
  const copies = new Map<string, string[]>();
  // No full-tree grep — an anchor can only change inside a CHANGED file, so
  // the head scan is the changed anchor-source files: a corrupt off-path
  // tree cannot blind the judgement (CX-59). Carriers absent from `changed`
  // keep their base copies implicitly.
  const changedSet = new Set(changed);
  // A changed file whose content cannot be read might carry a surviving
  // copy — `anchor-removed` is a claim the failed read cannot support, so
  // the flag carries the refusal and the claim is suppressed (CX-75).
  const scanFailed: string[] = [];
  for (const rel of changed) {
    if (!isAnchorSourceCandidate(rel)) continue;
    const u0 = repo.unreadableReads.length;
    const text = await repo.show(head, rel);
    if (repo.unreadableReads.length > u0) scanFailed.push(rel);
    if (!text) continue;
    for (const a of anchorsFromSource(rel, text)) {
      if (!wanted.has(a.id)) continue;
      const list = copies.get(a.id) ?? [];
      list.push(a.statement);
      copies.set(a.id, list);
    }
  }
  const out: Weakening[] = [];
  for (const [id, shas] of frozen.anchors) {
    const now = copies.get(id) ?? [];
    // Carriers absent from `changed` keep their base copies implicitly — a
    // marker dropped from one of several carriers is not an anchor removal
    // while any other carrier stays untouched (CX-68).
    const carriers = [...(frozen.anchorCarriers.get(id) ?? [])];
    const allTouched = carriers.length > 0 && carriers.every((rel) => changedSet.has(rel));
    if (now.length === 0 && allTouched && scanFailed.length === 0)
      out.push({ kind: "anchor-removed", subject: id, message: `frozen anchor ${id} was removed` });
    // Every changed copy must keep a statement the id carried at base — a
    // duplicate comment carrying the old text must not mask a reworded real
    // anchor, and a divergent base copy is frozen by its own sha (CX-70).
    else if (now.length > 0 && !now.every((s) => shas.has(invariantStatementSha(s)))) {
      out.push({
        kind: "anchor-reworded",
        subject: id,
        message: `frozen anchor ${id} statement changed`,
      });
    }
  }
  return out;
}

/**
 * Mode weakenings (RFC-1615 review CX-54): `git update-index --chmod` (or a
 * plain `chmod` + commit) flips a frozen file's git mode while the blob stays
 * byte-equal — invisible to the byte comparison. A `100755 → 100644` flip on
 * a frozen `hooks/**` script removes its executability: a real weakening of
 * the surface the freeze protects. Only blob-equal flips report — a content
 * change is already the byte weakening.
 */
export async function modeWeakenings(
  repo: GateRepo,
  base: string,
  head: string,
  files: string[],
): Promise<Weakening[]> {
  if (files.length === 0) return [];
  const wanted = new Set(files);
  const entries = async (rev: string): Promise<Map<string, { mode: string; sha: string }>> => {
    const map = new Map<string, { mode: string; sha: string }>();
    // Path-scoped reads — `ls-tree -r` enumerates every tree and loses the
    // whole judgement to a corrupt off-path object, while `rev -- path`
    // resolves only the trees along each wanted file (CX-59). `:(literal)`
    // so glob-metachar filenames cannot match siblings (CX-26).
    for (let i = 0; i < files.length; i += 200) {
      const out = await repo.listing(
        ["ls-tree", "-z", rev, "--", ...files.slice(i, i + 200).map((p) => `:(literal)${p}`)],
        `ls-tree ${rev}`,
      );
      if (out === null) return map;
      for (const line of out.split("\0")) {
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        const rel = line.slice(tab + 1);
        if (!wanted.has(rel)) continue;
        const [mode, , sha] = line.slice(0, tab).split(" ");
        if (mode && sha) map.set(rel, { mode, sha });
      }
    }
    return map;
  };
  const [before, after] = await Promise.all([entries(base), entries(head)]);
  const out: Weakening[] = [];
  for (const rel of files) {
    const b = before.get(rel);
    const a = after.get(rel);
    if (!b || !a || b.mode === a.mode || b.sha !== a.sha) continue;
    if (await repo.lastTouchIsVerifier(head, rel)) continue;
    out.push({
      kind: "frozen-file",
      subject: rel,
      message: `frozen file ${rel} mode changed ${b.mode} → ${a.mode} (blob byte-equal) without a verifier commit`,
    });
  }
  return out;
}
