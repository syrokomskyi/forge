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
  <item>The unpushed tail's anchor (origin tip, or the oldest unpushed commit's parent) counts as a valid record base — the RFC's "base and tip on the tail" reads the tail including its anchor, else every first item above a push would be unattributed.</item>
  <item>Overlapping journal records are resolved newest-tail-first: records claim tail commits from the highest tip downward, so a stale record can never cover commits a newer record owns.</item>
  <item>The remote tag set comes from `git ls-remote --tags origin` whenever origin exists (read-only, allowed under --no-fetch); when it fails, a tag is remote-known iff its commit is an ancestor of a remote-tracking tip — a tag on an already-pushed commit is then indistinguishable from a pushed one.</item>
  <item>RFC frontmatter is read only via listRfcFiles/readRfcFrontmatter (RFC-1465 door) — never re-parsed locally.</item>
  <item>tagTriggers (RFC-1498) is part of digestId input: a workflow-file change between digest and push must invalidate the quoted id. Unparseable workflows and ununderstood patterns warn FLOW-11 and match nothing — never block the digest.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 3 — flow.digest risk digest with journal-attributed items, categories, digestId</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1491: digest segments develop by first-parent chain; hold of the topmost item skips the empty replay

Steering-session verification of wave 2 found two outbound defects:
- flow.digest attributed items by index spans over the date-ordered tail; after a fix release and its back-merge, the fix cut record (whose range lives on main) claimed the develop integration that shared its base, so the operator saw 'feat: dev work' labelled as the fix release. Segments now follow develop's first-parent chain and item commit counts come from the base..tip range.
- flow.hold on the item at the tip of develop ran cherry-pick on an empty range and refused FLOW-HOLD-07. An empty tail now resets develop to the item's base.</item>
  <item>RFC-1498: step 4 — CI tag triggers and FLOW-11 in flow.digest

flow.digest now reads .github/workflows on the primary checkout and reports tagTriggers: for every digest tag the workflows whose on.push.tags filter matches its name. Matching evaluates the GitHub glob subset — star inside a segment, double-star across, question for one char; character classes and leading negations report FLOW-11 as pattern not understood and match nothing. A workflow that cannot be parsed reports FLOW-11 and contributes nothing, never blocking the digest. tagTriggers feeds digestId so a workflow change invalidates a quoted id, the pretty output prints one line per triggered tag, and flow.module declares FLOW-11 warning plus the workflows read glob. Tests AC-7 (a v1.0.1 tag maps to the v-star workflow only) and AC-8 (broken YAML and a bracket pattern warn while the digest still returns). Compass metadata updated.</item>
  <history>RFC-1491</history>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { listRfcFiles, readRfcFrontmatter, rfcFileMatchesId } from "../rfc/frontmatter-io.ts";
import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";
import { git } from "./git.ts";
import {
  commonGitDir,
  readJournal,
  readRegistry,
  RISK_CATEGORIES,
  type FlowJournalEvent,
  type RiskCategory,
} from "./registry.ts";
import { tagAnnotationLevel } from "./publish.ts";
import { discoverReleaseLines, type ReleaseLine } from "./release-lines.ts";
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
  pendingPublications: Array<{ tag: string; line: string }>;
  /**
   * RFC-1498: CI workflows a push of each digest tag would start —
   * `.github/workflows` files whose `on.push.tags` filter matches the tag
   * name (repo-relative paths, sorted). Only tags with at least one match
   * get an entry.
   */
  tagTriggers: Array<{ tag: string; workflows: string[] }>;
  diagnostics: Diagnostic[];
}

const RFC_DIR = "docs/rfcs";
const DEFAULT_SPECS_DIR = "docs/specs";
const DEFAULT_INVARIANTS_FILE = "docs/architecture-dna.md";

