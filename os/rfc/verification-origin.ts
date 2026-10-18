/*
<MODULE_CONTRACT>
<purpose>
RFC-1330: derive each acceptance probe's origin from git history of the RFC's
implementation range — base is the commit that transitioned the RFC file to
`status: accepted`, head is HEAD — so evidence envelopes record who authored
the expectation instead of trusting the declared expectationSource.
</purpose>
<non-goals>
  <item>Do not decide stamp outcomes — implement-stamp owns RFC-IMP-10/11.</item>
  <item>Do not prove authorship — git history and trailers are agent-writable; this raises the cost of mislabeling only.</item>
  <item>Do not write the verifier trailer — only the RFC-1333 workflow commits it.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Range head is HEAD, never the auto-detected implementation commit — later fix commits stay in range.</item>
  <item>Range base is the oldest commit adding `status: accepted` — maturation edits never count as self.</item>
  <item>All in-range commits count regardless of subject, so unrelated subjects cannot hide test edits.</item>
  <item>Unresolvable history yields `unresolved`, which tier rules treat as self.</item>
  <item>Git access goes through an injectable port so derivation stays testable.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1330: initial implementation — range resolution, declaration/test/run rules, verifier-trailer recognition, presence classification.</item>
  <item>RFC-1330: steps 1-2 — origin contracts and git-derived probe origin derivation

Range base = status: accepted transition, head = HEAD; declaration, test, and run rules; verifier-trailer recognition; presence classification.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "../../src/utils/sync-fs.ts";
import { parseRfcFile } from "./frontmatter-io.ts";
import type {
  AcceptanceProbe,
  DerivedProbeOrigin,
  ImplementationRange,
  ProbeOriginRecord,
  RfcExpectationSource,
} from "./types.ts";

/** Git port — returns stdout, or null when the command failed. */
export interface OriginGit {
  run(args: string[]): Promise<string | null>;
}

export function createOriginGit(workspaceRoot: string): OriginGit {
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile(
          "git",
          args,
          { cwd: workspaceRoot, timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout) => resolve(err ? null : String(stdout)),
        );
      }),
  };
}

export const VERIFIER_ORIGIN_TRAILER = "X-Expectation-Origin: independent-verifier";
const VERIFIER_ORIGIN_RE = /^X-Expectation-Origin:\s*independent-verifier\s*$/m;
const VERIFIER_REPORT_RE = /^X-Verifier-Report:\s*(\S+)\s*$/m;

/** True when a commit body carries the sanctioned verifier trailer pair. */
export function hasVerifierTrailers(body: string): boolean {
  return VERIFIER_ORIGIN_RE.test(body) && VERIFIER_REPORT_RE.test(body);
}

function verifierReportOf(body: string): string | null {
  return VERIFIER_REPORT_RE.exec(body)?.[1] ?? null;
}

const DOC_EXTENSIONS = [".md", ".mdx", ".txt", ".xml"];

export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Presence probes prove structure, not behavior: `file-exists`,
 * `command-registered`, and `file-contains` / `json-schema` over non-doc
 * targets. Their origin is not counted toward tier rules (V-44, RFC-IMP-11).
 */
export function isPresenceProbe(probe: AcceptanceProbe): boolean {
  switch (probe.probe) {
    case "file-exists":
    case "command-registered":
      return true;
    case "file-contains":
      return !isDocPath(probe.path);
    case "json-schema":
      return !isDocPath(probe.artifact);
    default:
      // Future structural kinds (e.g. RFC-1334 `reachable`) opt in here.
      return (probe as { probe: string }).probe === "reachable";
  }
}

const SHORT = 7;
const short = (sha: string): string => sha.slice(0, SHORT);

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable identity of a probe declaration (sorted-key JSON). */
export function probeDeclarationKey(probe: AcceptanceProbe): string {
  return JSON.stringify(sortKeysDeep(probe));
}

