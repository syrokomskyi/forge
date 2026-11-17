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
  <item>Declarations compare acceptance-time vs current bytes; a loosen-then-restore within range stays unchanged.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1615: close RFC-1615 round-12 counterexamples (CX-68..72)</item>
  <item>RFC-1615: wire range derivation into unreadable-reads, blob-only path reads, suppress unsupported anchor-removed</item>
  <item>RFC-1615: close round-18 counterexamples — traversal-order rfc parity, literal history pathspecs, normalized binding compare, plain-object prune</item>
  <item>RFC-1615: close round-20 counterexamples — PATH-only oracle runner, unforgeable cycle sentinel, execFile NUL guards</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <history>RFC-1330, RFC-1391, RFC-1513, RFC-1615</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { execFile, readFileSync } from "../../src/utils/sync-fs.ts";
import { resolveGitBin, verifierGitEnv } from "../../src/utils/verifier-git.ts";
import { parseRfcFile } from "./frontmatter-io.ts";
import { RFC_ORIGIN_CUTOFF } from "./types.ts";
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
  /**
   * Exit-code-aware run: `{code, stdout}` for any completed spawn, null only
   * when the process could not run at all (spawn failure, timeout, buffer).
   * Commands with meaningful non-zero exits (git grep: 1 = zero matches — a
   * legitimate empty result, not a read failure) must go through this or
   * they misjudge "empty" as "unreadable" (RFC-1615 review CX-67). `bytes`
   * carries the undecoded stdout when available — path listings need it to
   * tell genuinely invalid UTF-8 names from legal U+FFFD codepoints
   * (CX-72).
   */
  runExit?(args: string[]): Promise<{ code: number; stdout: string; bytes?: Buffer } | null>;
  /**
   * RFC-1513: optional batched object read. One `git cat-file --batch` process
   * answers every spec — entry `i` answers `specs[i]` (`null` marks a missing
   * or unreadable object). Resolves `null` on a wholesale spawn/parse failure
   * so callers fall back to sequential `run(["show", spec])` reads; stubs that
   * do not implement `showMany` take that fallback directly.
   */
  showMany?(specs: string[]): Promise<(string | null)[] | null>;
}

/**
 * Env for git subprocesses that pass an explicit cwd: repository-locating
 * variables inherited from a hook or outer git command (GIT_DIR, GIT_INDEX_FILE,
 * …) would otherwise redirect every call to the outer repository. Delegates to
 * `verifierGitEnv` — RFC-1616 widened the scrub from a named list to the whole
 * `GIT_*` prefix plus `GIT_NO_REPLACE_OBJECTS`, because config injection
 * (`GIT_CONFIG_*`), transport overrides (`GIT_SSH*`), and refs/replace
 * substitution can redirect or rewrite evidence reads just as effectively as a
 * relocated repository (CX-46..CX-51).
 */
export function gitEnvForCwd(): NodeJS.ProcessEnv {
  return verifierGitEnv();
}

/**
 * Parse `git cat-file --batch` output back into per-spec entries. Each record
 * is `<sha> <type> <size>\n<raw bytes>\n` or `<spec> missing\n`. Any framing
 * anomaly resolves the whole call to null (wholesale failure → caller falls
 * back); a `missing` record maps only its own entry to null.
 */
function parseCatFileBatch(specs: string[], out: Buffer): (string | null)[] | null {
  const results: (string | null)[] = [];
  let off = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, off);
    if (nl === -1) return null;
    const header = out.subarray(off, nl).toString("utf8");
    off = nl + 1;
    if (header === `${spec} missing`) {
      results.push(null);
      continue;
    }
    const meta = /^[0-9a-f]+ \S+ (\d+)$/.exec(header);
    if (!meta) return null;
    const size = Number(meta[1]);
    if (off + size + 1 > out.length || out[off + size] !== 0x0a) return null;
    results.push(out.subarray(off, off + size).toString("utf8"));
    off += size + 1;
  }
  return results;
}