async function revParse(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
): Promise<string | null> {
  const result = await git(repoRoot, io, ["rev-parse", "--verify", "--quiet", ref]);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

/** Oldest→newest commits of `branch` not reachable from any origin/* ref (or from `remoteTip` when given). */
async function unpushedCommits(
  repoRoot: string,
  io: WorkspaceIO,
  branch: string,
  remoteTip: string | null,
  firstParent = false,
): Promise<string[]> {
  const order = firstParent ? ["--reverse", "--first-parent"] : ["--reverse"];
  const args =
    remoteTip !== null
      ? ["rev-list", ...order, `${remoteTip}..${branch}`]
      : ["rev-list", ...order, branch, "--not", "--remotes=origin"];
  const result = await git(repoRoot, io, args);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
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

/** X-RFC trailer ids + subjects of the commits in (base, tip], oldest first. */
async function commitMeta(
  repoRoot: string,
  io: WorkspaceIO,
  base: string,
  tip: string,
): Promise<{ subjects: string[]; rfcs: string[] }> {
  const result = await git(repoRoot, io, [
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
      parsed && "parsed" in parsed
        ? (parsed.parsed.frontmatter as Record<string, unknown>)
        : {};
    const idExact = String(fm["id"] ?? "").trim().toUpperCase() === id;
    const bump = typeof fm["versionBump"] === "string" ? fm["versionBump"] : null;
    const commands = fm["commands"];
    const removed =
      idExact &&
      typeof commands === "object" &&
      commands !== null &&
      Array.isArray((commands as { removed?: unknown }).removed) &&
      ((commands as { removed: unknown[] }).removed.length > 0);
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
  const result = await git(repoRoot, io, ["show", `${ref}:${path}`]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
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

  const names = await git(repoRoot, io, ["diff", "--name-only", base, tip]);
  const files =
    names.exitCode === 0
      ? names.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
      : [];
  const specsPrefix = `${specsDir.replace(/\/+$/, "")}/`;
  if (
    files.some(
      (f) => f.startsWith(specsPrefix) || f.endsWith(".schema.json") || f.split("/").includes("schemas"),
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

  // @ai-invariant lines in the added/removed set — zero-context diff keeps the scan tight.
  const diff = await git(repoRoot, io, ["diff", "--unified=0", "--no-color", base, tip]);
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
async function remoteTagNames(repoRoot: string, io: WorkspaceIO): Promise<Set<string> | null> {
  const result = await git(repoRoot, io, ["ls-remote", "--tags", "origin"]);
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
  const tips = await git(repoRoot, io, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/remotes/origin",
  ]);
  if (tips.exitCode !== 0) return false;
  for (const tip of tips.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
    const ancestor = await git(repoRoot, io, ["merge-base", "--is-ancestor", tag, tip]);
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
    const file = `${WORKFLOWS_DIR}/${name}`;
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

  const hasOrigin = (await git(repoRoot, io, ["remote", "get-url", "origin"])).exitCode === 0;
  if (!hasOrigin) {
    diagnostics.push({
      ruleId: "FLOW-PUSH-01",
      severity: "error",
      message: "no 'origin' remote — flow.push has nothing to push to",
    });
  }

  let fetched = false;
  if (hasOrigin && opts.fetch) {
    const fetch = await git(repoRoot, io, ["fetch", "origin", "--prune"]);
    fetched = fetch.exitCode === 0;
    if (!fetched) {
      diagnostics.push({
        ruleId: "FLOW-DIGEST-01",
        severity: "warning",
        message: `git fetch origin --prune failed — the digest is computed on stale remote-tracking refs: ${fetch.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`,
      });
    }
  }

  const developLocal = await revParse(repoRoot, io, "develop");
  const mainLocal = await revParse(repoRoot, io, "main");
  const developRemote = await revParse(repoRoot, io, "refs/remotes/origin/develop");
  const mainRemote = await revParse(repoRoot, io, "refs/remotes/origin/main");

  const developTail = developLocal === null ? [] : await unpushedCommits(repoRoot, io, "develop", developRemote);
  const mainTail = mainLocal === null ? [] : await unpushedCommits(repoRoot, io, "main", mainRemote);

  // --- items: journal-attributed segments of the develop tail ---------------
  // Segments follow develop's first-parent chain: a back-merge brings main's
  // commits in through its second parent, and a fix cut's range lives on
  // main — index spans over the full (date-ordered) list would misattribute.
  const developChain =
    developLocal === null ? [] : await unpushedCommits(repoRoot, io, "develop", developRemote, true);
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
      segment.from === 0 ? (boundary ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904") : developChain[segment.from - 1]!;
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

  const pendingPublications: Array<{ tag: string; line: string }> = [];
  const pushedTags = new Set<string>();
  const publishedTags = new Set<string>();
  for (const event of journal) {
    if (event.event === "push") {
      for (const token of event.detail.split(/[^A-Za-z0-9._/@-]+/)) {
        if (token.length > 0) pushedTags.add(token);
      }
    } else if (event.event === "publish") {
      publishedTags.add(event.branch);
    }
  }
  for (const tag of [...pushedTags].sort((a, b) => a.localeCompare(b))) {
    if (!allLocalTags.has(tag) || publishedTags.has(tag)) continue;
    const line = lineForTag(lines, tag);
    // Repo-line tags are never extracted, and baseline annotations are
    // skipped at push time — neither ever gains a publish record.
    if (line === null || line.id === "repo") continue;
    if ((await tagAnnotationLevel(repoRoot, io, tag)) === "baseline") continue;
    pendingPublications.push({ tag, line: line.id });
  }

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
        items: items.map((i) => ({ id: i.id, tip: i.tip })),
      }),
    )
    .digest("hex")
    .slice(0, 12);

  return {
    digestId,
    remote: "origin",
    fetched,
    develop: { local: developLocal ?? "", remote: developRemote, ahead: developTail.length },
    main: { local: mainLocal ?? "", remote: mainRemote, ahead: mainTail.length },
    tags,
    items,
    byCategory,
    held,
    pendingPublications,
    tagTriggers,
    diagnostics,
  };
}
