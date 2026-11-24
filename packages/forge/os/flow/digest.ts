/*
<MODULE_CONTRACT>
<purpose>Risk digest of the unpushed outbound state (RFC-1491): the unpushed
develop tail segmented into journal-attributed items, risk categories from
each item's diff, new release tags versus origin and held registry
branches — fingerprinted into a digestId that flow.push must quote.
Journal records are suppressor-only (R13-C): they can hide a tag from
digest.tags but never mint pending/superseded publication entries, which
stay empty by construction.</purpose>
<non-goals>
  <item>No mutation — the only write is the optional git fetch of remote-tracking refs.</item>
  <item>No push or publish policy — handlers/flow-push.ts owns outbound execution.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The unpushed tail's anchor (origin tip or oldest unpushed parent) counts as record base.</item>
  <item>Overlapping journal records resolve newest-tail-first — a stale record never covers commits a newer owns.</item>
  <item>Remote tags come from `git ls-remote --tags origin`; on failure remote-known = commit is ancestor of remote tip.</item>
  <item>RFC frontmatter is read only via listRfcFiles/readRfcFrontmatter (RFC-1465 door) — never re-parsed locally.</item>
  <item>tagTriggers feeds digestId — a workflow change between digest and push invalidates the quoted id; unparseable patterns warn never block.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: close RFC-1616 r12 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r16 trust-boundary counterexamples</item>
  <item>RFC-1616: close r20 counterexamples CX-173 through CX-177</item>
  <item>RFC-1633: serialize evidence consults + bestEffort reader mode (RFC-1633)</item>
  <history>RFC-1491, RFC-1498, RFC-1503, RFC-1580, RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { listRfcFiles, readRfcFrontmatter, rfcFileMatchesId } from "../rfc/frontmatter-io.ts";
import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";
import { EVIDENCE_REFUSED_PREFIX } from "../../src/utils/verifier-git.ts";
import { git, gitEvidence, evidencePreflight, parseGitTrailers } from "./git.ts";
import {
  commonGitDir,
  readJournal,
  readRegistry,
  RISK_CATEGORIES,
  type FlowJournalEvent,
  type RiskCategory,
} from "./registry.ts";
import { discoverReleaseLines, type ReleaseLine } from "./release-lines.ts";
import { parseVersion, type SemVer } from "./semver.ts";
import { listLineTags } from "./release-tags.ts";
import { primaryWorktree } from "./worktree-path.ts";

export interface FlowDigestItem {
  id: string; // "I-<first 9 hex of tip>"
  kind: "integration" | "backmerge" | "release" | "unattributed";
  branch: string | null;
  base: string;
  tip: string;
  commits: number;
  subjects: string[]; // first line of each commit, oldest first
  rfcs: string[];
  category: RiskCategory;
  flags: RiskCategory[];
}

export interface FlowDigestData {
  digestId: string;
  remote: "origin";
  /**
   * Whether the digest contacted the remote this run. Structurally
   * `false` since CX-132: the evidence channel refuses every transport
   * because every remote target is session-authored, so remote-derived
   * state is never consulted for a judgment.
   */
  fetched: boolean;
  /**
   * Whether `develop.remote`/`main.remote` came from a verified remote
   * answer. Structurally `false` since CX-132 — they are always the
   * session-mutable `refs/remotes/origin/*` tracking refs (CX-82): a
   * display-only preview a planted ref can shape, never a judgment
   * input. The push-side verifier scan always widens to the whole local
   * branch instead of trusting them as a range base.
   */
  remoteVerified: boolean;
  develop: { local: string; remote: string | null; ahead: number };
  main: { local: string; remote: string | null; ahead: number };
  tags: string[];
  items: FlowDigestItem[]; // oldest first
  byCategory: Record<RiskCategory, string[]>;
  held: Array<{
    branch: string;
    tip: string;
    reason: string;
    riskCategory: RiskCategory;
    heldAt: string;
  }>;
  /**
   * RFC-1503/R13-C: always empty — a journal `push` record can only
   * suppress a tag from `tags`, never mint a pending publication, so
   * "pushed but unpublished" has no honest local source and stays out
   * of the candidate set. Field kept for the digest shape.
   */
  pendingPublications: Array<{ tag: string; line: string }>;
  /**
   * RFC-1503/R13-C: always empty — same suppressor-only reason as
   * `pendingPublications`; in-run supersession lives inside flow.push's
   * plan, not the digest.
   */
  supersededPublications: Array<{ tag: string; line: string; by: string | null }>;
  /**
   * RFC-1498: CI workflows a push of each digest tag would start —
   * `.github/workflows` files whose `on.push.tags` filter matches the tag
   * name (repo-relative paths, sorted). Only tags with at least one match
   * get an entry.
   */
  tagTriggers: Array<{ tag: string; workflows: string[] }>;
  /**
   * RFC-1580: the correctness trail of the unpushed develop range — every
   * `X-Correctness-Weakening` trailer (an accepted weakening) and every
   * verifier-trailer commit (`X-Expectation-Origin: independent-verifier`),
   * so the operator sees both at the flow.push hard stop.
   */
  correctnessTrail: {
    weakenings: Array<{ sha: string; subject: string; reason: string }>;
    verifierCommits: Array<{ sha: string; subject: string; report: string | null }>;
  };
  diagnostics: Diagnostic[];
}

const RFC_DIR = "docs/rfcs";
const DEFAULT_SPECS_DIR = "docs/specs";
const DEFAULT_INVARIANTS_FILE = "docs/architecture-dna.md";

async function revParse(repoRoot: string, io: WorkspaceIO, ref: string): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  // exit -1 means the channel produced no git answer at all (refusal,
  // timeout, spawn failure) — "ref absent" is a fabrication from that
  // (CX-174: a null developLocal empties the tail AND the trailer
  // scan). git's own non-zero answers (missing ref, non-repo) stay the
  // honest null.
  if (result.exitCode === -1) {
    throw new Error(
      `git rev-parse --verify ${ref} produced no answer — the ref is unverifiable: ${result.stderr.trim()}`,
    );
  }
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