export function createOriginGit(workspaceRoot: string): OriginGit {
  // Session-writable YAML (path bindings, refs) reaches these args — a NUL
  // byte makes `execFile` throw synchronously (TypeError). Every throw
  // degrades to a read failure → `unreadableReads` → CORR-GATE-01, never an
  // unhandled gate crash (CX-129). The binary is the resolved absolute git —
  // `env.PATH` is already the rebuilt verifier path, but the absolute path
  // removes resolution from the channel entirely (CX-52).
  const bin = resolveGitBin();
  return {
    run: (args) =>
      new Promise((resolve) => {
        try {
          execFile(
            bin,
            args,
            {
              cwd: workspaceRoot,
              timeout: 15000,
              maxBuffer: 32 * 1024 * 1024,
              env: gitEnvForCwd(),
            },
            (err, stdout) => resolve(err ? null : String(stdout)),
          );
        } catch {
          resolve(null);
        }
      }),
    runExit: (args) =>
      new Promise((resolve) => {
        try {
          execFile(
            bin,
            args,
            {
              cwd: workspaceRoot,
              timeout: 15000,
              maxBuffer: 32 * 1024 * 1024,
              env: gitEnvForCwd(),
              // Raw bytes — path listings must validate UTF-8 at byte level;
              // the default utf8 decode erases the distinction (CX-72).
              encoding: "buffer",
            },
            (err, stdout) => {
              const bytes = Buffer.isBuffer(stdout) ? stdout : undefined;
              if (err === null) return resolve({ code: 0, stdout: String(stdout), bytes });
              // A numeric exit code means the process ran and answered;
              // spawn/timeout/kill failures carry no code — unreadable.
              resolve(
                typeof err.code === "number"
                  ? { code: err.code, stdout: String(stdout), bytes }
                  : null,
              );
            },
          );
        } catch {
          resolve(null);
        }
      }),
    showMany: (specs) =>
      new Promise((resolve) => {
        try {
          const child = execFile(
            bin,
            ["cat-file", "--batch"],
            {
              cwd: workspaceRoot,
              timeout: 60000,
              maxBuffer: 64 * 1024 * 1024,
              env: gitEnvForCwd(),
              encoding: "buffer",
            },
            (err, stdout) => resolve(err ? null : parseCatFileBatch(specs, stdout)),
          );
          child.stdin?.end(`${specs.join("\n")}\n`);
        } catch {
          resolve(null);
        }
      }),
  };
}

export const VERIFIER_ORIGIN_TRAILER = "X-Expectation-Origin: independent-verifier";

/**
 * True when a commit body carries the sanctioned verifier trailer pair —
 * judged the way `git interpret-trailers` judges: only the LAST paragraph is
 * a trailer block, every non-blank line of it must be trailer-shaped
 * (`key:`/`key :`/`key  folded`), keys are case-insensitive, and whitespace
 * before the colon folds (CX-60). A pair planted mid-body or behind a text
 * tail is NOT a git trailer — honoring it would exempt a weakening the
 * push-time `%(trailers)` scan cannot see (arbiter asymmetry). A lone
 * trailer-shaped subject counts — git versions disagree on whether a
 * subject-only message is a trailer block, so both arbiters treat it as one
 * (stricter is safe, CX-23 parity).
 */
export function hasVerifierTrailers(body: string): boolean {
  const block = trailerBlockPairs(body);
  if (block === null) return false;
  let origin = false;
  let report = false;
  for (const [i, t] of block.entries()) {
    if (!t) continue; // a folded continuation line contributes to the previous value
    if (t.k === "x-expectation-origin" && /^independent-verifier$/i.test(t.v)) origin = true;
    if (t.k === "x-verifier-report" && (t.v.length > 0 || block[i + 1] === null)) report = true;
  }
  return origin && report;
}

interface TrailerEntry {
  k: string;
  v: string;
  /** The raw line — for folded values the continuation text lives in later `null` slots. */
  raw: string;
}

/**
 * The key/value pairs of the commit message's LAST paragraph when every
 * non-blank line of it is trailer-shaped — `null` when the last paragraph
 * mixes prose and trailers (then git counts none of it as trailers). A
 * continuation line yields `null` at its index (its value belongs to the
 * previous key).
 */
function trailerBlockPairs(body: string): Array<TrailerEntry | null> | null {
  const trailerLine = (l: string) => /^[^:\s][^:\n]*?\s*:\s*.*$/.test(l);
  const paras = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => l.trim() !== ""))
    .filter((lines) => lines.length > 0);
  const lines = paras.at(-1) ?? [];
  if (!lines.every((l) => trailerLine(l) || /^\s+\S/.test(l))) return null;
  return lines.map((l) => {
    const m = /^([^:\s][^:\n]*?)\s*:\s*(.*)$/.exec(l);
    return m ? { k: m[1]!.trim().toLowerCase(), v: m[2]!.trim(), raw: l } : null;
  });
}

