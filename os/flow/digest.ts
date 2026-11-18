/*
<MODULE_CONTRACT>
<purpose>Risk digest of the unpushed outbound state (RFC-1491): the unpushed
develop tail segmented into journal-attributed items, risk categories from
each item's diff, new release tags versus origin, held registry branches and
journal-scoped pending publications — fingerprinted into a digestId that
flow.push must quote.</purpose>
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
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r7 trust-boundary counterexamples

Independent clean-context verification (round 7, candidate d2f270ad6)
returned REFUTED with eleven live counterexamples against the
r6-hardened evidence channel — this commit closes all nine root causes.

- remote.<name>.fetch is value-judged: only the clone-default
  +?refs/heads/*:refs/remotes/<name>/* shape stays KEEP, because git
  UNIONs configured refspecs with the pinned fetch argv and a session
  spec writes arbitrary local refs inside the trusted fetch (CX-94).
  remote.<name>.tagopt|promirror|followremotehead|prunetags|
  skipfetchall|mirror move to REFUSE for the same reason.
- Alternates/shape comment lexing is col-0 `#` only — git's parser does
  not treat whitespace-led `#` as a comment, so `   # forged` is a real
  alternates path the shape check must count (CX-95).
- config reads forbid the alternate-source selectors --file/-f, --blob,
  --worktree (reaches config.worktree even under the disabled-extension
  pin), --system/--global, --default and --includes, plus the
  write-action spellings, on both the evidence and shared read-only
  tables (CX-96).
- verifierGit judges fabrication argv on the runner/policy channel:
  @{...}, -g, --reflog, --walk-reflogs and --fork-point return
  EVIDENCE-REFUSED before the spawn — policy.digest --base 'HEAD@{0}'
  can no longer verify an unattested advance (CX-97).
- --use-bitmap-index/--test-bitmap are forbidden on rev-list/log in
  both tables — the flag opts the trusted walk into the session-
  writable pack bitmap cache the commitGraph/MIDX pins closed (CX-98).
- for-each-ref/show-ref/ls-remote forbid --stdin and --exclude-existing
  on both tables — they block on input the no-stdin spawn never
  supplies (CX-101).
- The workflow-adoption heredoc lexer is bash-faithful: openers are
  scanned on the raw line before the # comment strip (quoted-#
  delimiters, CX-99a), bare delimiters accept digits/./- (CX-99b), and
  the terminator match is strict — << wants the delimiter alone, <<-/
  <<~ skip leading tabs only (CX-100).
- Trailer scans read %e beside %(trailers): a commit declaring a
  non-UTF-8 encoding header recodes every trusted message read, so the
  digest trail and the push-time scan flag it as unverifiable and the
  policy attestation scan skips it (CX-102).

Probe premise updates for the tightened contract: CX-61's decoy
remote.origin.fetch (cx4 and cx5 R5-R1) now asserts the wholesale
EVIDENCE-REFUSED plus FLOW-PUSH-13 refuse — strictly stronger than the
decoy-namespace guard it replaces. The independent r7 probe file and
acceptance report land in the follow-up port commit.</item>
  <history>RFC-1491, RFC-1498, RFC-1503, RFC-1580</history>
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
import { planPublications, type PublicationPlanEntry } from "./publication-order.ts";
import { tagAnnotationLevel } from "./publish.ts";
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
  fetched: boolean;
  /**
   * Whether `develop.remote`/`main.remote` came from a live `ls-remote`
   * answer this run. `false` means they are session-mutable
   * `refs/remotes/origin/*` tracking refs — a display-only preview a
   * planted ref can shape (CX-82). The push-side verifier scan must
   * widen to the whole local branch instead of trusting them as a
   * range base.
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
   * RFC-1503: the highest pending tag per package line — what the next
   * flow.push actually attempts. Lower pending tags moved to
   * `supersededPublications`.
   */
  pendingPublications: Array<{ tag: string; line: string }>;
  /**
   * RFC-1503: lower pending tags the next push supersedes (`by` = the
   * superseding tag, null when the tag waits behind a higher candidate
   * that has not published yet).
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
 * only safe failure is scanning more, never less.
 */