/**
 * Oldest→newest commits of `branch` not reachable from `remoteTip` — or not
 * reachable from `verifiedExcludes` (remote heads ls-remote actually
 * answered) when no verified tip exists for the branch. `verifiedExcludes`
 * `null` selects the legacy `--not --remotes=origin` exclusion (the
 * `--no-fetch` preview path, where tracking refs are all there is); a
 * non-null set is required on the fetched path because
 * `refs/remotes/origin/*` is session-mutable — a planted ref under `--not
 * --remotes=origin` would hide commits the same way a planted branch tip
 * does (CX-61). A failed range read widens to the whole branch rather
 * than returning an empty tail: `[]` would skip the verifier scan, so the
 * only safe failure is scanning more, never less. When even the widened
 * read fails the tail is UNPROVABLE — `null`, never `[]`, or a surgical
 * refusal between preflight and spawn could empty the scan on demand
 * (CX-174).
 */
async function unpushedCommits(
  repoRoot: string,
  io: WorkspaceIO,
  branch: string,
  remoteTip: string | null,
  firstParent = false,
  verifiedExcludes: string[] | null = null,
): Promise<string[] | null> {
  const order = firstParent ? ["--reverse", "--first-parent"] : ["--reverse"];
  const lines = (stdout: string) =>
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  if (remoteTip !== null) {
    const ranged = await gitEvidence(repoRoot, ["rev-list", ...order, `${remoteTip}..${branch}`]);
    if (ranged.exitCode === 0) return lines(ranged.stdout);
    // The verified tip could not serve as the range base — widen to the
    // whole branch. Excluding nothing is the strictest honest answer.
    const widened = await gitEvidence(repoRoot, ["rev-list", ...order, branch]);
    return widened.exitCode === 0 ? lines(widened.stdout) : null;
  }
  const args =
    verifiedExcludes !== null
      ? verifiedExcludes.length > 0
        ? ["rev-list", ...order, branch, "--not", ...verifiedExcludes]
        : ["rev-list", ...order, branch]
      : ["rev-list", ...order, branch, "--not", "--remotes=origin"];
  const result = await gitEvidence(repoRoot, args);
  if (result.exitCode !== 0) return null;
  return lines(result.stdout);
}