function verifierReportOf(body: string): string | null {
  const block = trailerBlockPairs(body);
  if (block === null) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (const [i, t] of block.entries()) {
    if (!t || t.k !== "x-verifier-report") continue;
    if (t.v.length > 0) return t.v;
    // folded value lives on the continuation line(s) right after this key
    if (block[i + 1] === null) {
      const keyIdx = lines.lastIndexOf(t.raw);
      const cont = lines[keyIdx + 1];
      if (cont !== undefined && /^\s+\S/.test(cont)) return cont.trim();
    }
  }
  return null;
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
    // `:(literal)` — a path carrying glob metachars must not match sibling
    // files and borrow their history (CX-117).
    `:(literal)${relPath}`,
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
  onUnreadable?: (label: string) => void,
): Promise<ImplementationRange> {
  const headOut = await git.run(["rev-parse", "HEAD"]);
  if (headOut === null) onUnreadable?.("rev-parse HEAD");
  const head = headOut?.trim() ?? "HEAD";
  const out = await git.run([
    "log",
    "--follow",
    "--format=%H",
    "-G",
    "^status:[[:space:]]*[\"']?accepted[\"']?[[:space:]]*$",
    "--",
    // `:(literal)` — glob metachars in the path would match sibling files and
    // borrow their acceptance history (CX-117).
    `:(literal)${rfcRelPath}`,
  ]);
  // A failed log is not "no acceptance recorded" — the caller judges the
  // degraded range (CX-73).
  if (out === null) onUnreadable?.(`log --follow -G ${rfcRelPath}`);
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
    `:(literal)${relPath}`,
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
  const match = /^(?:pnpm\s+exec\s+)?werkstatt\s+(?:run|pipeline)\s+(\S+)/.exec(command.trim());
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
  /**
   * RFC-1391: resolves a `proof` probe's spec to its declared `entry` path so
   * entry bytes are origin-tracked alongside spec bytes. Returns null when the
   * spec is unreadable/unparseable (the spec alone stays tracked then).
   */
  resolveProofEntry?: (specRelPath: string) => Promise<string | null>;
}

/** Default entry resolver — reads `spec.entry` out of the spec YAML. */
export function createProofEntryResolver(
  workspaceRoot: string,
): (specRelPath: string) => Promise<string | null> {
  return async (specRelPath) => {
    try {
      const parsed = yamlParse(readFileSync(join(workspaceRoot, specRelPath), "utf8")) as {
        entry?: unknown;
      };
      return typeof parsed?.entry === "string" ? parsed.entry : null;
    } catch {
      return null;
    }
  };
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
    } else if (probe.probe === "proof") {
      // RFC-1391: same self/verifier rule as `test`, applied to the union of
      // commits touching the spec AND its resolved entry — proof evidence
      // binds to both byte streams.
      const commits: RangeCommit[] = [];
      for (const f of [
        probe.spec,
        await (input.resolveProofEntry ?? (async () => null))(probe.spec),
      ]) {
        if (!f) continue;
        let fileCommits = fileCache.get(f);
        if (!fileCommits) {
          fileCommits = await commitsTouching(git, range, f);
          fileCache.set(f, fileCommits);
        }
        for (const c of fileCommits) {
          if (!commits.some((x) => x.sha === c.sha)) commits.push(c);
        }
      }
      const nonVerifier = commits.filter((c) => !hasVerifierTrailers(c.body));
      if (nonVerifier.length > 0) {
        finish(
          "self",
          nonVerifier.map((c) => `${short(c.sha)} touched proof spec/entry`),
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

/**
 * RFC-1330: attach `origin` to envelope probe records for RFCs created on or
 * after RFC_ORIGIN_CUTOFF. Shared by `rfc.verification.emit` and
 * `rfc.verification.refresh` so both envelope writers stay identical.
 * `origin` is volatile evidence context — `checkEvidenceEnvelope` never
 * compares it because it depends on git history, not on the RFC bytes.
 */
export async function attachProbeOrigins(opts: {
  workspaceRoot: string;
  rfcRelPath: string;
  frontmatter: Record<string, unknown>;
  probes: AcceptanceProbe[];
  records: Array<{ origin?: ProbeOriginRecord }>;
  git?: OriginGit;
}): Promise<void> {
  const createdAt = String(opts.frontmatter["createdAt"] ?? "");
  if (createdAt < RFC_ORIGIN_CUTOFF) return;
  const origins = await deriveProbeOrigins({
    git: opts.git ?? createOriginGit(opts.workspaceRoot),
    rfcRelPath: opts.rfcRelPath,
    frontmatter: opts.frontmatter,
    probes: opts.probes,
    resolveProofEntry: createProofEntryResolver(opts.workspaceRoot),
  });
  origins.forEach((origin, i) => {
    const record = opts.records[i];
    if (record) record.origin = origin;
  });
}
