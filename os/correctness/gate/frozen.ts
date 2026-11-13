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
  <item>RFC-1580: initial frozen set and weakening diff.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
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
  };
}

const TIER_RANK: Record<string, number> = { standard: 0, high: 1, formal: 2 };

export interface FrozenSet {
  base: CorrectnessSide;
  /** Frozen file paths (oracles, captures, sidecars, support matches) at base. */
  files: string[];
  /** Anchor id → normalized statement sha at base (anchors bound by base entries). */
  anchors: Map<string, string>;
  /** Requirement + DNA ids that existed at base (deferred exemptions for them are weakenings). */
  baseRefs: Set<string>;
}

export async function readFrozenSet(repo: GateRepo, base: string): Promise<FrozenSet> {
  const forgeYaml = await repo.show(base, "forge.yaml");
  const manifests = new Map<string, string | null>();
  const baseManifestPath = sideFrom(forgeYaml, () => null).manifestPath;
  if (baseManifestPath)
    manifests.set(baseManifestPath, await repo.show(base, normalizeRelPath(baseManifestPath)));
  const side = sideFrom(forgeYaml, (rel) => manifests.get(rel) ?? null);
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
  return { base: side, files: [...files].sort(), anchors, baseRefs };
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
    if ([...n.anchors].sort().join(",") !== [...e.anchors].sort().join(","))
      add("entry-changed", e.id, `${e.id} anchors changed`);
    const nowOracles = new Map(n.oracles.map((o) => [normalizeCheckRef(o.check), o]));
    for (const o of e.oracles) {
      const m = nowOracles.get(normalizeCheckRef(o.check));
      if (!m)
        add("oracle-removed", `${e.id}:${o.check}`, `${e.id} lost (or rebound) oracle ${o.check}`);
      else if (substrateRank(m.substrate) < substrateRank(o.substrate)) {
        add(
          "substrate-lowered",
          `${e.id}:${o.check}`,
          `${e.id} oracle ${o.check} substrate lowered from ${o.substrate} to ${m.substrate}`,
        );
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

/** Byte-change weakenings: a frozen file whose blob differs at HEAD, unless a verifier commit made the last change. */
export async function byteWeakenings(
  repo: GateRepo,
  base: string,
  head: string,
  files: string[],
): Promise<Weakening[]> {
  const out: Weakening[] = [];
  for (const rel of files) {
    const before = await repo.blob(base, rel);
    const after = await repo.blob(head, rel);
    if (before === after) continue;
    if (after !== null && (await repo.lastTouchIsVerifier(head, rel))) continue;
    out.push({
      kind: "frozen-file",
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
export function anchorWeakenings(root: string, files: string[], frozen: FrozenSet): Weakening[] {
  if (frozen.anchors.size === 0) return [];
  const index = buildAnchorIndex(root, files, [...frozen.anchors.keys()]);
  const out: Weakening[] = [];
  for (const [id, sha] of frozen.anchors) {
    const now = index.anchors.get(id) ?? [];
    if (now.length === 0)
      out.push({ kind: "anchor-removed", subject: id, message: `frozen anchor ${id} was removed` });
    else if (!now.some((a) => invariantStatementSha(a.statement) === sha)) {
      out.push({
        kind: "anchor-reworded",
        subject: id,
        message: `frozen anchor ${id} statement changed`,
      });
    }
  }
  return out;
}