/** forge.yaml `paths.specsDir` and `bindings.paths.invariantsFile` with the RFC-1491 defaults. */
async function readPathConfig(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<{ specsDir: string; invariantsFile: string }> {
  const file = join(repoRoot, "forge.yaml");
  if (!(await io.exists(file))) {
    return { specsDir: DEFAULT_SPECS_DIR, invariantsFile: DEFAULT_INVARIANTS_FILE };
  }
  try {
    const parsed = parseYaml(await io.readFile(file)) as {
      paths?: { specsDir?: unknown };
      bindings?: { paths?: { invariantsFile?: unknown } };
    } | null;
    return {
      specsDir:
        typeof parsed?.paths?.specsDir === "string" && parsed.paths.specsDir.length > 0
          ? parsed.paths.specsDir
          : DEFAULT_SPECS_DIR,
      invariantsFile:
        typeof parsed?.bindings?.paths?.invariantsFile === "string" &&
        parsed.bindings.paths.invariantsFile.length > 0
          ? parsed.bindings.paths.invariantsFile
          : DEFAULT_INVARIANTS_FILE,
    };
  } catch {
    return { specsDir: DEFAULT_SPECS_DIR, invariantsFile: DEFAULT_INVARIANTS_FILE };
  }
}

/**
 * The `push.*` declarations the remote-identity anchor trusts — read from
 * the COMMITTED `HEAD:forge.yaml` on the evidence channel, the way
 * `push.requireVerifierReview` already is (CX-34): a worktree edit is
 * session state, and a session able to rewrite `push.expectedRemote`
 * could anchor the anchor itself to its own remote (CX-80).
 */
async function readCommittedPushConfig(
  repoRoot: string,
): Promise<{ expectedRemote?: string } | null> {
  const show = await gitEvidence(repoRoot, ["show", "HEAD:forge.yaml"]);
  if (show.exitCode !== 0) {
    // A channel refusal (-1) means the committed anchor is UNPROVABLE —
    // `{}` would misreport "not declared" and skip the anchor as absent
    // rather than unverifiable (CX-174). git's own failure (file absent,
    // no HEAD) stays the honest empty config.
    if (show.exitCode === -1) return null;
    return {};
  }
  try {
    const doc = parseYaml(show.stdout) as { push?: { expectedRemote?: unknown } } | null;
    const v = doc?.push?.expectedRemote;
    return typeof v === "string" && v.length > 0 ? { expectedRemote: v } : {};
  } catch {
    return {};
  }
}

/**
 * RFC-1580: weakening and verifier trailers among the given commits (oldest
 * first). Delimiter-free per-commit reads — a \x1e/\x1f byte inside a commit
 * message cannot split a record and hide the trailer tail (CX-33) — and the
 * trailer keys come from git's own `%(trailers)` parser, so `key :` and
 * lowercase spellings cannot evade the scan while `git interpret-trailers`
 * still counts them (CX-60).
 */
async function correctnessTrailOf(
  repoRoot: string,
  io: WorkspaceIO,
  shas: string[],
): Promise<FlowDigestData["correctnessTrail"]> {
  const trail: FlowDigestData["correctnessTrail"] = { weakenings: [], verifierCommits: [] };
  for (const sha of shas) {
    // Two reads per commit — any delimiter byte shared between subject and
    // the trailer blob could smuggle a record boundary (CX-33 class). A
    // FAILED read on an enumerated commit is unverifiable, never skippable
    // — `continue` would drop its weakening/verifier trailers under a
    // surgical refusal between spawns (CX-174). List the sha flagged like
    // the non-UTF-8 encoding case: provenance unprovable.
    const subj = await gitEvidence(repoRoot, ["log", "-1", "--format=%s", sha]);
    if (subj.exitCode !== 0) {
      trail.verifierCommits.push({ sha, subject: "(unverifiable commit)", report: null });
      continue;
    }
    // `%e` rides along: a declared non-UTF-8 `encoding:` header recodes
    // %s/%(trailers) output into bytes the scan cannot trust — the header
    // lives inside the commit object so no -c pin can strip it (CX-102).
    // Such a commit's provenance is unverifiable — list it flagged.
    const trailers = await gitEvidence(repoRoot, [
      "log",
      "-1",
      "--format=%(trailers:only,separator=%x00)%x00%e",
      sha,
    ]);
    if (trailers.exitCode !== 0) {
      trail.verifierCommits.push({ sha, subject: subj.stdout.trim(), report: null });
      continue;
    }
    const trailerParts = trailers.stdout.split("\x00");
    const declaredEncoding = (trailerParts.pop() ?? "").trim();
    const subject = subj.stdout.trim();
    if (declaredEncoding.length > 0 && !/^utf-?8$/i.test(declaredEncoding)) {
      trail.verifierCommits.push({ sha, subject, report: null });
      continue;
    }
    const entries = parseGitTrailers(trailerParts.join("\x00").replaceAll("\x00", "\n"));
    const byKey = new Map<string, string>();
    for (const t of entries) if (!byKey.has(t.key)) byKey.set(t.key, t.value);
    const weak = byKey.get("x-correctness-weakening");
    if (weak !== undefined) trail.weakenings.push({ sha, subject, reason: weak });
    // A trailer-shaped subject is not a git trailer on every version but is
    // provenance text — count it like the push scan does (CX-23 parity).
    const subjTrailer = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(subject);
    const subjKey = subjTrailer?.[1]?.trim().toLowerCase();
    if (
      byKey.has("x-expectation-origin") ||
      byKey.has("x-verifier-report") ||
      byKey.has("x-policy-digest") ||
      subjKey === "x-expectation-origin" ||
      subjKey === "x-verifier-report" ||
      subjKey === "x-policy-digest"
    ) {
      // Any verifier-evidence trailer claims provenance the session cannot
      // self-certify — a lone X-Verifier-Report must list too, not only the
      // full expectation-origin pair (CX-33).
      const report =
        byKey.get("x-verifier-report") ??
        (subjKey === "x-verifier-report" ? subjTrailer![2]!.trim() : null);
      trail.verifierCommits.push({ sha, subject, report });
    }
  }
  return trail;
}

/** X-RFC trailer ids + subjects of the commits in (base, tip], oldest first. */
async function commitMeta(
  repoRoot: string,
  io: WorkspaceIO,
  base: string,
  tip: string,
): Promise<{ subjects: string[]; rfcs: string[] } | null> {
  const result = await gitEvidence(repoRoot, [
    "log",
    "--reverse",
    "--format=%s%x00%(trailers:key=X-RFC,valueonly,separator=%x20)",
    `${base}..${tip}`,
  ]);
  // Unverifiable, not empty — a surgical refusal must not present a
  // commit range with zero subjects/rfc trailers (CX-174).
  if (result.exitCode === -1) return null;
  if (result.exitCode !== 0) return { subjects: [], rfcs: [] };
  const subjects: string[] = [];
  const rfcs = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [subject, trailers] = line.split("\0");
    if (subject !== undefined && subject.length > 0) subjects.push(subject);
    for (const token of (trailers ?? "").split(/\s+/)) {
      if (/^RFC-\d+$/i.test(token)) rfcs.add(token.toUpperCase());
    }
  }
  return { subjects, rfcs: [...rfcs].sort() };
}

/** Frontmatter of every RFC named by id — `{versionBump, commandsRemoved}` per id. */
async function rfcFacts(
  repoRoot: string,
  ids: string[],
): Promise<Map<string, { versionBump: string | null; commandsRemoved: boolean }>> {
  const facts = new Map<string, { versionBump: string | null; commandsRemoved: boolean }>();
  if (ids.length === 0) return facts;
  const rfcDirPath = join(repoRoot, RFC_DIR);
  const files = await listRfcFiles(rfcDirPath);
  for (const id of ids) {
    const fileName = files.find((f) => rfcFileMatchesId(f, id));
    if (fileName === undefined) {
      facts.set(id, { versionBump: null, commandsRemoved: false });
      continue;
    }
    const parsed = await readRfcFrontmatter(rfcDirPath, fileName);
    const fm =
      parsed && "parsed" in parsed ? (parsed.parsed.frontmatter as Record<string, unknown>) : {};
    const idExact =
      String(fm["id"] ?? "")
        .trim()
        .toUpperCase() === id;
    const bump = typeof fm["versionBump"] === "string" ? fm["versionBump"] : null;
    const commands = fm["commands"];
    const removed =
      idExact &&
      typeof commands === "object" &&
      commands !== null &&
      Array.isArray((commands as { removed?: unknown }).removed) &&
      (commands as { removed: unknown[] }).removed.length > 0;
    facts.set(id, {
      versionBump: idExact ? bump : null,
      commandsRemoved: removed,
    });
  }
  return facts;
}