/** `git log --follow` names the file per commit: commit sha → path at that commit. */
async function pathHistory(git: OriginGit, relPath: string): Promise<Map<string, string>> {
  const out = await git.run([
    "log",
    "--follow",
    "--name-only",
    "--format=COMMIT %H",
    "--",
    relPath,
  ]);
  const map = new Map<string, string>();
  if (!out) return map;
  let current: string | null = null;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT ")) {
      current = line.slice("COMMIT ".length);
      continue;
    }
    if (current && !map.has(current)) map.set(current, line);
  }
  return map;
}

/**
 * Range for RFC origin derivation. Base = oldest commit whose diff adds or
 * removes a `status: accepted` line in the RFC file (the acceptance
 * transition), head = HEAD.
 */
export async function resolveImplementationRange(
  git: OriginGit,
  rfcRelPath: string,
): Promise<ImplementationRange> {
  const head = (await git.run(["rev-parse", "HEAD"]))?.trim() ?? "HEAD";
  const out = await git.run([
    "log",
    "--follow",
    "--format=%H",
    "-G",
    "^status: accepted$",
    "--",
    rfcRelPath,
  ]);
  const shas = (out ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { base: shas.length > 0 ? shas[shas.length - 1]! : null, head };
}

interface RangeCommit {
  sha: string;
  body: string;
}

/** Commits in base..head touching `relPath` (renames followed), oldest first. */
async function commitsTouching(
  git: OriginGit,
  range: ImplementationRange,
  relPath: string,
): Promise<RangeCommit[]> {
  if (!range.base) return [];
  const out = await git.run([
    "log",
    "--follow",
    "--format=%H%x1f%B%x1e",
    `${range.base}..${range.head}`,
    "--",
    relPath,
  ]);
  if (!out) return [];
  return out
    .split("\x1e")
    .map((chunk) => chunk.replace(/^\s+/, ""))
    .filter((chunk) => chunk.includes("\x1f"))
    .map((chunk) => {
      const [sha, body] = chunk.split("\x1f");
      return { sha: (sha ?? "").trim(), body: body ?? "" };
    })
    .filter((c) => c.sha.length > 0)
    .reverse();
}

async function acceptanceAt(
  git: OriginGit,
  sha: string,
  pathAt: Map<string, string>,
  fallbackPath: string,
): Promise<AcceptanceProbe[] | null> {
  const path = pathAt.get(sha) ?? fallbackPath;
  const source = await git.run(["show", `${sha}:${path}`]);
  if (source === null) return null;
  try {
    const acceptance = parseRfcFile(source).frontmatter["acceptance"];
    return Array.isArray(acceptance) ? (acceptance as AcceptanceProbe[]) : [];
  } catch {
    return null;
  }
}

/**
 * For each in-range commit touching the RFC file, the probe declaration keys
 * it introduced (present after, absent before) — newest introduction wins.
 */
async function declarationIntroductions(
  git: OriginGit,
  range: ImplementationRange,
  rfcRelPath: string,
): Promise<{ baseKeys: Set<string> | null; introducedBy: Map<string, RangeCommit> }> {
  const introducedBy = new Map<string, RangeCommit>();
  if (!range.base) return { baseKeys: null, introducedBy };
  const pathAt = await pathHistory(git, rfcRelPath);
  const baseProbes = await acceptanceAt(git, range.base, pathAt, rfcRelPath);
  if (baseProbes === null) return { baseKeys: null, introducedBy };
  const baseKeys = new Set(baseProbes.map(probeDeclarationKey));
  let previous = baseKeys;
  for (const commit of await commitsTouching(git, range, rfcRelPath)) {
    const probes = await acceptanceAt(git, commit.sha, pathAt, rfcRelPath);
    if (probes === null) continue;
    const keys = new Set(probes.map(probeDeclarationKey));
    for (const key of keys) {
      if (!previous.has(key)) introducedBy.set(key, commit);
    }
    previous = keys;
  }
  return { baseKeys, introducedBy };
}

function runCommandName(command: string): string | null {
  const match = /^werkstatt\s+run\s+(\S+)/.exec(command.trim());
  return match?.[1] ?? null;
}

function rfcCommandSet(frontmatter: Record<string, unknown>): Set<string> {
  const block = (frontmatter["commands"] ?? {}) as Record<string, unknown>;
  const names = new Set<string>();
  for (const bucket of ["proposed", "added", "changed"]) {
    const list = block[bucket];
    if (Array.isArray(list)) for (const n of list) names.add(String(n));
  }
  return names;
}

function effectiveOf(
  derived: DerivedProbeOrigin | "presence",
  declared: RfcExpectationSource | "undeclared",
): ProbeOriginRecord["effective"] {
  if (derived === "presence") return "presence";
  if (derived === "self" || derived === "unresolved") return "self";
  if (derived === "verifier") return "independent";
  return declared;
}

export interface DeriveProbeOriginsInput {
  git: OriginGit;
  rfcRelPath: string;
  frontmatter: Record<string, unknown>;
  probes: AcceptanceProbe[];
  /** Precomputed range (tests / callers that already resolved it). */
  range?: ImplementationRange;
}

/** Derive one origin record per probe, in probe order. */
export async function deriveProbeOrigins(
  input: DeriveProbeOriginsInput,
): Promise<ProbeOriginRecord[]> {
  const { git, rfcRelPath, frontmatter, probes } = input;
  const range = input.range ?? (await resolveImplementationRange(git, rfcRelPath));
  const { baseKeys, introducedBy } = await declarationIntroductions(git, range, rfcRelPath);
  const rfcCommands = rfcCommandSet(frontmatter);
  const fileCache = new Map<string, RangeCommit[]>();

  const records: ProbeOriginRecord[] = [];
  for (const probe of probes) {
    const declared: RfcExpectationSource | "undeclared" = probe.expectationSource ?? "undeclared";
    const finish = (derived: DerivedProbeOrigin | "presence", reason: string[]): void => {
      records.push({
        declared,
        derivedOrigin: derived,
        effective: effectiveOf(derived, declared),
        reason,
      });
    };

    if (isPresenceProbe(probe)) {
      finish("presence", []);
      continue;
    }
    if (!range.base || baseKeys === null) {
      finish("unresolved", ["no `status: accepted` transition found in history"]);
      continue;
    }

    // Declaration rule — added/changed after acceptance ⇒ self, unless the
    // introducing commit carries the verifier trailer pair (RFC-1333).
    const key = probeDeclarationKey(probe);
    let declarationByVerifier: RangeCommit | null = null;
    if (!baseKeys.has(key)) {
      const intro = introducedBy.get(key);
      if (intro && hasVerifierTrailers(intro.body)) {
        declarationByVerifier = intro;
      } else {
        finish("self", [
          intro
            ? `${short(intro.sha)} changed the probe declaration`
            : "probe declaration changed after acceptance",
        ]);
        continue;
      }
    }

    if (probe.probe === "test") {
      let commits = fileCache.get(probe.file);
      if (!commits) {
        commits = await commitsTouching(git, range, probe.file);
        fileCache.set(probe.file, commits);
      }
      const nonVerifier = commits.filter((c) => !hasVerifierTrailers(c.body));
      if (nonVerifier.length > 0) {
        finish(
          "self",
          nonVerifier.map((c) => `${short(c.sha)} touched ${probe.file}`),
        );
        continue;
      }
      if (commits.length > 0) {
        finish(
          "verifier",
          commits.map((c) => verifierReportOf(c.body) ?? short(c.sha)),
        );
        continue;
      }
    } else if (probe.probe === "run") {
      const name = runCommandName(probe.command);
      if (name && rfcCommands.has(name)) {
        finish("self", [`runs ${name}, listed in the RFC's commands block`]);
        continue;
      }
    }

    if (declarationByVerifier) {
      finish("verifier", [
        verifierReportOf(declarationByVerifier.body) ?? short(declarationByVerifier.sha),
      ]);
      continue;
    }
    finish("unchanged", []);
  }
  return records;
}