async function unpushedCommits(
  repoRoot: string,
  io: WorkspaceIO,
  branch: string,
  remoteTip: string | null,
  firstParent = false,
  verifiedExcludes: string[] | null = null,
): Promise<string[]> {
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
    return widened.exitCode === 0 ? lines(widened.stdout) : [];
  }
  const args =
    verifiedExcludes !== null
      ? verifiedExcludes.length > 0
        ? ["rev-list", ...order, branch, "--not", ...verifiedExcludes]
        : ["rev-list", ...order, branch]
      : ["rev-list", ...order, branch, "--not", "--remotes=origin"];
  const result = await gitEvidence(repoRoot, args);
  if (result.exitCode !== 0) return [];
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
async function readCommittedPushConfig(repoRoot: string): Promise<{ expectedRemote?: string }> {
  const show = await gitEvidence(repoRoot, ["show", "HEAD:forge.yaml"]);
  if (show.exitCode !== 0) return {};
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
    // the trailer blob could smuggle a record boundary (CX-33 class).
    const subj = await gitEvidence(repoRoot, ["log", "-1", "--format=%s", sha]);
    if (subj.exitCode !== 0) continue;
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
    if (trailers.exitCode !== 0) continue;
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
): Promise<{ subjects: string[]; rfcs: string[] }> {
  const result = await gitEvidence(repoRoot, [
    "log",
    "--reverse",
    "--format=%s%x00%(trailers:key=X-RFC,valueonly,separator=%x20)",
    `${base}..${tip}`,
  ]);
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
  const result = await gitEvidence(repoRoot, ["show", `${ref}:${path}`]);
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
): Promise<{ category: RiskCategory; flags: RiskCategory[] }> {
  const flags = new Set<RiskCategory>();

  const names = await gitEvidence(repoRoot, ["diff", "--name-only", base, tip]);
  const files =
    names.exitCode === 0
      ? names.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : [];
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
  const diff = await gitEvidence(repoRoot, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-textconv",
    "--no-ext-diff",
    base,
    tip,
  ]);
  if (diff.exitCode === 0) {
    for (const line of diff.stdout.split("\n")) {
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

/** Remote tag names via ls-remote; null when the remote cannot be queried. */
async function remoteTagNames(repoRoot: string, _io: WorkspaceIO): Promise<Set<string> | null> {
  // The tag listing feeds the digest the verifier judges — it must read the
  // literal remote, not a session url.insteadOf rewrite (CX-50). The cost is
  // credential-helper-less failure on auth-required remotes: honest null,
  // never a silently rewritten view.
  const result = await gitEvidence(repoRoot, ["ls-remote", "--tags", "origin"]);
  if (result.exitCode !== 0) return null;
  const names = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/refs\/tags\/([^\s^]+)$/);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** Tag is treated as remote-known when its commit is an ancestor of an origin/* tip. */
async function tagReachableFromRemote(
  repoRoot: string,
  io: WorkspaceIO,
  tag: string,
): Promise<boolean> {
  const tips = await gitEvidence(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/remotes/origin",
  ]);
  if (tips.exitCode !== 0) return false;
  for (const tip of tips.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)) {
    const ancestor = await gitEvidence(repoRoot, ["merge-base", "--is-ancestor", tag, tip]);
    if (ancestor.exitCode === 0) return true;
  }
  return false;
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
 * Collect the outbound digest of repoRoot. `opts.fetch === false` skips the
 * `git fetch origin --prune`; a failed fetch yields `fetched: false` plus a
 * warning — never an error.
 */
export async function collectDigest(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { fetch: boolean },
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

  const { expectedRemote } = await readCommittedPushConfig(repoRoot);

  const originProbe = await gitEvidence(repoRoot, ["remote", "get-url", "origin"]);
  const hasOrigin = originProbe.exitCode === 0;
  if (!hasOrigin && !refused(originProbe)) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-01",
      severity: "error",
      message: "no 'origin' remote — flow.push has nothing to push to",
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

  let fetched = false;
  // Remote tips the digest and the push scan judge. When the remote was
  // contacted they come from `ls-remote` — a live answer from the remote
  // itself, immune to whatever the session planted into
  // `refs/remotes/origin/*` (CX-61). Under `--no-fetch` they fall back to
  // the tracking refs as a display-only preview; a real push always
  // re-derives through the fetched path.
  let remoteTips: { develop: string | null; main: string | null } | null = null;
  if (hasOrigin && opts.fetch) {
    // The fetched objects become the remote-tracking refs the push scan
    // judges — a session url.insteadOf rewrite must not steer where they
    // come from (CX-50). The explicit refspec overrides a rewritten
    // remote.origin.fetch (CX-61) and --prune removes planted tracking
    // refs that do not exist on the remote. Auth-required https remotes
    // lose credential helpers here and fail closed into the stale-ref
    // diagnostic below, never a poisoned view.
    const lsRemote = await gitEvidence(repoRoot, [
      "ls-remote",
      "origin",
      "refs/heads/develop",
      "refs/heads/main",
    ]);
    const fetch = await gitEvidence(repoRoot, [
      "fetch",
      "--prune",
      "--no-tags",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    fetched = fetch.exitCode === 0 && lsRemote.exitCode === 0;
    if (lsRemote.exitCode === 0) {
      remoteTips = { develop: null, main: null };
      for (const line of lsRemote.stdout.split("\n")) {
        const m = /^([0-9a-f]{40})\trefs\/heads\/(develop|main)$/.exec(line.trim());
        if (m) remoteTips[m[2] as "develop" | "main"] = m[1]!;
      }
    }
    if (!fetched) {
      const why =
        fetch.exitCode !== 0 ? fetch.stderr : lsRemote.stderr || "ls-remote returned no answer";
      diagnostics.push({
        ruleId: "FLOW-DIGEST-01",
        severity: "warning",
        message: `git fetch/ls-remote origin failed — the digest is computed on stale remote-tracking refs: ${why.trim().split("\n").slice(-1)[0] ?? "unknown error"}`,
      });
    }
  }

  const developLocal = await revParse(repoRoot, io, "develop");
  const mainLocal = await revParse(repoRoot, io, "main");
  const developRemote =
    remoteTips !== null
      ? remoteTips.develop
      : await revParse(repoRoot, io, "refs/remotes/origin/develop");
  const mainRemote =
    remoteTips !== null
      ? remoteTips.main
      : await revParse(repoRoot, io, "refs/remotes/origin/main");
  // The exclusion set for a branch the remote does not carry. On the
  // fetched path only the other branch's ls-remote-verified tip may
  // subtract from the tail — tracking refs are session-mutable and a
  // planted one would hide commits from the scan exactly like a planted
  // remote tip (CX-61). On the --no-fetch preview path `verifiedExcludes`
  // stays null so the tail keeps the legacy tracking-ref-relative view —
  // the push-side verifier scan judges `remoteVerified` separately and
  // widens instead (CX-82).
  const developTail =
    developLocal === null
      ? []
      : await unpushedCommits(
          repoRoot,
          io,
          "develop",
          developRemote,
          false,
          remoteTips === null ? null : remoteTips.main === null ? [] : [remoteTips.main],
        );
  const mainTail =
    mainLocal === null
      ? []
      : await unpushedCommits(
          repoRoot,
          io,
          "main",
          mainRemote,
          false,
          remoteTips === null ? null : remoteTips.develop === null ? [] : [remoteTips.develop],
        );

  // --- items: journal-attributed segments of the develop tail ---------------
  // Segments follow develop's first-parent chain: a back-merge brings main's
  // commits in through its second parent, and a fix cut's range lives on
  // main — index spans over the full (date-ordered) list would misattribute.
  const developChain =
    developLocal === null
      ? []
      : await unpushedCommits(
          repoRoot,
          io,
          "develop",
          developRemote,
          true,
          remoteTips === null ? null : remoteTips.main === null ? [] : [remoteTips.main],
        );
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
    const meta = await commitMeta(repoRoot, io, base, tip);
    const cls = await classifyItem(repoRoot, io, base, tip, meta.rfcs, specsDir, invariantsFile);
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

  // --- new release tags ------------------------------------------------------
  const { lines } = await discoverReleaseLines(repoRoot, io);
  // The RFC names `git ls-remote --tags origin` — a read-only query, run
  // whenever origin exists (--no-fetch still allows it). A failed query
  // degrades to the reachability approximation.
  const remoteTags = hasOrigin ? await remoteTagNames(repoRoot, io) : null;
  const tags: string[] = [];
  const allLocalTags = new Set<string>();
  for (const line of lines) {
    const { reachable } = await listLineTags(repoRoot, line, io);
    for (const tag of reachable) {
      allLocalTags.add(tag);
      const remoteKnown =
        remoteTags !== null ? remoteTags.has(tag) : await tagReachableFromRemote(repoRoot, io, tag);
      if (!remoteKnown) tags.push(tag);
    }
  }
  tags.sort((a, b) => a.localeCompare(b));

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

  // RFC-1503: pending candidates are journal-scoped — pushed, not published,
  // not superseded, not retired. planPublications picks the highest per line
  // as the real pending list and routes the rest to supersededPublications.
  const pushedTags = new Set<string>();
  const publishedTags = new Set<string>();
  const supersededTags = new Set<string>();
  const retiredTags = new Set<string>();
  for (const event of journal) {
    if (event.event === "push") {
      for (const token of event.detail.split(/[^A-Za-z0-9._/@-]+/)) {
        if (token.length > 0) pushedTags.add(token);
      }
    } else if (event.event === "publish") {
      publishedTags.add(event.branch);
    } else if (event.event === "publish-superseded") {
      supersededTags.add(event.branch);
    } else if (event.event === "publish-retired") {
      retiredTags.add(event.branch);
    }
  }
  const pendingCandidates: PublicationPlanEntry[] = [];
  for (const tag of [...pushedTags].sort((a, b) => a.localeCompare(b))) {
    if (!allLocalTags.has(tag) || publishedTags.has(tag)) continue;
    if (supersededTags.has(tag) || retiredTags.has(tag)) continue;
    const line = lineForTag(lines, tag);
    // Repo-line tags are never extracted, and baseline annotations are
    // skipped at push time — neither ever gains a publish record.
    if (line === null || line.id === "repo") continue;
    if ((await tagAnnotationLevel(repoRoot, io, tag)) === "baseline") continue;
    pendingCandidates.push({ tag, line: line.id });
  }
  const plan = planPublications(pendingCandidates, publishedTags, retiredTags, (tag, line) =>
    versionOfTag(lines, tag, line),
  );
  const pendingPublications = plan.attempt;
  const supersededPublications = plan.superseded;

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
    remoteVerified: remoteTips !== null,
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
