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
  <item>RFC-1616: close RFC-1616 r10 trust-boundary counterexamples

Independent clean-context verification (round 10, candidate 17c0ec075)
returned REFUTED with two live counterexamples against the
r9-remediated channel — this commit closes both root causes.

- The core.hooksPath pin target is the null device, not a plantable
  temp dir (CX-123): the mkdtemp evidenceHooksDir persisted for the
  process lifetime under the session-owned OS temp root, so a
  concurrent same-uid session could poll, discover it, and plant an
  executable reference-transaction hook that the next pinned fetch
  executed inside the trusted spawn. The pin now aims at DEVNULL —
  the ENOTDIR hook stat skips every hook silently and a char device
  has no plantable entries; no verifier hooks dir exists at all,
  removing the TMPDIR amplifier too.
- A failed claims rebuild is fail-closed, scoped to the reads it can
  poison (CX-124): prepareEvidenceIndex returned {} on a failed
  update-index --index-info, routing index-consulting reads at the
  ambient session-writable .git/index — a CX-121 stat-forged index
  then answered clean on dirty bytes on both channels. The failure
  now marks the index unproven in the preflight, and
  isUnprovenIndexRead refuses exactly the index-consulting ops
  (status/ls-files always; diff unless tree-to-tree; grep unless
  tree-anchored; ambiguous shapes refuse) on all three channels.
  Non-index reads proceed, so a corrupt-index fixture degrades
  per-read (the gate's git-read-failed contract) instead of dying
  channel-wide.

The independent r10 probe file and acceptance report land in the
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
  <item>RFC-1616: close RFC-1616 r12 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r14 trust-boundary counterexamples</item>
  <history>RFC-1330, RFC-1391, RFC-1513, RFC-1615, RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { readFileSync } from "../../src/utils/sync-fs.ts";
import {
  evidencePinEnv,
  evidenceRepoPreflight,
  evidenceSpawnState,
  closeEvidenceIndex,
  closeSpawnFds,
  isIndexConsultingRead,
  isVerifierGitQuery,
  reproveEvidenceSurface,
  resolveGitBin,
  spawnCaptured,
  verifierGitEnv,
  evidenceSpawnArgs,
  type EvidencePreflight,
} from "../../src/utils/verifier-git.ts";
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
  /**
   * `showMany`'s byte-faithful twin — the same `cat-file --batch` channel and
   * the same per-object re-hash, but entries stay Buffers. Export
   * materialization needs raw bytes: a utf8 decode+re-encode round trip
   * rewrites non-utf8 blobs (CX-116/117 boundary).
   */
  showManyBytes?(specs: string[]): Promise<(Buffer | null)[] | null>;
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
function parseCatFileBatchBytes(specs: string[], out: Buffer): (Buffer | null)[] | null {
  const results: (Buffer | null)[] = [];
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
    const meta = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
    if (!meta) return null;
    const size = Number(meta[3]);
    if (off + size + 1 > out.length || out[off + size] !== 0x0a) return null;
    const payload = out.subarray(off, off + size);
    // Re-hash the served bytes against the object name git resolved — a
    // loose file written at a real sha's path is served verbatim without
    // re-hashing (loose shadows packed), so the name alone proves
    // nothing (CX-104). A mismatch maps to `null` — unreadable, never a
    // forged answer — for that entry only.
    const hashed = createHash(meta[1]!.length === 64 ? "sha256" : "sha1")
      .update(`${meta[2]} ${meta[3]}\0`)
      .update(payload)
      .digest("hex");
    results.push(hashed === meta[1] ? payload : null);
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
  // The session-writable repo surface the evidence channel judges gates
  // this read path too (CX-104): a transport/exec lever, a shape file, or
  // a loose object whose bytes do not hash to its sha-shaped name would
  // answer the show/--batch reads below with fabricated bytes. A refused
  // surface degrades every read to `null` — unreadable → `unresolved`,
  // which the tier rules treat as self — never a forged answer. The
  // preflight's `GIT_CONFIG_*` pins and verifier-index env ride EVERY
  // spawn, not just the gate, so a non-refused lever (fsmonitor program,
  // pager/filter driver, forged `.git/index`) cannot fire inside a
  // trusted read either (CX-115/CX-121).
  //
  // The judgment must NEVER go stale (CX-134/CX-135): caching the
  // preflight for the instance's lifetime let a session re-arm every
  // refuse/pin class post-preflight — a rewritten loose object served
  // forged bytes, a new include.path/core.worktree/filter.clean ran a
  // session program inside the trusted read, and a planted shape file
  // rewrote the worktree hash. The cache survives only while the
  // fingerprint re-proves: every call re-checks the `.git` surface
  // synchronously (config bytes, shape presence, object-store file
  // stats, index bytes, indirection state) and discards the cache on
  // any drift — the spawn then carries a judgment of the repo as it is
  // NOW, not as it was at first use.
  let surface: Promise<{ ok: boolean; pf: EvidencePreflight | null }> | undefined;
  const surfaceState = async () => {
    const cached = surface === undefined ? null : await surface;
    if (cached !== null && cached.pf !== null && reproveEvidenceSurface(workspaceRoot, cached.pf)) {
      return cached;
    }
    // Stale (or unproven — a null preflight can never be cached): the
    // stale held fds release before the re-enumeration. The prior
    // fingerprint's resolution anchors pin the re-preflight — a
    // commondir/gitfile plant between captures cannot steer the
    // re-resolution into a forged common dir (CX-143).
    const priorFp = cached?.pf?.fingerprint;
    if (cached !== null) closeEvidenceIndex(cached.pf);
    surface = evidenceRepoPreflight(workspaceRoot, priorFp).then(async (pf) => {
      // A fresh judgment is re-proven against the live surface before it
      // is trusted — a failed re-prove means the surface drifted during
      // preflight, so re-enumerate (bounded) instead of spawning off a
      // stale world (R13-D1). A null preflight is UNPROVEN, never ok:
      // it carries no config judgment, so every read degrades to null
      // rather than spawning unpinned (R13 secondary asymmetry).
      for (let attempt = 0; pf !== null && !reproveEvidenceSurface(workspaceRoot, pf); attempt++) {
        const innerFp = pf.fingerprint;
        closeEvidenceIndex(pf);
        pf = attempt >= 2 ? null : await evidenceRepoPreflight(workspaceRoot, innerFp);
      }
      return {
        ok: pf !== null && pf.refusedKeys.length === 0 && pf.shapeViolations.length === 0,
        pf,
      };
    });
    return surface;
  };
  const runBatchBytes = async (specs: string[]): Promise<(Buffer | null)[] | null> => {
    const { ok, pf } = await surfaceState();
    if (!ok) return null;
    // `--batch` is a line protocol: ONE input line ↔ ONE output record.
    // A spec carrying `\n`/`\r`/`\0` injects extra query lines — the
    // records then desynchronize from the input array and wrong-object
    // bytes get attributed to the wrong spec (CX-130). A `:`-leading
    // spec resolves a staged blob through the index — under an unproven
    // index it must degrade to `null`, not consult the ambient index.
    // Both map to a per-entry null: unreadable, never a forged answer.
    // An unproven config basis degrades the whole read — a config that
    // exists but could not be byte-captured cannot be drift-checked, so
    // no query class runs against it (R13-D).
    if (pf?.configUnproven !== undefined) return null;
    const spawnState = evidenceSpawnState(pf);
    // `@{` rev syntax is a fabrication channel in batch specs too — the
    // argv judges block it for run/runExit, and a `HEAD@{0}` spec here
    // would resolve through the session-fabricable reflog (r12 hunt
    // note): wrong-attribution only after the per-record rehash, still
    // never a forged answer — degrade to per-entry null like the rest.
    const sent = specs.map((s) =>
      s.length === 0 ||
      /[\n\r\0]/.test(s) ||
      s.includes("@{") ||
      (spawnState.unproven && (s === ":" || /^:(?![/(!+^-])/.test(s)))
        ? null
        : s,
    );
    const argv = ["cat-file", "--batch"];
    const r = await spawnCaptured(bin, argv, {
      cwd: workspaceRoot,
      timeoutMs: 60000,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...gitEnvForCwd(), ...evidencePinEnv(argv, pf), ...spawnState.env },
      indexFd: spawnState.indexFd,
      input: `${sent.filter((s): s is string => s !== null).join("\n")}\n`,
    });
    if (r.exitCode !== 0) return null;
    const parsed = parseCatFileBatchBytes(
      sent.filter((s): s is string => s !== null),
      r.stdout,
    );
    if (parsed === null) return null;
    const results: (Buffer | null)[] = [];
    let j = 0;
    for (const s of sent) results.push(s === null ? null : (parsed[j++] ?? null));
    return results;
  };
  return {
    run: async (args) => {
      // Caller argv is judged by the same read table as `verifierGit` — the
      // origin channel shares the trusted env/preflight but must not become
      // an unjudged exec side door (a `reflog`/`config --global` argv would
      // otherwise ride the pinned spawn verbatim).
      if (!isVerifierGitQuery(args)) return null;
      const { ok, pf } = await surfaceState();
      if (!ok || pf?.configUnproven !== undefined) return null;
      // An unproven index refuses index-consulting ops (CX-124/CX-129).
      const spawnState = evidenceSpawnState(pf);
      if (spawnState.unproven && isIndexConsultingRead(args)) {
        closeSpawnFds(spawnState);
        return null;
      }
      const r = await spawnCaptured(bin, evidenceSpawnArgs(args), {
        cwd: workspaceRoot,
        timeoutMs: 15000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...gitEnvForCwd(), ...evidencePinEnv(args, pf), ...spawnState.env },
        indexFd: spawnState.indexFd,
      });
      return r.exitCode === 0 ? r.stdout.toString() : null;
    },
    runExit: async (args) => {
      if (!isVerifierGitQuery(args)) return null;
      const { ok, pf } = await surfaceState();
      if (!ok || pf?.configUnproven !== undefined) return null;
      const spawnState = evidenceSpawnState(pf);
      if (spawnState.unproven && isIndexConsultingRead(args)) {
        closeSpawnFds(spawnState);
        return null;
      }
      const r = await spawnCaptured(bin, evidenceSpawnArgs(args), {
        cwd: workspaceRoot,
        timeoutMs: 15000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...gitEnvForCwd(), ...evidencePinEnv(args, pf), ...spawnState.env },
        indexFd: spawnState.indexFd,
      });
      // Exit code -1 marks spawn/timeout/kill — unreadable, not an answer.
      if (r.exitCode === -1) return null;
      return { code: r.exitCode, stdout: r.stdout.toString(), bytes: r.stdout };
    },
    showMany: async (specs) =>
      (await runBatchBytes(specs))?.map((b) => (b === null ? null : b.toString("utf8"))) ?? null,
    showManyBytes: runBatchBytes,
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