/** `git show <ref>:<path>` → parsed JSON, null when absent/unparseable. */
async function jsonAtRef(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  const result = await gitEvidence(repoRoot, ["show", `${ref}:${path}`], {
    mode: "bestEffort",
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/** Major number of a semver spec, ignoring ^ ~ >= and whitespace; null for non-semver. */
function specMajor(spec: unknown): number | null {
  if (typeof spec !== "string") return null;
  const cleaned = spec.trim().replace(/^(\^|~|>=?)\s*/, "");
  const match = cleaned.match(/^(\d+)\.\d+\.\d+/);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

/**
 * Package-json risk signals of an item touching `path`: a removed `exports`
 * key (capability-removal) or a raised dependency major (major-dependency).
 */
async function packageJsonSignals(
  repoRoot: string,
  io: WorkspaceIO,
  base: string,
  tip: string,
  path: string,
): Promise<{ exportsRemoved: boolean; majorRaised: boolean }> {
  const before = await jsonAtRef(repoRoot, io, base, path);
  const after = await jsonAtRef(repoRoot, io, tip, path);
  if (before === null || after === null) return { exportsRemoved: false, majorRaised: false };

  const beforeExports = before["exports"];
  const afterExports = after["exports"];
  const exportsRemoved =
    typeof beforeExports === "object" &&
    beforeExports !== null &&
    typeof afterExports === "object" &&
    afterExports !== null &&
    Object.keys(beforeExports).some(
      (key) => !Object.prototype.hasOwnProperty.call(afterExports, key),
    );

  let majorRaised = false;
  for (const section of DEP_SECTIONS) {
    const b = before[section];
    const a = after[section];
    if (typeof b !== "object" || b === null || typeof a !== "object" || a === null) continue;
    for (const [dep, spec] of Object.entries(a as Record<string, unknown>)) {
      const oldMajor = specMajor((b as Record<string, unknown>)[dep]);
      const newMajor = specMajor(spec);
      if (oldMajor !== null && newMajor !== null && newMajor > oldMajor) {
        majorRaised = true;
      }
    }
  }
  return { exportsRemoved: exportsRemoved === true, majorRaised };
}

/** Risk classification of the diff `base..tip` — first match wins; flags hold all matches. */
async function classifyItem(
  repoRoot: string,
  io: WorkspaceIO,
  base: string,
  tip: string,
  rfcs: string[],
  specsDir: string,
  invariantsFile: string,
  diagnostics: Diagnostic[],
): Promise<{ category: RiskCategory; flags: RiskCategory[] }> {
  const flags = new Set<RiskCategory>();

  // `diff` is refused categorically under an unproven index even though a
  // two-commit diff never consults it — `log --name-only` answers the same
  // touched-file set from commit objects alone (a superset: it also lists
  // files a later commit reverted). A refused names read must never
  // degrade to files=[] — that silently narrows the classification
  // (CX-155: a contract-touching item labelled "other").
  const names = await gitEvidence(repoRoot, ["diff", "--name-only", base, tip], {
    mode: "bestEffort",
  });
  const splitNames = (stdout: string) =>
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  let files: string[];
  if (names.exitCode === 0) {
    files = splitNames(names.stdout);
  } else {
    const listed = await gitEvidence(repoRoot, [
      "log",
      "--name-only",
      "-m",
      "--format=",
      `${base}..${tip}`,
    ]);
    if (listed.exitCode === 0) {
      files = splitNames(listed.stdout);
    } else {
      files = [];
      diagnostics.push({
        ruleId: "FLOW-PUSH-13",
        severity: "error",
        message: `risk classification for ${base.slice(0, 9)}..${tip.slice(0, 9)} is unverifiable — the evidence channel refused every file enumeration (${listed.stderr.trim() || names.stderr.trim()})`,
        fixHint: `restore the repository's index/config surface and re-run flow.digest`,
      });
    }
  }
  const specsPrefix = `${specsDir.replace(/\/+$/, "")}/`;
  if (
    files.some(
      (f) =>
        f.startsWith(specsPrefix) || f.endsWith(".schema.json") || f.split("/").includes("schemas"),
    )
  ) {
    flags.add("contract");
  }
  if (files.some((f) => f === invariantsFile || f.endsWith(".proof.yaml"))) {
    flags.add("invariant");
  }

  const facts = await rfcFacts(repoRoot, rfcs);
  for (const fact of facts.values()) {
    if (fact.versionBump === "minor" || fact.versionBump === "major") flags.add("migration");
    if (fact.commandsRemoved) flags.add("capability-removal");
  }

  // @ai-invariant lines in the added/removed set — zero-context diff keeps
  // the scan tight. --no-textconv/--no-ext-diff: a repo-config filter must
  // not rewrite what the diff reports (CX-50 class — config channels are
  // scrubbed, this closes the repo-config half too).
  const diff = await gitEvidence(
    repoRoot,
    ["diff", "--unified=0", "--no-color", "--no-textconv", "--no-ext-diff", base, tip],
    {
      mode: "bestEffort",
    },
  );
  let diffOut: string | null = diff.exitCode === 0 ? diff.stdout : null;
  if (diffOut === null) {
    // Same refused-diff fallback as the names read — per-commit patches
    // from `log -U0` carry the @ai-invariant lines without the index.
    const ld = await gitEvidence(repoRoot, [
      "log",
      "--unified=0",
      "--no-color",
      "-m",
      "--format=",
      `${base}..${tip}`,
    ]);
    if (ld.exitCode === 0) {
      diffOut = ld.stdout;
    } else {
      diagnostics.push({
        ruleId: "FLOW-PUSH-13",
        severity: "error",
        message: `invariant-line scan for ${base.slice(0, 9)}..${tip.slice(0, 9)} is unverifiable — the evidence channel refused every diff read`,
        fixHint: `restore the repository's index/config surface and re-run flow.digest`,
      });
    }
  }
  if (diffOut !== null) {
    for (const line of diffOut.split("\n")) {
      if ((line.startsWith("+") || line.startsWith("-")) && line.includes("@ai-invariant")) {
        flags.add("invariant");
        break;
      }
    }
  }

  for (const file of files) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    const signals = await packageJsonSignals(repoRoot, io, base, tip, file);
    if (signals.exportsRemoved) flags.add("capability-removal");
    if (signals.majorRaised) flags.add("major-dependency");
  }

  const ordered = RISK_CATEGORIES.filter((c) => c !== "other" && flags.has(c));
  return { category: ordered[0] ?? "other", flags: ordered };
}

interface AttributedRecord {
  branch: string;
  kind: "integration" | "backmerge" | "release";
  base: string;
  tip: string;
}

/**
 * The newest journal record per branch among integrate/backmerge/cut and
 * hold.rewrites (later journal lines win — the journal is append-only).
 */
function attributedRecords(journal: FlowJournalEvent[]): AttributedRecord[] {
  const byBranch = new Map<string, AttributedRecord>();
  for (const event of journal) {
    if (event.event === "integrate" || event.event === "backmerge") {
      const kind =
        event.event === "backmerge" || event.branch.startsWith("auto/port-")
          ? "backmerge"
          : "integration";
      byBranch.set(event.branch, {
        branch: event.branch,
        kind,
        base: event.base ?? "",
        tip: event.sha,
      });
    } else if (event.event === "cut") {
      byBranch.set(event.branch, {
        branch: event.branch,
        kind: "release",
        base: event.base ?? "",
        tip: event.sha,
      });
    } else if (event.event === "hold" && Array.isArray(event.rewrites)) {
      for (const rewrite of event.rewrites) {
        byBranch.set(rewrite.branch, {
          branch: rewrite.branch,
          kind: rewrite.kind,
          base: rewrite.base,
          tip: rewrite.sha,
        });
      }
    }
  }
  return [...byBranch.values()];
}

const WORKFLOWS_DIR = join(".github", "workflows");

/**
 * The `on.push.tags` patterns of one parsed workflow document (RFC-1498).
 * Only a mapping `on:` with `push.tags` yields patterns — `on: push`,
 * `on: [push, …]` and `push:` without `tags` trigger on branches, not
 * tags. `on` may arrive as the boolean `true` when the file was authored
 * for YAML 1.1 semantics.
 */
function pushTagPatterns(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const rec = parsed as Record<string, unknown>;
  const on = rec["on"] ?? rec["true"];
  if (typeof on !== "object" || on === null || Array.isArray(on)) return [];
  const push = (on as Record<string, unknown>)["push"];
  if (typeof push !== "object" || push === null || Array.isArray(push)) return [];
  const tags = (push as Record<string, unknown>)["tags"];
  if (typeof tags === "string") return [tags];
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string");
  return [];
}

/**
 * GitHub glob → regex for the tag-name subset Forge evaluates (RFC-1498):
 * `*` within a segment, `**` across segments, `?` one char. Returns null
 * for patterns we do not understand — `[` character classes and leading
 * `!` negations — so the caller can report them instead of guessing.
 */
export function tagPatternRegex(pattern: string): RegExp | null {
  if (pattern.startsWith("!") || pattern.includes("[")) return null;
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else {
      out += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Tag-trigger patterns of every `.github/workflows/*.y{ml,aml}` file under
 * `dir` (RFC-1498), repo-relative file paths. A file that cannot be read
 * or parsed reports FLOW-11 and contributes nothing; a pattern the glob
 * subset does not cover reports FLOW-11 and matches nothing.
 */
async function workflowTagPatterns(
  dir: string,
  io: WorkspaceIO,
  diagnostics: Diagnostic[],
): Promise<Array<{ file: string; patterns: string[] }>> {
  const workflows: Array<{ file: string; patterns: string[] }> = [];
  if (!(await io.exists(dir))) return workflows;
  const entries = await io.readdir(dir).catch(() => []);
  const names = entries
    .filter((e) => e.isFile && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    // Reported paths are repo-relative logical paths — forward slashes on
    // every platform (WORKFLOWS_DIR uses join() and is only for fs access).
    const file = `.github/workflows/${name}`;
    const text = await io.readFile(join(dir, name)).catch(() => null);
    let parsed: unknown = null;
    let ok = text !== null;
    if (text !== null) {
      try {
        parsed = parseYaml(text);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      diagnostics.push({
        ruleId: "FLOW-11",
        severity: "warning",
        file,
        message: `workflow ${file} cannot be parsed — its tag triggers are not evaluated`,
        fixHint: "fix the workflow YAML — the digest treats it as matching nothing",
      });
      continue;
    }
    const patterns = pushTagPatterns(parsed);
    for (const p of patterns) {
      if (tagPatternRegex(p) === null) {
        diagnostics.push({
          ruleId: "FLOW-11",
          severity: "warning",
          file,
          message: `workflow ${file}: tag pattern '${p}' not understood — it matches nothing`,
          fixHint: "use plain globs (*, **, ?) — character classes and negations are not evaluated",
        });
      }
    }
    if (patterns.length > 0) workflows.push({ file, patterns });
  }
  return workflows;
}

/** The release line a tag belongs to — longest prefix wins. */
export function lineForTag(lines: ReleaseLine[], tag: string): ReleaseLine | null {
  let best: ReleaseLine | null = null;
  for (const line of lines) {
    if (!tag.startsWith(line.tagPrefix)) continue;
    if (best === null || line.tagPrefix.length > best.tagPrefix.length) best = line;
  }
  return best;
}

/** Strict semver of `tag` under the line with id `lineId` — null when the
 * line is unknown, the prefix does not match, or the suffix is not X.Y.Z. */
export function versionOfTag(lines: ReleaseLine[], tag: string, lineId: string): SemVer | null {
  const line = lines.find((l) => l.id === lineId);
  if (line === undefined || !tag.startsWith(line.tagPrefix)) return null;
  return parseVersion(tag.slice(line.tagPrefix.length));
}

/** Recursively key-sorted JSON.stringify — the digestId's canonical form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Collect the outbound digest of repoRoot. The `fetch` flag is retained for
 * call-site compatibility but is inert — the trusted channel refuses every
 * transport (CX-132), so a digest never contacts a remote and `fetched` is
 * structurally false.
 */
export async function collectDigest(
  repoRoot: string,
  io: WorkspaceIO,
  _opts: { fetch: boolean },
): Promise<FlowDigestData> {
  const diagnostics: Diagnostic[] = [];

  // --- trust-boundary preflight ------------------------------------------
  // The evidence channel refuses when the session-writable repo surface
  // carries an unverifiable lever — a transport/exec config key `-c` never
  // reaches (CX-72/CX-76) or a `.git` metadata file that rewrites what a
  // read resolves (CX-79). Emitting the reasons here keeps the digest's
  // diagnostics honest instead of cascading "no origin"/"fetch failed"
  // secondaries on top of the refused channel.
  const preflight = await evidencePreflight(repoRoot);
  if (preflight === null) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-13",
      severity: "error",
      message: `repo surface could not be enumerated through the evidence channel — remote identity and history reads are unverifiable`,
      fixHint: `check the repository's .git/config is readable and re-run flow.digest`,
    });
  }
  for (const rel of preflight?.shapeViolations ?? []) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-12",
      severity: "error",
      message: `session-writable .git/${rel} is non-empty — it rewrites what rev-list/merge-base/object reads resolve and no env or config switch disables it`,
      fixHint: `remove .git/${rel} (a graft converts via 'git replace --convert-graft-file') and re-run flow.digest`,
    });
  }
  for (const key of preflight?.refusedKeys ?? []) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-13",
      severity: "error",
      message: `repo config key '${key}' is a transport/exec lever the evidence channel cannot neutralize — remote identity and history reads are unverifiable`,
      fixHint: `remove '${key}' from this repository's .git/config and re-run flow.digest`,
    });
  }
  // A refused channel answers NOTHING — every downstream read would cascade
  // through the same refusal (and commonGitDir throws on it). The digest
  // degrades to a diagnostic-only report; pushFlow's error-diagnostic
  // refuse keeps it from ever shipping (CX-72/CX-76).
  const channelRefused =
    preflight === null || preflight.refusedKeys.length > 0 || preflight.shapeViolations.length > 0;
  if (channelRefused) {
    const refusedId = createHash("sha256")
      .update(
        canonicalJson({
          refused: [...(preflight?.refusedKeys ?? []), ...(preflight?.shapeViolations ?? [])],
        }),
      )
      .digest("hex")
      .slice(0, 12);
    return {
      digestId: `refused-${refusedId}`,
      remote: "origin",
      fetched: false,
      remoteVerified: false,
      develop: { local: "", remote: null, ahead: 0 },
      main: { local: "", remote: null, ahead: 0 },
      tags: [],
      items: [],
      byCategory: Object.fromEntries(RISK_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
        RiskCategory,
        string[]
      >,
      held: [],
      pendingPublications: [],
      supersededPublications: [],
      tagTriggers: [],
      correctnessTrail: { weakenings: [], verifierCommits: [] },
      diagnostics,
    };
  }

  /** An evidence call refused because the repo surface is unverifiable — callers must not misread it as an empty answer. */
  const refused = (r: { exitCode: number | null; stderr: string }) =>
    r.exitCode !== 0 && r.stderr.startsWith(EVIDENCE_REFUSED_PREFIX);

  const pushConfig = await readCommittedPushConfig(repoRoot);
  const { expectedRemote } = pushConfig ?? {};
  if (pushConfig === null) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-13",
      severity: "error",
      message:
        "the committed forge.yaml is unverifiable — push.expectedRemote cannot anchor the trusted remote",
    });
  }

  const originProbe = await gitEvidence(repoRoot, ["remote", "get-url", "origin"]);
  const hasOrigin = originProbe.exitCode === 0;
  if (!hasOrigin && !refused(originProbe)) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-01",
      severity: "error",
      message: "no 'origin' remote — flow.push has nothing to push to",
    });
  }
  // A refused probe is NOT "no origin" — it would silently skip the
  // whole remote-identity parity and anchor block below, then a push
  // resolves session config unchecked (CX-174).
  if (refused(originProbe)) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-13",
      severity: "error",
      message:
        "'git remote get-url origin' is unverifiable — remote identity cannot be judged; parity and anchor checks skipped",
    });
  }

  // --- remote-identity parity ------------------------------------------------
  // Repo config is session-writable: `url.<x>.insteadOf` rewrites the fetch
  // target, `url.<x>.pushInsteadOf`/`remote.origin.pushurl` split the push
  // target away from it — then the judged remote is not the pushed remote
  // (CX-62/CX-63). `git config --get-all` reads the raw configured URLs;
  // `remote get-url --all` resolves them through insteadOf the way a fetch
  // does; the session channel's `remote get-url --push --all` resolves what
  // `git push origin` will actually hit — INCLUDING a second pushurl that
  // `--push` without `--all` silently drops (CX-73: the trailer commit
  // shipped to the unlisted pushurl unflagged). Any disagreement between
  // the three sets is an error — remote identity is then unprovable.
  if (hasOrigin) {
    const urlSet = (r: { exitCode: number | null; stdout: string }) =>
      r.exitCode === 0
        ? new Set(
            r.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0),
          )
        : null;
    const configured = urlSet(
      await gitEvidence(repoRoot, ["config", "--get-all", "remote.origin.url"]),
    );
    const fetchUrls = urlSet(await gitEvidence(repoRoot, ["remote", "get-url", "--all", "origin"]));
    const pushUrls = urlSet(
      await git(repoRoot, io, ["remote", "get-url", "--push", "--all", "origin"]),
    );
    const sameSet = (a: Set<string> | null, b: Set<string> | null) =>
      a !== null && b !== null && a.size === b.size && [...a].every((x) => b.has(x));
    // A null set on a proven origin is an unverifiable read — skipping
    // the parity/anchor checks silently is exactly the collapse a
    // surgical refusal produces (CX-174).
    if (configured === null || fetchUrls === null || pushUrls === null) {
      diagnostics.push({
        ruleId: "FLOW-PUSH-13",
        severity: "error",
        message:
          "the remote URL sets are unverifiable — the insteadOf-parity and expectedRemote anchor checks cannot run",
      });
    }
    if (configured !== null && fetchUrls !== null && !sameSet(configured, fetchUrls)) {
      diagnostics.push({
        ruleId: "FLOW-PUSH-09",
        severity: "error",
        message: `the fetch URLs for 'origin' are rewritten — 'remote.origin.url' configures ${JSON.stringify([...configured])} but a fetch would contact ${JSON.stringify([...fetchUrls])} (a url.insteadOf rule in session-writable config is steering the evidence channel)`,
        fixHint:
          "remove the url.<base>.insteadOf rewrite from this repository's config and re-run flow.digest",
      });
    }
    if (fetchUrls !== null && pushUrls !== null && !sameSet(fetchUrls, pushUrls)) {
      diagnostics.push({
        ruleId: "FLOW-PUSH-09",
        severity: "error",
        message: `the push resolves to different remotes than the judged fetch — a push would contact ${JSON.stringify([...pushUrls])} while the digest's evidence came from ${JSON.stringify([...fetchUrls])}`,
        fixHint:
          "reconcile remote.origin.pushurl and the url.*.(push)insteadOf rules so push and fetch resolve to the same remote set",
      });
    }
    // --- remote-identity ANCHOR (CX-80) -----------------------------------
    // Parity alone proves consistency, never provenance: a wholesale
    // `remote.origin.url` repoint keeps configured == fetch == push while
    // the pushed remote is one the session chose. `push.expectedRemote` is
    // the declared anchor — a forge.yaml key, frozen by the RFC-1615 policy
    // surface and CODEOWNERS review-gated, outside session-writable config.
    if (configured !== null && configured.size > 0) {
      if (expectedRemote === undefined) {
        diagnostics.push({
          ruleId: "FLOW-PUSH-14",
          severity: "error",
          message:
            "push.expectedRemote is not declared in forge.yaml — the trusted remote is unanchored: a session repoint cannot be distinguished from the operator's remote",
          fixHint:
            'declare `push.expectedRemote: "<canonical url>"` in forge.yaml — the frozen declaration anchors which remote flow.push may ship to',
        });
      } else if (![...configured].every((u) => u === expectedRemote)) {
        diagnostics.push({
          ruleId: "FLOW-PUSH-14",
          severity: "error",
          message: `the configured remote ${JSON.stringify([...configured])} does not match the declared 'push.expectedRemote' '${expectedRemote}' — the anchor is outside session-writable config`,
          fixHint:
            "repoint remote.origin back at the declared remote, or amend push.expectedRemote through an operator change (CODEOWNERS review-gated)",
        });
      }
    }
  }

  // Remote tips/verified state are structurally absent — untrusted
  // diagnostics only. Every remote the channel could name
  // (`remote.origin.url`, `branch.<b>.remote`, a literal positional) is
  // session-authored under the same-uid threat model, so a transport
  // answer can never be trusted evidence and the evidence channel
  // refuses `ls-remote`/`fetch` outright (CX-132) — nothing in the push
  // decision derives from remote state anymore. `remoteVerified` stays
  // false and the verifier-trailer scan always covers the full local
  // branch — the strictly stronger judgment.
  const fetched = false;

  const developLocal = await revParse(repoRoot, io, "develop");
  const mainLocal = await revParse(repoRoot, io, "main");
  // The "remote" tips are always the session-mutable tracking refs —
  // verified remote tips cannot exist (CX-132). A planted
  // `refs/remotes/origin/*` can hide commits from the tail exactly like
  // a planted remote tip did (CX-61): the tail/items/ahead fields are
  // therefore display-only diagnostics, and the push-side verifier scan
  // widens to the whole local branch rather than trusting them (CX-82).
  const developRemote = await revParse(repoRoot, io, "refs/remotes/origin/develop");
  const mainRemote = await revParse(repoRoot, io, "refs/remotes/origin/main");
  // `verifiedExcludes` stays null on every path — a verified remote tip
  // set cannot exist once transports are refused (CX-132) — so the tail
  // keeps the tracking-ref-relative view.
  const developTailRead =
    developLocal === null
      ? []
      : await unpushedCommits(repoRoot, io, "develop", developRemote, false, null);
  const mainTailRead =
    mainLocal === null ? [] : await unpushedCommits(repoRoot, io, "main", mainRemote, false, null);

  // --- items: journal-attributed segments of the develop tail ---------------
  // Segments follow develop's first-parent chain: a back-merge brings main's
  // commits in through its second parent, and a fix cut's range lives on
  // main — index spans over the full (date-ordered) list would misattribute.
  const developChainRead =
    developLocal === null
      ? []
      : await unpushedCommits(repoRoot, io, "develop", developRemote, true, null);
  // A null tail/chain means the enumeration itself is unverifiable —
  // degrading to [] would run the verifier trailer scan over NOTHING
  // (CX-174). Fail the digest as unverifiable; the lists stay empty so
  // downstream loops degrade visibly.
  if (developTailRead === null || mainTailRead === null || developChainRead === null) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-13",
      severity: "error",
      message:
        "the commit tail enumeration is unverifiable — the evidence channel refused a rev-list; the verifier-trailer scan cannot be trusted to cover the pushed commits",
    });
  }
  const developTail = developTailRead ?? [];
  const mainTail = mainTailRead ?? [];
  const developChain = developChainRead ?? [];
  const common = await commonGitDir(io, repoRoot);
  const journal = await readJournal(io, common);
  const tailIndex = new Map(developChain.map((sha, i) => [sha, i]));
  const boundary =
    developRemote ??
    (developChain.length > 0 ? await revParse(repoRoot, io, `${developChain[0]}^`) : null);

  const claimed = new Set<number>();
  const records = attributedRecords(journal)
    .filter((r) => tailIndex.has(r.tip) && (tailIndex.has(r.base) || r.base === boundary))
    .sort((a, b) => (tailIndex.get(b.tip) ?? 0) - (tailIndex.get(a.tip) ?? 0));

  const segments: Array<{ record: AttributedRecord | null; from: number; to: number }> = [];
  for (const record of records) {
    const from = record.base === boundary ? 0 : (tailIndex.get(record.base) ?? -1) + 1;
    const to = tailIndex.get(record.tip)!;
    const span: number[] = [];
    for (let i = from; i <= to; i++) {
      if (!claimed.has(i)) span.push(i);
    }
    for (const i of span) claimed.add(i);
    if (span.length > 0) segments.push({ record, from: span[0], to: span[span.length - 1]! });
  }
  // Maximal unclaimed runs → unattributed items.
  let runStart: number | null = null;
  for (let i = 0; i <= developChain.length; i++) {
    if (i < developChain.length && !claimed.has(i)) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      segments.push({ record: null, from: runStart, to: i - 1 });
      runStart = null;
    }
  }
  segments.sort((a, b) => a.from - b.from);

  const { specsDir, invariantsFile } = await readPathConfig(repoRoot, io);
  const items: FlowDigestItem[] = [];
  for (const segment of segments) {
    const base =
      segment.from === 0
        ? (boundary ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
        : developChain[segment.from - 1]!;
    const tip = developChain[segment.to]!;
    const metaRead = await commitMeta(repoRoot, io, base, tip);
    if (metaRead === null) {
      diagnostics.push({
        ruleId: "FLOW-PUSH-13",
        severity: "error",
        message: `commit metadata for ${base.slice(0, 9)}..${tip.slice(0, 9)} is unverifiable — the item's subjects/rfc trailers cannot be proven`,
      });
    }
    const meta = metaRead ?? { subjects: [], rfcs: [] };
    const cls = await classifyItem(
      repoRoot,
      io,
      base,
      tip,
      meta.rfcs,
      specsDir,
      invariantsFile,
      diagnostics,
    );
    items.push({
      id: `I-${tip.slice(0, 9)}`,
      kind: segment.record?.kind ?? "unattributed",
      branch: segment.record?.branch ?? null,
      base,
      tip,
      commits: meta.subjects.length,
      subjects: meta.subjects,
      rfcs: meta.rfcs,
      category: cls.category,
      flags: cls.flags,
    });
  }

  // --- held + pending publications -------------------------------------------
  const registry = await readRegistry(io, common);
  const held = registry.branches
    .filter((b) => b.held !== null)
    .map((b) => ({
      branch: b.name,
      tip: b.held!.tip,
      reason: b.held!.reason,
      riskCategory: b.held!.riskCategory,
      heldAt: b.held!.heldAt,
    }));

  // RFC-1503/R13-C: journal `push` records are session-writable
  // provenance — they can only SUPPRESS (a fabricated record hides a tag
  // from `tags`), never mint eligibility. "Pushed but unpublished" has no
  // honest local source — the remote is the only witness and transports
  // are untrusted (CX-132) — so pendingPublications/supersededPublications
  // stay empty and flow.push derives its candidates from `tags` alone.
  const pushedTags = new Set<string>();
  for (const event of journal) {
    if (event.event !== "push") continue;
    for (const token of event.detail.split(/[^A-Za-z0-9._/@-]+/)) {
      if (token.length > 0) pushedTags.add(token);
    }
  }

  // --- new release tags ------------------------------------------------------
  // "Is the tag on the remote?" has no trusted answer — every remote
  // target is session-authored and transports are refused (CX-132). The
  // flow's own journal is session-writable too, so a `push` record can
  // only SUPPRESS here: it hides the tag from this list (the withheld
  // direction is the safe one), never mints eligibility. A fabricated
  // `push` record can neither surface a pending publication nor be
  // corroborated into one (R13-C) — flow.push publishes only what this
  // run itself pushes.
  const { lines } = await discoverReleaseLines(repoRoot, io);
  const tags: string[] = [];
  for (const line of lines) {
    const { reachable } = await listLineTags(repoRoot, line, io);
    for (const tag of reachable) {
      if (!pushedTags.has(tag)) tags.push(tag);
    }
  }
  tags.sort((a, b) => a.localeCompare(b));

  const pendingPublications: FlowDigestData["pendingPublications"] = [];
  const supersededPublications: FlowDigestData["supersededPublications"] = [];

  // --- CI workflows a tag push would trigger (RFC-1498) --------------------
  // Read on the primary checkout — that is the working copy the operator
  // sees; a bare or primary-less repo degrades to no workflows.
  let primary = repoRoot;
  try {
    primary = await primaryWorktree(io, repoRoot);
  } catch {
    primary = repoRoot;
  }
  const tagPatterns = await workflowTagPatterns(join(primary, WORKFLOWS_DIR), io, diagnostics);
  const tagTriggers: FlowDigestData["tagTriggers"] = [];
  for (const tag of tags) {
    const workflows = tagPatterns
      .filter((w) => w.patterns.some((p) => tagPatternRegex(p)?.test(tag) === true))
      .map((w) => w.file);
    if (workflows.length > 0) tagTriggers.push({ tag, workflows });
  }

  const correctnessTrail = await correctnessTrailOf(repoRoot, io, developTail);

  const byCategory = Object.fromEntries(RISK_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    RiskCategory,
    string[]
  >;
  for (const item of items) byCategory[item.category].push(item.id);

  const digestId = createHash("sha256")
    .update(
      canonicalJson({
        develop: { local: developLocal, remote: developRemote, ahead: developTail.length },
        main: { local: mainLocal, remote: mainRemote, ahead: mainTail.length },
        tags,
        tagTriggers,
        correctnessTrail,
        pendingPublications,
        supersededPublications,
        items: items.map((i) => ({ id: i.id, tip: i.tip })),
      }),
    )
    .digest("hex")
    .slice(0, 12);

  return {
    digestId,
    remote: "origin",
    fetched,
    remoteVerified: false,
    develop: { local: developLocal ?? "", remote: developRemote, ahead: developTail.length },
    main: { local: mainLocal ?? "", remote: mainRemote, ahead: mainTail.length },
    tags,
    items,
    byCategory,
    held,
    pendingPublications,
    supersededPublications,
    tagTriggers,
    correctnessTrail,
    diagnostics,
  };
}
