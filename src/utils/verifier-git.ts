/*
<MODULE_CONTRACT>
<purpose>RFC-1616: hardened git subprocess primitives for trust-boundary
reads — a scrubbed environment (every session GIT_* variable dropped,
refs/replace substitution disabled) plus an executable resolver that prefers
well-known install dirs over session-controlled PATH entries. Committed
evidence the verifier judges must be the object's real bytes, not a
substituted object, a redirected repository, or a shim binary's output
(CX-46..CX-52).</purpose>
<non-goals>
  <item>Does not replace io.exec on non-boundary paths — ordinary repo operations keep the recording/fake-io adapters.</item>
  <item>Does not defend the runner's own process env — the adversarial runner owns its child env allowlist separately.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Allowlist not denylist for env: any GIT_* variable git honors (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_*, GIT_CEILING_*, GIT_EXEC_PATH, GIT_NAMESPACE, GIT_SSH*, GIT_EXTERNAL_DIFF…) can redirect what a read resolves, so the whole prefix is dropped rather than enumerating known levers (O-2/r3).</item>
  <item>GIT_NO_REPLACE_OBJECTS is set AFTER the strip — refs/replace rewrites trees, messages, and listing output while the real objects still ship on push, so every committed read must see raw objects (CX-46..49).</item>
  <item>resolveGitBin prefers well-known install dirs before PATH order — a session shim only wins when it lives inside a dir PATH lists first; checking the standard dirs first makes PATH order irrelevant for the common layouts (CX-52).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: close RFC-1616 r8 trust-boundary counterexamples

Independent clean-context verification (round 8, candidate 9da0bf515)
returned REFUTED with nine live counterexamples against the r7-hardened
evidence channel — this commit closes all root causes.

- Committed-object reads carry an integrity anchor: loose objects under
  .git/objects whose inflated bytes do not hash to their object name
  refuse the channel — forged loose bytes and loose-over-packed
  shadowing can no longer serve the anchored base (CX-104a/b).
- policy.digest --verify --base accepts only concrete immutable commit
  identifiers — symbolic/message/index/path revspecs (HEAD^{/...},
  :/..., bare HEAD, branch names) are rejected before verify (CX-103).
- The heredoc lexer is a bash word-grammar scan: <<~EOF arms literal
  ~EOF (CX-105), quote removal applies across the whole word so
  <<'E'OF and <<E"OF" arm EOF (CX-106), and $/command-substitution
  words arm a never-matching sentinel so body lines stay stdin (CX-107).
- verifierGit is a subcommand + option allowlist: reflog/stash and
  write commands (config writes, update-ref) are refused, caller
  -c/-C/--git-dir/--work-tree/--exec-path are rejected instead of
  landing after the pins, and -g inside short-option clusters (-ng) is
  judged (CX-108/109).
- Every remote.<name>.* class keys the name as greedy .+ so dotted
  remotes no longer escape the REFUSE table or fetch value-judge —
  remote.o.r.uploadpack refuses the channel instead of executing inside
  fetch o.r (CX-110); fetch/ls-remote positional remotes are
  form-judged.

The independent r8 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
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
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { resolveSpawnPlan } from "./spawn.ts";

const GIT_BIN_CANDIDATE_DIRS = [
  "/usr/bin",
  "/usr/local/bin",
  "/bin",
  "/opt/homebrew/bin",
  "/usr/sbin",
  "/sbin",
  "/run/current-system/sw/bin",
  "/snap/bin",
  "/usr/local/git/bin",
  "/opt/git/bin",
  "C:\\Program Files\\Git\\cmd",
  "C:\\Program Files\\Git\\bin",
  "C:\\Program Files (x86)\\Git\\cmd",
] as const;

let resolvedGitBin: string | undefined;

/**
 * Test-only seam — repoint the resolved git binary at a shim so failure-
 * injection probes (PATH-shim suites that predate the hardened channel) can
 * refuse chosen argv prefixes. Module state a session cannot reach: the
 * spawned gate child and the adversarial runner's CLI still resolve the real
 * binary. Pass `undefined` to re-resolve on the next call.
 */
export function setVerifierGitBinForTests(bin: string | undefined): void {
  resolvedGitBin = bin;
}

/**
 * Absolute path to the git executable the verifier may trust. Only
 * well-known install dirs are probed — a session-controlled PATH entry can
 * carry a `git` shim that answers evidence queries with fabrications
 * (CX-52), so session PATH is deliberately never consulted: on layouts
 * where git lives nowhere conventional the bare name is returned and the
 * scrubbed child env fails closed (unreadable evidence, never a forged
 * answer). The result is cached: the binary a run starts with is the
 * binary it finishes with.
 */
export function resolveGitBin(): string {
  if (resolvedGitBin !== undefined) return resolvedGitBin;
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const dir of GIT_BIN_CANDIDATE_DIRS) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        resolvedGitBin = candidate;
        return candidate;
      }
    }
  }
  resolvedGitBin = "git";
  return resolvedGitBin;
}

/**
 * A PATH rebuilt from directories the session did not place first: the
 * resolved git's own dir, the node's own dir, and the conventional system
 * dirs. Session PATH entries are excluded wholesale — a shim dir earlier in
 * PATH substitutes `git`/`sh`/hook executables for spawned children
 * (CX-52).
 */
export function verifierPath(): string {
  const dirs = [path.dirname(resolveGitBin()), path.dirname(process.execPath)];
  for (const dir of GIT_BIN_CANDIDATE_DIRS) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return [...new Set(dirs)].join(path.delimiter);
}

/**
 * Environment for git subprocesses on the trust boundary. Built on the
 * spawned-child ALLOWLIST (verifierSpawnEnv) rather than a strip list —
 * every variable not explicitly kept is dropped: repository redirection
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 * alternates), config injection (`GIT_CONFIG_*` url rewrites), transport
 * and exec-path overrides (`GIT_SSH*`, `GIT_EXEC_PATH`), namespaces,
 * ceilings, AND the generic preload/redirect levers a session owns —
 * `LD_PRELOAD`/`LD_*`/`DYLD_*`, `BASH_ENV`/`ENV`/`CDPATH`/`IFS`,
 * `NODE_OPTIONS`/`NODE_PATH`, `PYTHONPATH`/`PYTHONSTARTUP`, `RUBYLIB`,
 * `PERL5LIB`/`PERL5OPT`, `GCONV_PATH`, `LOCALDOMAIN`, and anything not yet
 * invented (CX-71: a compiled LD_PRELOAD .so answered a trusted evidence
 * read verbatim). `refs/replace` substitution is disabled so committed
 * reads see the object's real tree/message (CX-46..CX-51); the
 * global/system config files are `/dev/null` so session-writable
 * `~/.gitconfig` `url.insteadOf`/`alias`/`filter` entries cannot rewrite
 * what a read resolves; and PATH is rebuilt around the resolved real git so
 * a session shim cannot substitute executable resolution.
 */
export function verifierGitEnv(): NodeJS.ProcessEnv {
  const env = verifierSpawnEnv();
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  env["GIT_CONFIG_GLOBAL"] = process.platform === "win32" ? "NUL" : "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = process.platform === "win32" ? "NUL" : "/dev/null";
  // ssh:// and scp-style transports exec OpenSSH, which reads the user's
  // own ~/.ssh/config via getpwuid — outside every git-config surface the
  // preflight judges, so a session `Match`/`ProxyCommand` block there would
  // run inside the trusted channel (CX-86). `-F <devnull>` overrides the
  // per-user config file entirely; the known-hosts file is devnull'd so a
  // session-planted trust cannot pass either (first-contact hosts still
  // work TOFU-style — a network MITM is outside the session-config model).
  env["GIT_SSH_COMMAND"] =
    `ssh -F ${DEVNULL} -o UserKnownHostsFile=${DEVNULL} -o StrictHostKeyChecking=accept-new`;
  return env;
}

const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * `-c` pins forced into every evidence-channel spawn — repo config is
 * session-writable, so any setting that reshapes what a read resolves or
 * parses must be held to the documented baseline. `core.commentChar` and
 * `trailer.separators` decide whether `%(trailers)` sees a verifier claim
 * at all (CX-64/CX-65: the scan went blind while the `%B` parser still
 * exempted); `log.showSignature`, `i18n.logOutputEncoding`,
 * `core.quotepath`, and `color.ui` reshape bytes the parsers match;
 * `core.fsmonitor` executes a repo-config binary on a status read;
 * `credential.helper=` is the documented list reset;
 * `interactive.diffFilter=cat` replaces the driver FILTER with a
 * pass-through. `diff.external` is NOT here: it names the diff
 * GENERATOR, not a filter — `-c diff.external=cat` execs `cat` with
 * diff-driver argv (garbage then "external diff died"), and `-c
 * diff.external=` execs an empty program — no `-c` value neutralizes it,
 * so presence refuses the channel like the transport levers below.
 * `extensions.worktreeConfig=false`
 * keeps `.git/config.worktree` keys from loading; `maintenance.auto` /
 * `gc.auto` stop a pinned fetch from spawning background helpers;
 * `fetch.recurseSubmodules`/`submodule.recurse` keep the read inside the
 * one repo; the `protocol.*.allow` pins forbid exec-capable transports.
 * Transport levers (`core.gitProxy`, `remote.*.proxy`, `http.*`, `ssh.*`)
 * are deliberately NOT here — `-c` never reaches the children that read
 * them, so evidenceRepoPreflight refuses on their presence instead
 * (CX-72/CX-76).
 */
const EVIDENCE_CONFIG_PINS = [
  "core.commentChar=#",
  "trailer.separators=:",
  "log.showSignature=false",
  "i18n.logOutputEncoding=UTF-8",
  "core.quotepath=false",
  "color.ui=false",
  "core.fsmonitor=false",
  "credential.helper=",
  "interactive.diffFilter=cat",
  "extensions.worktreeConfig=false",
  "maintenance.auto=false",
  "gc.auto=false",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
  "protocol.ext.allow=never",
  "protocol.rsync.allow=never",
  "protocol.ftp.allow=never",
  "protocol.ftps.allow=never",
  // Session-writable caches that re-describe stored objects: a forged
  // `.git/objects/info/commit-graph` overrides committed parent edges so
  // rev-list/merge-base hide real commits (CX-88), and a forged MIDX can
  // remap oid→pack bytes. Both are regenerable caches — pinning the
  // readers off restores ground truth without touching the files.
  "core.commitGraph=false",
  "core.multiPackIndex=false",
  // A forged `objects/pack/*.bitmap` is the same class of session-writable
  // reachability cache — rev-list would trust claimed membership over the
  // real object graph (CX-113's pack-store sibling).
  "pack.useBitmapIndex=false",
] as const;

/**
 * `-c` argv fragment shared by both evidence spawns — added inside the
 * trusted body, never by the callsite, so the static argv judgment sees
 * only the query itself. The path pins are resolved per call so the
 * lazily-created hooks dir exists before git sees it.
 */
export function evidenceConfigArgs(args?: readonly string[]): string[] {
  // `core.hooksPath` stays pinned for every subcommand EXCEPT `config` —
  // a `config --get core.hooksPath` evidence read must answer the repo's
  // real value (the install/check surface judges drift through it), and
  // no non-config command can observe the pin as output. Hook-invoking
  // reads (fetch → reference-transaction, CX-74) still get the dead path.
  // The pin target is the null device, not a verifier-owned temp dir
  // (CX-123): git joins `<hooksPath>/<hookname>` and the ENOTDIR stat
  // skips every hook silently (verified: fetch/status/commit exit 0, a
  // planted reference-transaction never fires) — and a char device has
  // no directory entries, so a concurrent same-uid session cannot plant
  // a hook into the pin target no matter how long it polls. A mkdtemp
  // dir under the session-owned OS temp root was plantable post-creation
  // (CX-123), and `TMPDIR` survives the env allowlists.
  const onConfigRead = args?.[0] === "config";
  return [
    ...EVIDENCE_CONFIG_PINS.flatMap((kv) => ["-c", kv]),
    ...(onConfigRead ? [] : ["-c", `core.hooksPath=${DEVNULL}`]),
    "-c",
    `core.attributesFile=${DEVNULL}`,
    "-c",
    `core.excludesFile=${DEVNULL}`,
  ];
}

/**
 * Compose the full pin argv for one evidence call — static pins plus the
 * preflight's dynamic pins, with the hook-path pins held back on `config`
 * reads so the repo's real hooksPath is the answer.
 */
export function evidencePinArgs(
  args: readonly string[],
  preflight?: EvidencePreflight | null,
): string[] {
  const onConfigRead = args[0] === "config";
  return [
    ...evidenceConfigArgs(args),
    ...(preflight?.configArgs ?? []),
    ...(onConfigRead ? [] : (preflight?.hookArgs ?? [])),
  ];
}

/**
 * The `-c` pin pairs re-encoded as `GIT_CONFIG_*` env — command-scope config
 * with the same precedence over `.git/config` that argv `-c` carries, but
 * the spawned argv stays the judged query alone (`[subcommand, ...]`). The
 * r8 pins-as-argv shifted every argv position: failure-injection seams that
 * match the subcommand at `$1`/`$2` (the resolved-binary shim contract the
 * CX-73..81 fixtures arm) silently missed, so an injected read failure
 * degraded to a pass instead of an `unreadableReads` refusal (CX-115 r9
 * regression). Pins ride the channel-owned env like `GIT_INDEX_FILE` —
 * `verifierGitEnv` already strips ambient `GIT_CONFIG_*`, and caller
 * `extraEnv` cannot re-add GIT_* keys, so the lever stays session-proof.
 */
export function evidencePinEnv(
  args: readonly string[],
  preflight?: EvidencePreflight | null,
): Record<string, string> {
  const argv = evidencePinArgs(args, preflight);
  const env: Record<string, string> = {};
  let n = 0;
  for (let i = 0; i + 1 < argv.length; i += 2) {
    const kv = argv[i + 1]!;
    const eq = kv.indexOf("=");
    env[`GIT_CONFIG_KEY_${n}`] = eq === -1 ? kv : kv.slice(0, eq);
    // `-c key=` means an empty value; `-c key` (no `=`) means boolean-true,
    // which env expresses by LEAVING the value unset — never emit an empty
    // GIT_CONFIG_VALUE for a bare-key pin.
    if (eq !== -1) env[`GIT_CONFIG_VALUE_${n}`] = kv.slice(eq + 1);
    n++;
  }
  env["GIT_CONFIG_COUNT"] = String(n);
  return env;
}

/** Caller extraEnv may keep ONLY these — everything else is a lever (CX-84). */
const EVIDENCE_EXTRA_ENV_ALLOW = new Set([
  "LC_ALL",
  "LANG",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

/**
 * Caller-owned additions to an evidence env are filtered before merge —
 * an `extraEnv` built from session state must not hand a lever back into
 * the trusted subprocess. Allowlist, not denylist: PATH (the very lever
 * `verifierPath` exists to replace), `http_proxy`/`https_proxy`/
 * `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` MITM redirects, `GIT_*`
 * redirections, preload levers — all dropped (CX-84). Locale/timezone/temp
 * overrides are the only caller concerns the channel honors.
 */
export function filterEvidenceExtraEnv(
  extra: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra ?? {}).filter(([k]) => EVIDENCE_EXTRA_ENV_ALLOW.has(k)),
  );
}

export interface EvidencePreflight {
  /** `-c key=value` pairs neutralizing session-set config keys the static pins miss. */
  configArgs: string[];
  /**
   * `-c` pairs that must NOT sit on a `config` read — `core.hooksPath` is
   * repo truth the install/check surface judges drift through
   * (FLOW-ADOPT-02 reads `config --get core.hooksPath` on this channel);
   * pinning it there answers the pin, not the repo. Applied to every
   * subcommand except `config` — a hook-invoking read (fetch's
   * reference-transaction, CX-74) still needs the dead dir.
   */
  hookArgs: string[];
  /**
   * Session-set keys `-c` cannot neutralize — the transport children that
   * read them (remote helpers, proxies, credential/ssh helpers) are spawned
   * without the parent's cmdline config, so a file value always wins
   * (CX-72/CX-73/CX-76 empirically confirmed on git 2.53). Presence refuses
   * the channel: an evidence answer through an unverifiable lever could be
   * fabricated, and refusing is the only fail-closed answer.
   */
  refusedKeys: string[];
  /**
   * Session-writable `.git` metadata files that rewrite what a read
   * resolves and have NO env/config kill switch — `info/grafts` (grafted
   * parents reach rev-list/merge-base around GIT_NO_REPLACE_OBJECTS,
   * CX-79), `objects/info/alternates` (foreign object store injected into
   * every lookup), `shallow` (fabricated history truncation),
   * `info/attributes` (CX-125: the file needs no program to falsify a
   * content hash — git's BUILT-IN clean-side conversions
   * `working-tree-encoding`/`text`/`eol`/`crlf`/`ident` run inside the
   * index-vs-worktree hash, so a session-set `working-tree-encoding`
   * transcoding to the committed blob's encoding makes status/diff
   * answer clean on completely different worktree bytes; the
   * `core.attributesFile` pin only covers the GLOBAL file — repo-local
   * info/attributes is always consulted and has no kill switch).
   * Presence refuses the channel.
   */
  shapeViolations: string[];
  /**
   * Shape files present with content but unable to falsify committed
   * evidence — `info/exclude` hides UNTRACKED files from status/add
   * listings only; tracked-object reads (the evidence this channel
   * judges) never consult it. Reported for digest diagnostics rather
   * than refused: ordinary repositories legitimately carry excludes,
   * and refusing would fail closed on a file that cannot forge an
   * answer.
   */
  warnedShape: string[];
  /**
   * The verifier-owned claims index — `.git/index` is session-writable
   * and a forged stat tuple answers `status --porcelain` clean on dirty
   * bytes (CX-121), while a HEAD-anchored index cannot express staged or
   * unborn-HEAD state. The index is self-serialized DIRC v2 from
   * `ls-files --stage` claims with zeroed stat, so every
   * index-consulting read (status/diff/ls-files/grep --cached)
   * content-hashes the worktree instead of trusting a session tuple.
   * Held as an inherited fd (`GIT_INDEX_FILE=/dev/fd/3`) so no path a
   * same-uid session can rewrite ever exists (CX-129); platforms
   * without `/dev/fd` keep the on-disk path and re-verify the bytes
   * against `bytes` before every spawn.
   */
  index?: EvidenceIndex;
  /**
   * Set when the claims rebuild could not be proven (CX-124): no
   * verifier-owned index view exists, so index-consulting spawns would
   * consult the session-writable ambient index — exactly the CX-121
   * forgery surface. Index-consulting argv must refuse; non-index
   * reads (rev-parse/cat-file/log/ls-tree/…) never consult the index
   * and stay trustworthy — refusing them wholesale would turn a
   * corrupt-index fixture into a dead channel instead of the per-read
   * degradation the gate contract records.
   */
  indexUnproven?: string;
  /**
   * The session-writable state this judgment was derived from, captured
   * BEFORE the judged reads ran so it never records a surface newer than
   * the one judged (CX-134/CX-135). A cached preflight (OriginGit)
   * re-proves the fingerprint synchronously before every spawn — any
   * drift (config rewrite, new shape file, planted/rewritten object,
   * index rewrite, .git indirection change) discards the cache and
   * re-runs the full preflight, so a post-preflight session write can
   * never ride a stale judgment. Per-call channels re-prove right
   * before the spawn to shrink the judgment→spawn window.
   */
  fingerprint?: EvidenceFingerprint;
}

/**
 * The `.git` surface state a captured preflight judgment depends on.
 * Every member is observable with sync fs calls — no git spawn — so a
 * cached preflight can be re-proven in microseconds (CX-134).
 */
export interface EvidenceFingerprint {
  /**
   * `<repoRoot>/.git` identity: `{dir}` carries the inode+ctime of the
   * directory (a same-uid rename swap keeps the path but changes the
   * inode), `{file}` pins a gitfile's bytes (linked worktrees), and
   * `null` records its absence (non-repo — the op fails on its own).
   */
  dotGit:
    | { kind: "dir"; ino: number; ctimeMs: number }
    | { kind: "file"; bytes: Buffer }
    | { kind: "absent" };
  /** Indirection files a redirect rewrite touches first — gitfile target, commondir. */
  indirection: readonly { path: string; bytes: Buffer | null }[];
  /** The `.git/config` file the judged dump derived from — resolved path + bytes. */
  configPath: string | null;
  configBytes: Buffer | null;
  /** Every `--git-path`-resolved shape path + presence at judgment time. */
  shapeFiles: readonly { path: string; present: boolean }[];
  /** Resolved object store + every file inside it, keyed by relative path. */
  objectsDir: string | null;
  objectFiles: ReadonlyMap<string, { ino: number; ctimeMs: number; size: number }>;
  /** The ambient `.git/index` the claims rebuild enumerated — resolved path + bytes. */
  indexPath: string | null;
  indexBytes: Buffer | null;
}

/**
 * A `.git` index file the verifier owns end to end: `bytes` is the
 * self-serialized DIRC claims index — `fd` (held open, passed to
 * children so `GIT_INDEX_FILE=/dev/fd/3` resolves inside their own fd
 * table) is the airtight form, `path` the no-`/dev/fd` fallback whose
 * on-disk bytes are re-verified against `bytes` before every spawn
 * (CX-129: a same-uid session can enumerate and rewrite anything under
 * `os.tmpdir()`, so the rebuild must not sit there addressably).
 */
export interface EvidenceIndex {
  fd?: number;
  path?: string;
  bytes: Buffer;
}

/**
 * The env/`indexFd` a trusted spawn needs for the verifier index, plus
 * the honesty flag: `unproven` when no proven index view exists —
 * either the rebuild failed (CX-124) or a path-mode index failed its
 * integrity re-read just now (CX-129's post-build rewrite). In fd mode
 * the bytes are pinned by the open file description; a session rewrite
 * of the (already-unlinked) name is impossible.
 */
export function evidenceIndexForSpawn(preflight: EvidencePreflight | null | undefined): {
  env: Record<string, string>;
  indexFd?: number;
  unproven: boolean;
} {
  const flagged = preflight?.indexUnproven !== undefined;
  const idx = preflight?.index;
  if (idx?.fd !== undefined) {
    // A child inheriting fd 3 shares the HELD fd's open file description —
    // its file OFFSET. Two concurrent children then lseek one description
    // through each other (`diff`/`status` races read the index mid-offset
    // and die on corrupt bytes). Reopening `/dev/fd/N` mints an
    // independent description for this spawn only — the caller owns it
    // and closes it once the spawn resolves. The same-uid session can
    // still reach the inode through `/proc/<pid>/fd/` (a nameless
    // O_TMPFILE has no path, but procfs enumerates the process's open
    // fds), so the inode's bytes are re-proven through the fresh
    // description before the child is trusted with them — a rewrite
    // flips the read to unproven, never to a forged index.
    try {
      const childFd = openSync(`/dev/fd/${idx.fd}`, "r");
      const back = Buffer.alloc(idx.bytes.length);
      const got = readSync(childFd, back, 0, idx.bytes.length, 0);
      if (got !== idx.bytes.length || !back.equals(idx.bytes)) {
        closeSync(childFd);
        return { env: {}, unproven: true };
      }
      return { env: { GIT_INDEX_FILE: "/dev/fd/3" }, indexFd: childFd, unproven: flagged };
    } catch {
      return { env: {}, unproven: true };
    }
  }
  if (idx?.path !== undefined) {
    try {
      const onDisk = readFileSync(idx.path);
      if (onDisk.equals(idx.bytes)) {
        return { env: { GIT_INDEX_FILE: idx.path }, unproven: flagged };
      }
    } catch {
      /* unreadable — same as forged */
    }
    return { env: {}, unproven: true };
  }
  return { env: {}, unproven: flagged };
}

/**
 * Close the per-spawn fd `evidenceIndexForSpawn` minted — required on
 * every path that returns BEFORE `spawnCaptured` (which closes it itself
 * once the child inherited its dup).
 */
export function closeSpawnIndexFd(idx: { indexFd?: number }): void {
  if (idx.indexFd !== undefined) {
    try {
      closeSync(idx.indexFd);
    } catch {
      /* already closed */
    }
  }
}

/** Release a preflight's held index fd — per-call channels close it; cached preflights keep it. */
export function closeEvidenceIndex(preflight: EvidencePreflight | null | undefined): void {
  if (preflight?.index?.fd !== undefined) {
    try {
      closeSync(preflight.index.fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * True when `args` consults `.git/index` — directly, as the worktree-
 * enumeration/stat source, or through a `:`-leading index object spec.
 * The judgment is per-argv, not per-subcommand, and every unprovable
 * shape answers true (a refused read is recorded as unreadable; a
 * served forgery is not):
 *
 * - `status`/`ls-files` always read the index.
 * - `diff` ALWAYS counts: only a two-rev tree diff stays off the index,
 *   but rev-vs-path disambiguation cannot be judged textually — an
 *   existing (or even merely pathspec-able) second token makes it a
 *   worktree diff on the ambient index (CX-126), and a staged path can
 *   be forged into it. Under an unproven index every diff refuses.
 * - `describe` consults the index only under `--dirty`/`--broken`
 *   (the worktree-vs-HEAD freshness check is diff-index machinery,
 *   CX-127).
 * - `grep` consults the index unless ≥1 rev-position token forces a
 *   tree walk. Tokens between the pattern and `--` must resolve as
 *   revs or git fails honestly (`fatal: unable to resolve revision`),
 *   so their mere presence is provable — `grep <pattern> -- <path>`
 *   has no rev token and is a worktree grep whose file enumeration
 *   the ambient index drives (CX-128). WITHOUT `--` a post-pattern
 *   bare token cannot be proven a rev textually: a non-rev token
 *   naming an existing file silently becomes a pathspec (CX-133 —
 *   `grep <pat> a.txt` is a worktree grep, not a `grep <pat> a.txt`
 *   tree read), and even a rev-shaped token is ambiguous when a
 *   same-named file exists, so every no-separator grep form is
 *   index-consulting.
 * - any `:<path>`/`:<n>:<path>` spec in ANY op resolves a staged blob
 *   through the index; `:/…`/`:(…)`/`:!…` rev-and-pathspec magics do
 *   not.
 */
const INDEX_SPEC_ARG = /^:(?![/(!+^-])/;
const INDEX_ALWAYS_OPS = new Set(["status", "ls-files"]);
const GREP_INDEX_FLAGS = new Set([
  "--cached",
  "--untracked",
  "--no-index",
  "--exclude-standard",
  "--recurse-submodules",
  "--all-objects",
]);
/** Short grep options whose value is separate (`-e pat`) or attached (`-epat`). */
const GREP_VALUE_SHORT = new Set(["e", "f", "m", "A", "B", "C", "O"]);
export function isIndexConsultingRead(args: readonly string[]): boolean {
  // `:<path>`/`:<stage>:<path>` resolve through the index in ANY op —
  // `:/`, `:(`, `:!`, `:+`, `:^`, `:-` are rev/pathspec magics, not
  // index specs, and a `rev:path` spec never leads with `:`.
  for (const a of args.slice(1)) {
    if (a === ":" || INDEX_SPEC_ARG.test(a)) return true;
  }
  const op = args[0] ?? "";
  if (INDEX_ALWAYS_OPS.has(op)) return true;
  if (op === "diff") return true;
  if (op === "describe") {
    return args.some(
      (a) =>
        a === "--dirty" ||
        a.startsWith("--dirty=") ||
        a === "--broken" ||
        a.startsWith("--broken="),
    );
  }
  if (op !== "grep") return false;
  const dd = args.indexOf("--");
  // No `--` separator: every post-pattern bare token is ambiguous —
  // a non-rev token naming an existing file is a PATHSPEC, not a rev,
  // so the read is a worktree grep the ambient index enumerates
  // (CX-133). `--` is the only shape that cannot hide a pathspec.
  if (dd === -1) return true;
  const head = args.slice(1, dd);
  if (head.some((a) => GREP_INDEX_FLAGS.has(a))) return true;
  // Option-aware rev scan: `-e`/`-f` carry the pattern as an option
  // value so every later non-option token is a rev; otherwise the
  // first non-option token IS the pattern and only the rest can be
  // revs. Unknown bare long options pessimistically eat the next
  // token as their value — miscounting toward FEWER revs only
  // refuses a valid tree grep, never admits a worktree one.
  let patternGiven = false;
  let patternSeen = false;
  let revs = 0;
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    if (a.startsWith("--")) {
      if (a.includes("=")) continue;
      i++; // separate value (known or pessimistically assumed)
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const cluster = a.slice(1);
      const vi = [...cluster].findIndex((c) => GREP_VALUE_SHORT.has(c));
      if (vi === -1) continue;
      if (cluster[vi] === "e" || cluster[vi] === "f") patternGiven = true;
      if (vi === cluster.length - 1) i++; // value is the next token
      continue;
    }
    if (!patternGiven && !patternSeen) {
      patternSeen = true;
      continue;
    }
    revs++;
  }
  return revs === 0;
}

/**
 * Legacy two-argument form kept for callers that carry the preflight:
 * true when the read consults the index AND the preflight could not
 * prove the verifier-owned index view (CX-124's fail-closed rule).
 */
export function isUnprovenIndexRead(
  args: readonly string[],
  preflight?: EvidencePreflight | null,
): boolean {
  return preflight?.indexUnproven !== undefined && isIndexConsultingRead(args);
}

/**
 * repo-config keys every evidence consumer legitimately reads — kept
 * visible. `user.*` is commit-identity input: it cannot reshape a read
 * (recorded names live in objects, not config), and the mutation channel's
 * own `config user.email …` + `commit` sequence on a scratch repo dies on
 * an `=` pin ("empty ident name") — unclassified keys are pinned empty.
 */
const EVIDENCE_CONFIG_KEEP = /^(?:remote\.|url\.|branch\.|user\.)/i;

/** keys whose file VALUE is repo truth — re-inject verbatim, never clear. */
const EVIDENCE_CONFIG_REINJECT =
  /^(?:extensions\.objectformat|extensions\.refstorage|extensions\.compatobjectformat|core\.repositoryformatversion|core\.bare)$/i;

/** config keys naming a program a "read" would exec — neutralize to `cat`. */
const EVIDENCE_CONFIG_EXEC =
  /^(?:diff\.[^.]+\.(?:textconv|command)|interactive\.difffilter|filter\.[^.]+\.(?:clean|smudge|process|driver)|merge\.[^.]+\.driver|gpg\.(?:[\w-]+\.)?program|pager\.|core\.pager|man\.|browser\.|web\.browser|instaweb\.|help\.)/i;

/** config keys naming a file path a "read" would consult — repoint to NUL. */
const EVIDENCE_CONFIG_DEADPATH =
  /^(?:core\.attributesfile|core\.excludesfile|mailmap\.file|mailmap\.blob|diff\.orderfile|gpg\.ssh\.defaultkeycommand)$/i;

/** keys where `key=` (empty) is worse than the file value — pin a safe value. */
const EVIDENCE_CONFIG_SAFE: Readonly<Record<string, string>> = {
  "format.pretty": "oneline",
  "log.date": "iso",
  // The unclassified `=` pin resolved filemode false, which silently hid
  // exec-bit dirt from `status`/`diff` — the channel's own normalization
  // masked a real worktree change. Forcing `true` restores the honest
  // check on filesystems that carry mode bits (r12 hunt note).
  "core.filemode": "true",
};

/** keys the static pins already hold — the dynamic layer adds nothing. */
const EVIDENCE_CONFIG_STATIC = new Set([
  "core.commentchar",
  "trailer.separators",
  "log.showsignature",
  "i18n.logoutputencoding",
  "core.quotepath",
  "color.ui",
  "credential.helper",
  "interactive.difffilter",
  "extensions.worktreeconfig",
  "maintenance.auto",
  "gc.auto",
  "fetch.recursesubmodules",
  "submodule.recurse",
  "protocol.ext.allow",
  "protocol.rsync.allow",
  "protocol.ftp.allow",
  "protocol.ftps.allow",
  "protocol.file.allow",
  "core.attributesfile",
  "core.excludesfile",
  "core.commitgraph",
  "core.multipackindex",
  "pack.usebitmapindex",
]);

/**
 * Keys whose PRESENCE refuses the channel — `-c` never reaches the
 * transport/children that read them, so the file value always wins and
 * no pin can neutralize them (CX-72: `core.gitProxy` still exec'd the
 * session's binary under `-c core.gitProxy=/bin/false`; CX-76:
 * `remote.origin.proxy` and URL-scoped `http.<url>.*` beat the generic
 * pins). `value` narrows the rule to a lever-bearing value — a
 * `credential.helper=` reset or a boolean `core.fsmonitor` carries no
 * program.
 */
const EVIDENCE_CONFIG_REFUSE: ReadonlyArray<{ key: RegExp; value?: RegExp }> = [
  { key: /^include\.path$/i },
  { key: /^includeif\..*\.path$/i },
  { key: /^core\..*gitproxy$/i },
  { key: /^core\.sshcommand$/i },
  { key: /^core\.sshvariant$/i },
  { key: /^core\.askpass$/i },
  { key: /^core\.worktree$/i },
  { key: /^ssh\./i },
  { key: /^http\./i },
  { key: /^protocol\./i },
  // `remote\..+\.` — the name segment must be GREEDY: `o.r` is a legal
  // remote name, and a `[^.]+` class silently exempted `remote.o.r.
  // uploadpack` into KEEP so `fetch o.r` executed it (CX-110).
  {
    key: /^remote\..+\.(?:proxy|proxyauthmethod|vcs|promisor|partialclonefilter|uploadpack|receivepack|tagopt|promirror|followremotehead|prunetags|skipfetchall|mirror)$/i,
  },
  { key: /^extensions\.(?:partialclone|worktreeconfig)$/i },
  { key: /^credential\..*helper$/i, value: /\S/ },
  { key: /^core\.fsmonitor$/i, value: /^(?!$|true$|false$|yes$|no$|on$|off$|1$|0$)/i },
  // `diff.external` names the diff GENERATOR — a program `-c` cannot
  // neutralize (a value execs it; an empty value execs "" — both are a
  // dead or attacker-shaped diff). Presence refuses the channel so a
  // session-set driver can never shape `diff` evidence, and the
  // allowlisted `log -p`/`show`/`diff` internal paths keep working.
  { key: /^diff\.external$/i },
  // `url.<base>.insteadOf`/`.pushInsteadOf` silently retarget EVERY
  // transport — name-positioned AND literal-URL — so `ls-remote origin`
  // answers a session repo's refs while `remote get-url origin` still
  // reports the real URL (CX-131). The key is a URL-keyed multivalued
  // map: no `-c` can enumerate or neutralize the bases, and the
  // channel's transport honesty depends on the spawned argv being the
  // contacted target. Presence refuses the channel.
  { key: /^url\..*\.(?:push)?insteadof$/i },
];

/** The stderr prefix a refused evidence call carries — callers treat it as unverifiable, never as an empty answer. */
export const EVIDENCE_REFUSED_PREFIX = "EVIDENCE-REFUSED";

/** `.git` metadata paths whose presence refuses evidence — resolved via `--git-path` so linked worktrees land on the right common/worktree dir. */
const EVIDENCE_SHAPE_PATHS = [
  "info/grafts",
  "objects/info/alternates",
  "shallow",
  "info/attributes",
] as const;

/**
 * Shape paths reported as diagnostics without refusing — they cannot
 * falsify committed-object reads once the reader pins hold: `info/exclude`
 * hides untracked files only; the commit-graph/MIDX caches are ignored
 * under the `core.commitGraph=false`/`core.multiPackIndex=false` pins
 * (CX-88: a forged graph DID lie before the pin existed).
 */
const EVIDENCE_SHAPE_WARN_PATHS = [
  "info/exclude",
  "objects/info/commit-graph",
  "objects/info/commit-graphs",
  "objects/pack/multi-pack-index",
] as const;

/**
 * `--git-path` query order for the topology check — refuse paths first,
 * then warn-only. Each path is queried by its own `--git-path` call: a
 * resolved path may itself CONTAIN a newline (linked-worktree common dir
 * under a hostile dirname, CX-89), so one multi-query line-split cannot
 * keep the positional mapping honest.
 */
export const EVIDENCE_SHAPE_QUERY_PATHS = [
  ...EVIDENCE_SHAPE_PATHS,
  ...EVIDENCE_SHAPE_WARN_PATHS,
] as const;

/**
 * Raw trusted-git spawn without the config preflight — the preflight's own
 * probe channel, and the binary-reachability probe callers use to tell a
 * dead resolved path (fail loud) from an unenumerable repo (fail closed).
 * `extraEnv` is CHANNEL-owned env merged over the scrub — the trusted-index
 * rebuild uses it to aim `update-index --index-info` at a verifier-created
 * file and to ride the static pins; it is the body's own contract, never a
 * caller lever (GIT_* stays session-stripped).
 */
export function execEvidenceGit(
  cwd: string,
  args: string[],
  opts?: { extraEnv?: Record<string, string>; input?: string | Buffer },
): Promise<VerifierGitResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        resolveGitBin(),
        ["-C", cwd, ...args],
        {
          cwd,
          env: { ...verifierGitEnv(), ...(opts?.extraEnv ?? {}) },
          timeout: 30_000,
          // `--index-info` claims round-trips scale with the repo's
          // tracked set — the 1MB default silently truncates them.
          maxBuffer: 64 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      // A child that exits before stdin drains raises EPIPE on the write —
      // the read already resolves through `close`, so swallow the stream
      // error rather than let it escape as an unhandled rejection.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts?.input ?? "");
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: String(e) });
    }
  });
}

/**
 * One argv-shaped allowlist entry — mirrors the ReadOnlyGitQuery shape in
 * @warpgogol/werkstatt-shared kernel/workspace-io.ts. Forge's `src/` is
 * autonomous (no runtime imports from werkstatt-shared), so the evidence
 * channel keeps its own mirror; the parity test asserts this table never
 * admits an argv the shared read-only table (plus the one pinned fetch
 * form) would not.
 */
interface EvidenceGitQuery {
  prefix: readonly string[];
  forbid?: readonly string[];
  maxPositionals?: number;
}

const BRANCH_WRITE_FLAGS = [
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
] as const;

/**
 * Flags on `config` reads that name a config source other than
 * `.git/config` or fabricate an answer (CX-96) — plus the write-action
 * spellings a read channel has no use for. `-f` covers `--file`'s
 * short form inside clusters.
 */
const CONFIG_SOURCE_FLAGS = [
  "--file",
  "-f",
  "--blob",
  "--worktree",
  "--system",
  "--global",
  "--default",
  "--includes",
  "--add",
  "--unset",
  "--unset-all",
  "--rename-section",
  "--remove-section",
] as const;

/** Flags on `cat-file` that reach a repo-config program or bytes outside the object store. */
const CAT_FILE_LEVER_FLAGS = [
  "--filters",
  "--filter",
  "--textconv",
  "--path",
  "--follow-symlinks",
  "--batch",
  "--batch-check",
  "--batch-command",
  "--batch-all-objects",
  "--buffer",
  "--unordered",
] as const;

/**
 * The argv space `gitEvidence` may spawn — a mirror of the shared
 * READ_ONLY_GIT_QUERIES table — pure reads only: the one mutating op
 * (`fetch`) was removed because every remote it can name is
 * session-authored, so its answer can never be trusted evidence
 * (CX-132) — and it also wrote session-shaped refs into the tracking
 * namespace inside the trusted channel.
 * channel legitimately runs (it refreshes remote-tracking refs through
 * the single pinned refspec shape `isEvidenceFetchTail` admits —
 * `+refs/heads/*:refs/remotes/origin/*`, never a local branch; the
 * `--upload-pack`/`--exec` levers that exec a repo-config program on the
 * remote side stay forbidden). `config` is admitted only in its
 * `config --get*` forms — a bare `config` argv could write repo state on
 * the trusted channel. `diff --no-index` is out (CX-75: an admitted
 * arbitrary-file diff leaked `/etc/passwd` bytes into evidence stdout),
 * and `cat-file`'s `--filters`/`--textconv`/`--path` flags are out —
 * each reaches a repo-config program (CX-74).
 */
const EVIDENCE_GIT_QUERIES: readonly EvidenceGitQuery[] = [
  { prefix: ["--version"], maxPositionals: 0 },
  { prefix: ["rev-parse"] },
  { prefix: ["worktree", "list"] },
  { prefix: ["ls-files"], forbid: ["--recurse-submodules"] },
  { prefix: ["ls-tree"] },
  { prefix: ["cat-file"], forbid: CAT_FILE_LEVER_FLAGS },
  // `-g`/`--reflog` serve REFLOG data — fabricated by ordinary session
  // update-ref churn and anchored to nothing verifiable (CX-92). Long
  // and short spellings both stay out.
  // `--use-bitmap-index`/`--test-bitmap` opt into the session-writable
  // pack bitmap cache — the same fabricated-topology class the
  // commitGraph/MIDX pins closed (CX-98).
  {
    prefix: ["rev-list"],
    forbid: ["--output", "--walk-reflogs", "-g", "--reflog", "--use-bitmap-index", "--test-bitmap"],
  },
  { prefix: ["merge-base"], forbid: ["--fork-point"] },
  // `--stdin`/`--exclude-existing` block on input the no-stdin evidence
  // spawn never supplies — the channel hangs to timeout (CX-101).
  { prefix: ["for-each-ref"], forbid: ["--stdin"] },
  { prefix: ["show-ref"], forbid: ["--stdin", "--exclude-existing"] },
  { prefix: ["describe"] },
  { prefix: ["status"] },
  {
    prefix: ["log"],
    forbid: [
      "--output",
      "--ext-diff",
      "--textconv",
      "--walk-reflogs",
      "-g",
      "--reflog",
      "--use-bitmap-index",
      "--test-bitmap",
    ],
  },
  { prefix: ["diff"], forbid: ["--output", "--ext-diff", "--textconv", "--no-index"] },
  { prefix: ["show"], forbid: ["--output", "--ext-diff", "--textconv", "-g", "--reflog"] },
  { prefix: ["symbolic-ref"], forbid: ["-d", "--delete", "-m"], maxPositionals: 1 },
  // Config reads answer from .git/config only — the `--file`/`--blob`/
  // `--worktree` source flags name an alternate config store (a
  // session-named file, a committed blob, config.worktree read even
  // under the disabled-extension pin) and return fabricated values into
  // evidence (CX-96). `--default` fabricates the answer when the key is
  // absent, and write-action flags stay out even though git rejects
  // them combined with reads.
  { prefix: ["config", "--get"], forbid: CONFIG_SOURCE_FLAGS },
  { prefix: ["config", "--get-all"], forbid: CONFIG_SOURCE_FLAGS },
  { prefix: ["config", "--get-regexp"], forbid: CONFIG_SOURCE_FLAGS },
  // The preflight's own enumeration of the local config — a list is a
  // read; --no-includes keeps the dump to .git/config so include.path
  // keys surface as refusable levers instead of silently expanding.
  { prefix: ["config", "--local", "--no-includes", "--list"], forbid: CONFIG_SOURCE_FLAGS },
  { prefix: ["remote", "get-url"] },
  // No transport ops: `ls-remote`/`fetch` contact whatever the session
  // named as the remote — `remote.<name>.url`, `branch.<b>.remote`, or a
  // literal positional are all session-authored under the same-uid
  // threat model, so a transport answer can never be trusted evidence
  // (CX-132). Scheme pins cannot help — `git://`/`http(s)://`/`ssh://`
  // all reach session-owned listeners.
  { prefix: ["branch", "--show-current"], maxPositionals: 0 },
  { prefix: ["branch", "--list"], forbid: BRANCH_WRITE_FLAGS },
  // `git grep` is a read — but `-O`/`--open-files-in-pager` execs the pager
  // program, `--recurse-submodules` descends into foreign object stores,
  // `--pathspec-from-file`/`--pathspec-file-nul` reads a session file for the
  // pattern set (a file could hide entries from the listing), and
  // `--untracked`/`--no-index`/`--all-objects` move the read off the
  // committed/index surface the channel proves (CX-115-class: config/exec
  // levers on a read subcommand).
  {
    prefix: ["grep"],
    forbid: [
      "-O",
      "--open-files-in-pager",
      "--recurse-submodules",
      "--pathspec-from-file",
      "--pathspec-file-nul",
      "--untracked",
      "--no-index",
      "--all-objects",
    ],
  },
];

/**
 * Same forbidden-argument judgment as the shared table: a long flag
 * exactly, with `=value`, or abbreviated; a short flag alone or inside a
 * cluster. Over-matching a harmless arg only refuses a read — safe.
 */
function isForbiddenEvidenceArg(arg: string, forbid: readonly string[]): boolean {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0];
    if (name.length === 0) return false;
    return forbid.some((f) => f.startsWith("--") && f.slice(2).startsWith(name));
  }
  if (arg.startsWith("-") && arg.length > 1) {
    const cluster = arg.slice(1);
    return forbid.some((f) => /^-[^-]$/.test(f) && cluster.includes(f[1]));
  }
  return false;
}

/**
 * Runtime argv judgment for the evidence channel — the predicate the
 * static scan assumes exists behind `gitEvidence` the way
 * isReadOnlyGitQuery sits behind `git()` on io.exec (CX-70: a dynamic
 * argv tail like `["log", ...flags]` was static-exempt and ran unjudged,
 * so `--ext-diff`/`--output` could reach the trusted subprocess). The
 * body-owned `-C`/`-c` pins are added after this check and are not part
 * of the judged argv.
 */
export function isEvidenceGitQuery(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  // `@{...}` ref syntax is a fabrication channel everywhere it appears —
  // `@{N}` reads the session-fabricable reflog (CX-92's positional twin)
  // and `@{u}`/`@{push}`/`@{upstream}` silently follow the session's own
  // branch.*.merge config instead of the ref the caller named.
  if (args.some((a) => a.includes("@{"))) return false;
  return EVIDENCE_GIT_QUERIES.some((query) => {
    if (!query.prefix.every((part, i) => args[i] === part)) return false;
    const tail = args.slice(query.prefix.length);
    if (query.forbid !== undefined && tail.some((a) => isForbiddenEvidenceArg(a, query.forbid!))) {
      return false;
    }
    if (query.maxPositionals !== undefined) {
      const positionals = tail.filter((arg) => !arg.startsWith("-")).length;
      if (positionals > query.maxPositionals) return false;
    }
    return true;
  });
}

/**
 * The argv space `verifierGit` may spawn — the evidence read table minus
 * `fetch` (nothing on the runner/policy path refreshes remotes). This is
 * the CX-108/109 boundary: the channel used to scan only for
 * `@{…}`/reflog-shaped args, so `reflog`/`stash`/`update-ref`/
 * `config`-writes and every leading global option rode through — and a
 * caller `-c`/`--git-dir` lands AFTER the pins where the last write wins.
 * Nothing outside the table prefixes can be proven safe, so the table is
 * the allowlist, not a denylist.
 */
export function isVerifierGitQuery(args: readonly string[]): boolean {
  return args.length > 0 && isEvidenceGitQuery(args);
}

/**
 * Mutating ops the adversarial runner may run on its OWN scratch clone —
 * bounded so a scenario-authored token can never reach `reflog`/`stash`/
 * `update-ref` or the exec/redirect levers; everything else takes the
 * evidence read table (CX-108/109).
 */
const SCRATCH_GIT_OPS: Readonly<Record<string, readonly string[]>> = {
  // clone's levers reach programs or foreign object stores — and the
  // copy-local forms would hardlink the source's session-writable
  // objects dir into the scratch clone.
  clone: [
    "-u",
    "--upload-pack",
    "--template",
    "-c",
    "--config",
    "-s",
    "--shared",
    "--separate-git-dir",
    "--bundle-uri",
    "--reference",
    "--dissociate",
    "--local",
    "-l",
    "--recurse-submodules",
    "--server-option",
  ],
  // config writes are the op's purpose on scratch — the source selectors
  // still reach stores outside the clone.
  config: [
    "--file",
    "-f",
    "--blob",
    "--worktree",
    "--system",
    "--global",
    "--default",
    "--includes",
    "--show-origin",
    "--rename-section",
    "--remove-section",
  ],
  // message/exec levers: file/template/foreign-commit message sources,
  // signing, editor loops, partial staging, and hook bypass.
  commit: [
    "-e",
    "--edit",
    "-F",
    "--file",
    "-C",
    "--reuse-message",
    "-c",
    "--reedit-message",
    "-t",
    "--template",
    "--amend",
    "--author",
    "--date",
    "--no-verify",
    "--verify",
    "-s",
    "--signoff",
    "-i",
    "--include",
    "-o",
    "--only",
    "-p",
    "--patch",
    "--interactive",
    "-S",
    "--gpg-sign",
  ],
  init: [],
  add: [],
  rm: [],
  mv: [],
  branch: [],
  tag: [],
  checkout: [],
  switch: [],
  restore: [],
  remote: [],
  worktree: [],
};

/**
 * Runtime argv judgment for the scratch-repo channel — `verifierScratchGit`
 * spawns the same trusted binary/env as `verifierGit`, but the argv is
 * the bounded mutation set above or the read table; a scenario-authored
 * string can never name `reflog`/`stash`/`update-ref`/`config --file` or
 * a global-option redirect (CX-108/109).
 */
export function isScratchGitQuery(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args.some((a) => a.includes("@{"))) return false;
  const forbid = SCRATCH_GIT_OPS[args[0]!];
  if (forbid !== undefined) {
    return !args.slice(1).some((a) => isForbiddenEvidenceArg(a, forbid));
  }
  return isVerifierGitQuery(args);
}

/**
 * Stat tuple a session cannot restore after a rewrite. `utimes` sets
 * atime/mtime only — ctime is kernel-managed and changes on every
 * content or metadata write (CX-114: an equal-size in-place rewrite with
 * the memoized mtime restored slipped the r8 (mtimeMs,size) memo).
 * `ino` additionally catches rename-replace: a session swapping the
 * verified file for a same-size, back-dated sibling lands on a new inode.
 */
interface VerifiedStat {
  ino: number;
  ctimeMs: number;
  size: number;
}

function statKeyMatches(memo: VerifiedStat | undefined, st: VerifiedStat): boolean {
  return (
    memo !== undefined &&
    memo.ino === st.ino &&
    memo.ctimeMs === st.ctimeMs &&
    memo.size === st.size
  );
}

/**
 * Verified loose-object files — keyed by absolute path with the stat
 * triple a rewrite cannot preserve. Loose objects are write-once for
 * git, so a matching (ino, ctimeMs, size) tuple means the file's hash
 * check still stands; a session rewriting the file in place (`chmod`,
 * new bytes — CX-104's shadow path) bumps ctime and forces a re-hash,
 * and a same-stat rewrite is impossible because ctime is not settable
 * (CX-114).
 */
const verifiedLooseFiles = new Map<string, VerifiedStat>();
const LOOSE_FANOUT_RE = /^[0-9a-f]{2}$/;
const LOOSE_NAME_RE = /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/;

/**
 * Re-hash every loose object under the resolved `--git-path objects`
 * directory: git resolves `<2-hex>/<rest>` files BY PATH and serves their
 * zlib payload verbatim without re-hashing, and a loose file shadows the
 * packed copy — so a file whose inflated bytes do not hash to its
 * sha-shaped name is a verbatim forgery every object read would serve
 * (CX-104). An unreadable/corrupt entry is deliberately NOT counted —
 * git cannot serve it either, so reads touching it fail with git's own
 * error and the per-read "a git read failed" contract stays intact.
 * Returns `objects/…` names for the violation list; the
 * (ino, ctimeMs, size) memo keeps the cost at "objects written since the
 * last scan" per call.
 */
function scanLooseObjects(objectsDir: string): string[] {
  const forged: string[] = [];
  let fanout: string[];
  try {
    fanout = readdirSync(objectsDir);
  } catch {
    return forged;
  }
  for (const dir of fanout) {
    if (!LOOSE_FANOUT_RE.test(dir)) continue;
    const absDir = path.join(objectsDir, dir);
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!LOOSE_NAME_RE.test(name)) continue;
      const abs = path.join(absDir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const stKey: VerifiedStat = { ino: st.ino, ctimeMs: st.ctimeMs, size: st.size };
      if (statKeyMatches(verifiedLooseFiles.get(abs), stKey)) continue;
      let ok = false;
      let servable = true;
      try {
        const inflated = inflateSync(readFileSync(abs));
        const algo = name.length === 38 ? "sha1" : "sha256";
        ok = createHash(algo).update(inflated).digest("hex") === `${dir}${name}`;
      } catch {
        // Not a servable object — git's own read of it fails, which is
        // the per-read failure contract the corrupt-store fixtures rely
        // on. Only a file whose bytes CAN be served under a false name
        // is a forgery the channel must refuse wholesale.
        servable = false;
      }
      if (ok) {
        if (verifiedLooseFiles.size > 200_000) verifiedLooseFiles.clear();
        verifiedLooseFiles.set(abs, stKey);
      } else if (servable) {
        forged.push(`objects/${dir}/${name}`);
      }
    }
  }
  return forged;
}

/**
 * Verified pack indexes — keyed by absolute `.idx` path on the same
 * unforgeable (ino, ctimeMs, size) stat triple as the loose memo. A
 * session-written `pack-*.pack`+`.idx` pair serves inflated bytes for
 * ANY object name its idx claims — git resolves pack entries by idx
 * name and never re-hashes on read, so a pack whose objects do not hash
 * to their claimed names is the CX-104 forgery on the path the loose
 * sweep cannot see (CX-113). `git verify-pack -s` rebuilds every
 * object's name from its inflated content and fails the idx when a
 * claimed name mismatches (empirically confirmed on git 2.53 — a forged
 * idx+pack pair exits 1, a repacked store exits 0).
 *
 * Only `.idx` files whose sibling `.pack` exists are checked: git
 * iterates pack content through the idx, so an orphaned idx or an
 * unindexed pack is unservable — the same "git fails its own read"
 * contract the loose sweep keeps for corrupt entries.
 */
const verifiedPackFiles = new Map<string, VerifiedStat>();

export async function scanPackObjects(objectsDir: string): Promise<string[]> {
  const forged: string[] = [];
  const packDir = path.join(objectsDir, "pack");
  let names: string[];
  try {
    names = readdirSync(packDir);
  } catch {
    return forged;
  }
  for (const name of names) {
    if (!name.endsWith(".idx")) continue;
    const absIdx = path.join(packDir, name);
    // A .pack without .idx is unservable (git opens packs via the idx);
    // an .idx without .pack fails git's own read — same corrupt-store
    // contract as un-inflatable loose objects, not a refuse violation.
    if (!existsSync(absIdx.slice(0, -4) + ".pack")) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(absIdx);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const stKey: VerifiedStat = { ino: st.ino, ctimeMs: st.ctimeMs, size: st.size };
    if (statKeyMatches(verifiedPackFiles.get(absIdx), stKey)) continue;
    const r = await execEvidenceGit(path.dirname(packDir), ["verify-pack", "-s", absIdx]);
    if (r.exitCode === 0) {
      if (verifiedPackFiles.size > 4_000) verifiedPackFiles.clear();
      verifiedPackFiles.set(absIdx, stKey);
    } else {
      forged.push(`objects/pack/${name}`);
    }
  }
  return forged;
}

let evidenceIndexSeq = 0;
/**
 * The named-fallback index file name — flat under the OS temp root,
 * unique per process + sequence. A same-uid session can still discover
 * and overwrite the file, but the per-spawn byte re-prove turns any
 * rewrite into `indexUnproven` (a refused read), never a forged view
 * (CX-129).
 */
function evidenceIndexName(): string {
  return `forge-evidence-index-${process.pid}-${++evidenceIndexSeq}`;
}

/**
 * Build the throwaway index index-consulting reads (status/diff/ls-files)
 * must see — a verifier-owned rebuild of the session index's CLAIMS.
 * `.git/index` is session-writable in three ways a HEAD-anchored
 * `read-tree` index both fixes and breaks: it drops forged stat tuples
 * (CX-121) but also drops the session's real staged entries, and it
 * cannot exist at all on an unborn HEAD — `status --porcelain -uno` then
 * hides staged dirt and `ls-files` answers empty on a populated index.
 * So the verifier index is rebuilt from `ls-files --stage` output: the
 * listing carries only `mode sha stage path` claims — no stat cache, no
 * assume-unchanged/skip-worktree flags — and `--index-info` writes the
 * entries back with ZEROED stat. Every index-vs-worktree column then
 * content-hashes instead of trusting a tuple the session wrote, while
 * staged-vs-HEAD columns still show what the session index claims —
 * a forged claim can only fabricate dirt, never hide it. Each call gets
 * a fresh file: concurrent preflights in one process must not interleave
 * writes into a shared index.
 *
 * A failed enumeration or rebuild is FAIL-CLOSED (CX-124): `failure`
 * carries a shape-violation string the caller pushes into the preflight,
 * so every index-consulting read refuses outright. Falling back to the
 * ambient index would route the verdict at the session-writable
 * `.git/index` — exactly the CX-121 forgery surface — so an unprovable
 * index must refuse, never degrade.
 */
export interface EvidenceIndexPreparation {
  /** The verifier-owned claims index; absent on failure. */
  index?: EvidenceIndex;
  /** Failure string when the rebuild could not be proven. */
  failure?: string;
}

interface IndexClaim {
  mode: number;
  sha: Buffer;
  stage: number;
  name: Buffer;
}

/**
 * `ls-files --stage -z` emits `mode SP sha SP stage TAB name NUL` — the
 * session index's OBJECT CLAIMS only: no stat tuples, no
 * assume-unchanged/skip-worktree flags. Claims are sorted by (name,
 * stage) byte order because the DIRC writer and `git diff-index`
 * disagree on unordered input.
 */
function parseIndexClaims(listing: string): IndexClaim[] | null {
  const claims: IndexClaim[] = [];
  for (const rec of listing.split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("\t");
    const meta = /^([0-7]+) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(
      tab === -1 ? rec : rec.slice(0, tab),
    );
    if (meta === null || tab === -1) return null;
    claims.push({
      mode: Number.parseInt(meta[1]!, 8),
      sha: Buffer.from(meta[2]!, "hex"),
      stage: Number.parseInt(meta[3]!, 10),
      name: Buffer.from(rec.slice(tab + 1), "utf8"),
    });
  }
  claims.sort((a, b) =>
    Buffer.compare(a.name, b.name) !== 0 ? Buffer.compare(a.name, b.name) : a.stage - b.stage,
  );
  return claims;
}

/**
 * Serialize claims into a minimal DIRC v2/v3 index — the on-disk format
 * `GIT_INDEX_FILE` consumes: header, `zero-stat + mode + sha + flags +
 * name` entries (8-byte aligned), trailer digest over the whole image.
 * v3 is chosen only when a pathname exceeds 0xFFF bytes (v2's flags
 * field cannot express the long-name marker). Zeroed stat means every
 * index-vs-worktree comparison falls back to content hashing — a forged
 * stat tuple can never answer "clean" through this index (CX-121), and
 * the claims themselves can only fabricate dirt (an index entry a
 * session never staged), never hide real dirt.
 */
function serializeIndexClaims(claims: IndexClaim[]): Buffer {
  const shaBytes = claims.find((c) => c.sha.length === 32) ? 32 : 20;
  const longName = claims.some((c) => c.name.length > 0xfff);
  const fixedLen = 40 + shaBytes + 2; // stat block + object id + flags
  const entries = claims.map((c) => {
    const rawLen = fixedLen + c.name.length;
    const entry = Buffer.alloc(Math.ceil((rawLen + 1) / 8) * 8); // ≥1 NUL, 8-byte aligned
    // stat block = ctime(2) mtime(2) dev ino mode uid gid size → 10 u32;
    // everything zero except the file MODE (u32 #7, offset 24) — zeroed
    // tuples force content hashing, but the entry must still carry its
    // real mode or the index records a different file type.
    entry.writeUInt32BE(c.mode, 24);
    c.sha.copy(entry, 40);
    const flags = (c.stage << 12) | Math.min(c.name.length, 0xfff);
    entry.writeUInt16BE(flags, 40 + shaBytes);
    c.name.copy(entry, 40 + shaBytes + 2);
    return entry;
  });
  const header = Buffer.alloc(12);
  header.write("DIRC", 0);
  header.writeUInt32BE(longName ? 3 : 2, 4);
  header.writeUInt32BE(claims.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const digest = shaBytes === 32 ? createHash("sha256") : createHash("sha1");
  digest.update(body);
  return Buffer.concat([body, digest.digest()]);
}

/**
 * Held index bytes a same-uid session can never reach: prefer
 * O_TMPFILE — an unnamed inode, never path-addressable; fall back to a
 * named file that is written, reopened read-only, byte-proven, and
 * unlinked while the fd is still held. The fd is what children inherit
 * as fd 3 (`GIT_INDEX_FILE=/dev/fd/3`) — a rewrite attack has no path
 * left to target (CX-129).
 */
function createHeldIndexFile(bytes: Buffer): number | null {
  const oTmpfile = (fsConstants as { O_TMPFILE?: number }).O_TMPFILE;
  if (typeof oTmpfile === "number") {
    // O_TMPFILE straight on the OS temp root — the inode is created
    // NAMELESS, so nothing ever lands in a directory listing for a
    // same-uid session to discover, chmod, or overwrite (CX-129). `/tmp`
    // is root-owned/sticky — the session cannot chmod the dir itself to
    // block the creation, and no `forge-evidence-idx-*` name exists for
    // its enumeration probes to find.
    try {
      const fd = openSync(os.tmpdir(), oTmpfile | fsConstants.O_RDWR, 0o600);
      writeSync(fd, bytes);
      return fd;
    } catch {
      /* tmpfs/fs lacks O_TMPFILE — named fallback below */
    }
  }
  const p = path.join(os.tmpdir(), evidenceIndexName());
  try {
    writeFileSync(p, bytes, { mode: 0o600 });
    const fd = openSync(p, "r");
    const back = Buffer.alloc(bytes.length);
    const got = readSync(fd, back, 0, bytes.length, 0);
    unlinkSync(p);
    if (got !== bytes.length || !back.equals(bytes)) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    rmSync(p, { force: true });
    return null;
  }
}

export async function prepareEvidenceIndex(repoRoot: string): Promise<EvidenceIndexPreparation> {
  // The claims listing spawns with the static pins via env: `ls-files`
  // consults `core.fsmonitor` even for a pure --stage dump — a session
  // program must not exec inside the enumeration (CX-115 class).
  const claims = await execEvidenceGit(repoRoot, ["ls-files", "--stage", "-z"], {
    extraEnv: evidencePinEnv(["ls-files"]),
  });
  if (claims.exitCode !== 0) {
    return {
      failure: `.git/index claims enumeration failed (git ls-files --stage, exit ${claims.exitCode})`,
    };
  }
  const parsed = parseIndexClaims(claims.stdout);
  if (parsed === null) {
    return { failure: ".git/index claims listing is unparsable (forged --stage output)" };
  }
  const bytes = serializeIndexClaims(parsed);
  const fd = createHeldIndexFile(bytes);
  if (fd !== null && existsSync("/dev/fd")) {
    return { index: { fd, bytes } };
  }
  if (fd !== null) closeSync(fd);
  // No /dev/fd (win32): the on-disk fallback stays addressable but every
  // spawn re-verifies its bytes against `bytes` before trusting it —
  // a session rewrite flips the index to unproven, never to forged data.
  const p = path.join(os.tmpdir(), evidenceIndexName());
  try {
    writeFileSync(p, bytes, { mode: 0o600 });
  } catch (e) {
    return { failure: `.git/index claims write failed (${(e as Error).message})` };
  }
  return { index: { path: p, bytes } };
}

/**
 * Pure half of the repo-surface preflight: judge an already-captured
 * `.git/config` dump (`config --local --no-includes --list --null` — the
 * include keys themselves still appear, which is exactly what the refuse
 * rules need) and the `--git-path`-resolved topology metadata `.git`
 * honors without any config. Returns the extra `-c` pins that neutralize
 * callback-scope levers (diff/filter/merge drivers, pagers, mailmap,
 * orderFile) plus the keys and files that can only be refused. Carries no
 * spawn of its own — callers feed it output from their own channel so the
 * only subprocess on the evidence path stays inside the argv-judged body
 * (the read-only scan exempts that body callsite-by-callsite).
 *
 * `shapePaths` carries one resolved `--git-path` answer per
 * EVIDENCE_SHAPE_QUERY_PATHS entry (null = the query failed) — the caller
 * runs one query per path because a resolved path can itself embed a
 * newline and silently misalign a positional line map (CX-89).
 *
 * `objectsDir` carries the resolved `--git-path objects` answer — when
 * provided, every loose object file is re-hashed against its sha-shaped
 * name because git serves loose bytes verbatim by path without verifying
 * (CX-104); an unresolved objects dir contributes a violation, not a
 * skipped check.
 */
export function judgeEvidenceRepoSurface(
  repoRoot: string,
  listedStdout: string,
  shapePaths: readonly (string | null)[],
  objectsDir?: string | null,
): EvidencePreflight {
  const configArgs: string[] = [];
  const hookArgs: string[] = [];
  const refusedKeys: string[] = [];
  const shapeViolations: string[] = [];
  const warnedShape: string[] = [];
  for (const entry of listedStdout.split("\0")) {
    if (entry.length === 0) continue;
    const nl = entry.indexOf("\n");
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    if (EVIDENCE_CONFIG_REFUSE.some((r) => r.key.test(key) && (r.value?.test(value) ?? true))) {
      if (!refusedKeys.includes(key)) refusedKeys.push(key);
      continue;
    }
    // `remote.<name>.fetch` UNIONs with the pinned fetch's cmdline
    // refspec — a configured spec outside the clone-default
    // `+refs/heads/*:refs/remotes/<name>/*` shape writes arbitrary local
    // refs inside the trusted fetch (CX-94). Only wildcard-heads into the
    // remote's own tracking namespace stays KEEP; every other value
    // refuses (empty values and non-wildcard specs included). The name
    // segment is GREEDY — a dot-named remote (`o.r`) must not escape the
    // judgment into plain KEEP (CX-110).
    const fetchSpec = /^remote\.(.+)\.fetch$/i.exec(key);
    if (
      fetchSpec !== null &&
      !new RegExp(
        `^\\+?refs/heads/\\*:refs/remotes/${fetchSpec[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\*$`,
        "i",
      ).test(value)
    ) {
      if (!refusedKeys.includes(key)) refusedKeys.push(key);
      continue;
    }
    if (EVIDENCE_CONFIG_KEEP.test(key)) continue;
    if (key === "core.hookspath") {
      hookArgs.push("-c", `core.hooksPath=${DEVNULL}`);
      continue;
    }
    if (EVIDENCE_CONFIG_REINJECT.test(key)) {
      configArgs.push("-c", `${key}=${value}`);
      continue;
    }
    if (EVIDENCE_CONFIG_EXEC.test(key)) {
      configArgs.push("-c", `${key}=cat`);
      continue;
    }
    if (EVIDENCE_CONFIG_DEADPATH.test(key)) {
      configArgs.push("-c", `${key}=${DEVNULL}`);
      continue;
    }
    const safe = EVIDENCE_CONFIG_SAFE[key];
    if (safe !== undefined) {
      configArgs.push("-c", `${key}=${safe}`);
      continue;
    }
    if (EVIDENCE_CONFIG_STATIC.has(key)) continue;
    configArgs.push("-c", `${key}=`);
  }
  shapePaths.forEach((resolvedPath, i) => {
    if (resolvedPath === null) return;
    // `--git-path` answers relative to the queried repo — resolve against
    // repoRoot, never the process cwd, or the file check reads nothing.
    // A newline inside the path itself is preserved (per-path queries,
    // CX-89) and resolves to the real file location.
    const abs = path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(repoRoot, resolvedPath);
    let body = "";
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    // Any non-empty non-comment line is content. git's parsers comment
    // col-0 `#` only — a whitespace-only line is a LITERAL path entry
    // (`.git/objects/   `, CX-91) and so is `   # x` (`.git/objects/   # x`,
    // CX-95); only a bare first-byte `#` is a comment.
    const effective = body.split("\n").some((l) => l.length > 0 && !l.startsWith("#"));
    if (!effective) return;
    const name = EVIDENCE_SHAPE_QUERY_PATHS[i] ?? abs;
    if (i < EVIDENCE_SHAPE_PATHS.length) shapeViolations.push(name);
    else warnedShape.push(name);
  });
  // Loose-object integrity (CX-104): git serves loose bytes by PATH and
  // never re-hashes on read — a file at `objects/ab/<rest>` whose
  // inflated content does not hash to `ab<rest>` is a verbatim forgery
  // that shadows the packed copy. An unresolved objects dir means the
  // store cannot be proven — refuse, never skip the check.
  if (objectsDir === null) {
    shapeViolations.push("objects");
  } else if (objectsDir !== undefined) {
    const absObjects = path.isAbsolute(objectsDir)
      ? objectsDir
      : path.resolve(repoRoot, objectsDir);
    shapeViolations.push(...scanLooseObjects(absObjects));
  }
  return { configArgs, hookArgs, refusedKeys, shapeViolations, warnedShape };
}

function safeReadBytes(abs: string): Buffer | null {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

/**
 * Every file inside the object store, keyed by path relative to the
 * objects dir — loose objects, packs, `info/*`, and any session-dropped
 * extra file. The stat triple (ino, ctimeMs, size) is unforgeable: ctime
 * is kernel-managed (CX-114), so a rewrite, a replant, or a new file is
 * always drift — never a stale-but-consistent fingerprint.
 */
function enumerateObjectFiles(
  objectsDir: string,
): Map<string, { ino: number; ctimeMs: number; size: number }> {
  const files = new Map<string, { ino: number; ctimeMs: number; size: number }>();
  for (let i = 0, stack = [""]; i < stack.length; i++) {
    const rel = stack[i]!;
    let entries;
    try {
      entries = readdirSync(path.join(objectsDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const er = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        stack.push(er);
      } else if (e.isFile()) {
        try {
          const st = statSync(path.join(objectsDir, er));
          files.set(er, { ino: st.ino, ctimeMs: st.ctimeMs, size: st.size });
        } catch {
          /* vanished mid-scan — the judge's own sweep sees the same state */
        }
      }
    }
  }
  return files;
}

/**
 * The `rev-parse --git-path` resolves + `.git` indirection + fingerprint —
 * one fused surface-capture (CX-134/CX-135) so callers cannot misorder
 * the three steps. Ordering contract: indirection bytes are read BEFORE
 * the resolves they govern (a redirect rewrite is always
 * later-than-fingerprint, so reprove reads it as drift, never a
 * consistent stale world), and the fingerprint freezes same-or-older
 * state BEFORE any judged read the caller runs next (config dump, shape
 * bodies, object scans, index claims). `config`/`index`/`objects` join
 * the shape query list so the fingerprint pins the very files the judged
 * dump/claims derive from. A failed resolve yields `null` for that path
 * (the judge counts it a violation); `anyFailed` distinguishes "git
 * itself is dead" from "this path is absent" for the caller's own error
 * contract. Each query is its own spawn — a resolved path may itself
 * contain a newline (CX-89). The returned `*Path` fields are the raw
 * resolves for the judge; the fingerprint pins their absolute forms.
 */
export async function captureEvidenceSurface(
  repoRoot: string,
  runGit: EvidenceGitRunner,
): Promise<{
  configPath: string | null;
  indexPath: string | null;
  objectsDir: string | null;
  shapePaths: (string | null)[];
  anyFailed: boolean;
  fingerprint: EvidenceFingerprint;
}> {
  const dotGitAbs = path.join(repoRoot, ".git");
  const indirection: { path: string; bytes: Buffer | null }[] = [];
  let dotGit: EvidenceFingerprint["dotGit"] = { kind: "absent" };
  try {
    const st = statSync(dotGitAbs);
    if (st.isDirectory()) {
      dotGit = { kind: "dir", ino: st.ino, ctimeMs: st.ctimeMs };
      indirection.push({
        path: path.join(dotGitAbs, "commondir"),
        bytes: safeReadBytes(path.join(dotGitAbs, "commondir")),
      });
    } else if (st.isFile()) {
      const bytes = readFileSync(dotGitAbs);
      dotGit = { kind: "file", bytes };
      // gitfile → worktree metadir → commondir/gitdir pin the redirect chain.
      const m = /^gitdir:\s*(.+)$/m.exec(bytes.toString("utf8").trim());
      if (m !== null) {
        const meta = path.isAbsolute(m[1]!.trim())
          ? m[1]!.trim()
          : path.resolve(repoRoot, m[1]!.trim());
        indirection.push({
          path: path.join(meta, "gitdir"),
          bytes: safeReadBytes(path.join(meta, "gitdir")),
        });
        indirection.push({
          path: path.join(meta, "commondir"),
          bytes: safeReadBytes(path.join(meta, "commondir")),
        });
      }
    }
  } catch {
    /* .git absent — the op fails on its own */
  }
  const queries = ["config", "index", "objects", ...EVIDENCE_SHAPE_QUERY_PATHS];
  const pending: Promise<{ exitCode: number | null; stdout: string; stderr: string }>[] = [];
  for (const p of queries) {
    pending.push(runGit(repoRoot, ["rev-parse", "--git-path", p], { preflight: false }));
  }
  const results = await Promise.all(pending);
  let anyFailed = false;
  const resolved: (string | null)[] = [];
  for (const r of results) {
    if (r.exitCode !== 0) {
      anyFailed = true;
      resolved.push(null);
    } else {
      // strip exactly the terminating newline — a newline inside the path
      // itself is real and must reach the resolver (CX-89)
      resolved.push(r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout);
    }
  }
  const [configPath, indexPath, objectsDir, ...shapePaths] = resolved;
  const configAbs =
    configPath === null
      ? null
      : path.isAbsolute(configPath)
        ? configPath
        : path.resolve(repoRoot, configPath);
  const indexAbs =
    indexPath === null
      ? null
      : path.isAbsolute(indexPath)
        ? indexPath
        : path.resolve(repoRoot, indexPath);
  const objectsAbs =
    objectsDir === null
      ? null
      : path.isAbsolute(objectsDir)
        ? objectsDir
        : path.resolve(repoRoot, objectsDir);
  const shapeFiles: { path: string; present: boolean }[] = [];
  for (const p of shapePaths) {
    const ap = p === null ? null : path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
    shapeFiles.push({ path: ap ?? "", present: ap !== null && existsSync(ap) });
  }
  const fingerprint: EvidenceFingerprint = {
    dotGit,
    indirection,
    configPath: configAbs,
    configBytes: configAbs === null ? null : safeReadBytes(configAbs),
    shapeFiles,
    objectsDir: objectsAbs,
    objectFiles: objectsAbs === null ? new Map() : enumerateObjectFiles(objectsAbs),
    indexPath: indexAbs,
    indexBytes: indexAbs === null ? null : safeReadBytes(indexAbs),
  };
  return { configPath, indexPath, objectsDir, shapePaths, anyFailed, fingerprint };
}

/**
 * Re-prove a captured preflight against the live `.git` surface — sync
 * fs checks only, so a cached preflight (OriginGit) can afford it before
 * EVERY spawn (CX-134/CX-135). Any drift — config rewrite, shape file
 * added/removed, object store change, index rewrite, `.git` or
 * indirection tampering — means the stored judgment no longer describes
 * the repo the spawn would read, and the caller must re-run the full
 * preflight. Returns false when the fingerprint is absent or the
 * preflight itself is null (an unproven surface can never be cached).
 */
export function reproveEvidenceSurface(
  repoRoot: string,
  preflight: EvidencePreflight | null | undefined,
): boolean {
  const fp = preflight?.fingerprint;
  if (preflight === null || preflight === undefined || fp === undefined) return false;
  const dotGitAbs = path.join(repoRoot, ".git");
  switch (fp.dotGit.kind) {
    case "absent": {
      if (existsSync(dotGitAbs)) return false;
      break;
    }
    case "dir": {
      try {
        const st = statSync(dotGitAbs);
        if (!st.isDirectory() || st.ino !== fp.dotGit.ino || st.ctimeMs !== fp.dotGit.ctimeMs) {
          return false;
        }
      } catch {
        return false;
      }
      break;
    }
    case "file": {
      const b = safeReadBytes(dotGitAbs);
      if (b === null || !b.equals(fp.dotGit.bytes)) return false;
      break;
    }
  }
  for (const f of fp.indirection) {
    const b = safeReadBytes(f.path);
    if (b === null ? f.bytes !== null : f.bytes === null || !b.equals(f.bytes)) return false;
  }
  if (fp.configPath !== null) {
    const b = safeReadBytes(fp.configPath);
    if (b === null ? fp.configBytes !== null : fp.configBytes === null || !b.equals(fp.configBytes))
      return false;
  }
  for (const s of fp.shapeFiles) {
    if (s.path === "" || existsSync(s.path) !== s.present) return false;
  }
  if (fp.objectsDir !== null) {
    const cur = enumerateObjectFiles(fp.objectsDir);
    if (cur.size !== fp.objectFiles.size) return false;
    for (const [rel, st] of fp.objectFiles) {
      const c = cur.get(rel);
      if (c === undefined || c.ino !== st.ino || c.ctimeMs !== st.ctimeMs || c.size !== st.size) {
        return false;
      }
    }
  }
  if (fp.indexPath !== null) {
    const b = safeReadBytes(fp.indexPath);
    if (b === null ? fp.indexBytes !== null : fp.indexBytes === null || !b.equals(fp.indexBytes))
      return false;
  }
  return true;
}

/** The runner signature both evidence channels hand the shared resolve —
 * the optional opts union keeps `execEvidenceGit`/`gitEvidence` directly
 * assignable, so callers pass existing definitions, never fresh closures. */
export type EvidenceGitRunner = (
  repoRoot: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    extraEnv?: Record<string, string>;
    input?: string | Buffer;
    preflight?: boolean;
  },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/**
 * Spawning half of the preflight for the runner channel — `verifierGit`
 * shells out itself, so it captures the two enumerations and hands them
 * to the pure judge. `null` when the repo surface cannot be enumerated
 * (non-repo cwds included — the op itself decides whether it needed one);
 * the os/flow evidence channel runs its own driver inside `gitEvidence`
 * so every subprocess stays in the argv-judged body.
 */
export async function evidenceRepoPreflight(repoRoot: string): Promise<EvidencePreflight | null> {
  // Indirection → resolves → fingerprint, fused so the ordering contract
  // (CX-134/135) cannot be misordered: `.git` gitfile/commondir bytes are
  // captured BEFORE the resolves they govern and the fingerprint freezes
  // same-or-older state BEFORE the judged reads below — the config dump
  // is the first. `--git-path objects` resolves the real object store —
  // shared for linked worktrees — so the loose-object re-hash judges the
  // same files the reads below would serve (CX-104). A failed resolve
  // feeds the judge `null`, which it counts as a violation — an unproven
  // object store must refuse, not silently skip the check.
  const { objectsDir, shapePaths, fingerprint } = await captureEvidenceSurface(
    repoRoot,
    execEvidenceGit,
  );
  const listed = await execEvidenceGit(repoRoot, [
    "config",
    "--local",
    "--no-includes",
    "--list",
    "--null",
  ]);
  if (listed.exitCode !== 0) return null;
  const preflight = judgeEvidenceRepoSurface(repoRoot, listed.stdout, shapePaths, objectsDir);
  // Pack-carried objects get the same integrity anchor loose objects
  // have: `verify-pack -s` rebuilds every object name from inflated
  // content, so a session-dropped pack+idx pair serving false bytes is
  // caught before any read trusts the store (CX-113). Skipped when the
  // objects dir could not be resolved — that failure is already a
  // shapeViolation.
  if (objectsDir !== null && objectsDir !== undefined) {
    const absObjects = path.isAbsolute(objectsDir)
      ? objectsDir
      : path.resolve(repoRoot, objectsDir);
    preflight.shapeViolations.push(...(await scanPackObjects(absObjects)));
  }
  // `.git/index` is session-writable — a forged stat tuple answers
  // status/diff clean on dirty bytes (CX-121). Rebuild the index's claims
  // into a verifier-owned zero-stat index the trusted spawns inherit as
  // an fd, so no same-uid-rewritable path ever holds it (CX-129). A
  // failed rebuild marks the index unproven (CX-124): index-consulting
  // reads refuse, non-index reads stay trustworthy.
  const prepared = await prepareEvidenceIndex(repoRoot);
  preflight.index = prepared.index;
  preflight.indexUnproven = prepared.failure;
  preflight.fingerprint = fingerprint;
  return preflight;
}

export interface VerifierGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Env allowlist for a spawned forge process on the trust boundary (the gate
 * child of flow.integrate, the adversarial runner's spawned CLI). Everything
 * not listed is dropped: `NODE_OPTIONS=--require`, `NODE_PATH`, `LD_*`,
 * `DYLD_*`, `GIT_*`, `BASH_ENV`/`ENV`/`CDPATH` — each is an attacker
 * preload/redirect channel into the child (CX-41, CX-52). PATH is the
 * rebuilt verifier path, never the session's.
 */
const SPAWN_ENV_ALLOWLIST = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROGRAMFILES",
  "ProgramFiles",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export function verifierSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: verifierPath() };
  for (const k of SPAWN_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // Caller-supplied additions are filtered — PATH would silently replace
  // the rebuilt verifier path, and the preload/redirect levers would ride
  // back into the trusted child unfiltered (CX-84).
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (k === "PATH" || ORACLE_DROP_RE.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Env for the ORACLE child (`checkRun` and friends): the operator-configured
 * command resolves its argv0 through the session PATH by design (CX-20 —
 * consumer toolchains like `pnpm`/`nvm node` live there), so PATH survives
 * — but the preload/redirect levers a session controls must not ride into
 * the oracle process: every `GIT_*`, `NODE_OPTIONS`/`NODE_PATH`, `LD_*`/
 * `DYLD_*`, `BASH_ENV`/`ENV`/`CDPATH`, `IFS`. The oracle still runs on the
 * trust boundary — its exit verdict must not be preloaded.
 */
const ORACLE_DROP_RE =
  /^(?:GIT_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|CDPATH$|IFS$|LD_|DYLD_|PYTHONPATH$|PYTHONSTARTUP$|RUBYLIB$|PERL5LIB$|PERL5OPT$|GCONV_PATH$|LOCALDOMAIN$)/;

export function verifierSubprocessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ORACLE_DROP_RE.test(k)) continue;
    env[k] = v;
  }
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  // Caller additions keep session PATH by design (the oracle resolves its
  // argv0 there) but may not smuggle a preload/redirect lever back (CX-84).
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (ORACLE_DROP_RE.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Spawn a trusted forge-side binary (the gate child, the runner's CLI) with
 * a fully replaced, allowlisted env — not the io.exec merge, which can never
 * delete a hostile inherited variable. resolveSpawnPlan keeps the
 * PATHEXT/.cmd resolution io.exec gives on Windows; a spawn failure reports
 * exitCode -1.
 */
export async function verifierSpawn(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; extraEnv?: Record<string, string> },
): Promise<VerifierGitResult> {
  return new Promise((resolve) => {
    try {
      const plan = resolveSpawnPlan(bin, args);
      const child = spawn(plan.command, plan.args, {
        cwd: opts.cwd,
        env: verifierSpawnEnv(opts.extraEnv),
        windowsVerbatimArguments: plan.verbatim,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: String(e) });
    }
  });
}

/**
 * `spawn`-based execFile replacement — Node's `execFile` silently drops
 * `stdio[3+]`, so an inherited index fd (CX-129's `/dev/fd/3` transport)
 * requires `spawn` outright. Mirrors the channels' contract: timeout and
 * maxBuffer kill to exitCode -1, stdout/stderr captured as Buffers,
 * optional `input` written to stdin and closed.
 */
export function spawnCaptured(
  bin: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
    indexFd?: number;
    input?: string | Buffer;
  },
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args as string[], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.indexFd !== undefined ? ["pipe", "pipe", "pipe", opts.indexFd] : "pipe",
      });
    } catch (e) {
      resolve({ exitCode: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e)) });
      return;
    } finally {
      // The child inherited its own dup of the index fd at fork — the
      // parent's per-spawn copy is dead weight after spawn() returns
      // (and on a spawn error it never reached a child at all).
      if (opts.indexFd !== undefined) {
        try {
          closeSync(opts.indexFd);
        } catch {
          /* already closed */
        }
      }
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      total += d.length;
      if (total > opts.maxBuffer) {
        child.kill("SIGKILL");
        finish(-1);
        return;
      }
      out.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
    child.stdin?.on("error", () => {
      /* EPIPE — a finished read must not crash the parent */
    });
    child.stdin?.end(opts.input ?? "");
  });
}

/**
 * Shared spawn for the trusted-git channels: surface preflight → argv
 * judgment → pinned spawn. `judge` picks the table — the read table
 * for `verifierGit`, the bounded mutation set for `verifierScratchGit`.
 * `useIndexEnv` applies the preflight's claims-rebuilt verifier index —
 * read-table ops only; the scratch channel's mutations (add/commit)
 * need the clone's real index (CX-121's env is a read-judgment surface,
 * never a write path).
 */
async function verifierGitSpawn(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; extraEnv?: Record<string, string> } | undefined,
  judge: (args: readonly string[]) => boolean,
  table: string,
  useIndexEnv: boolean,
): Promise<VerifierGitResult> {
  // The session-writable repo surface is judged before the spawn — a
  // transport/exec lever, a topology file, or a loose object whose bytes
  // do not hash to its name makes any answer fabricable, so the call
  // refuses rather than trusting it (CX-72..79, CX-104). A non-repo cwd
  // (clone/init destinations) has no config to enumerate — the op itself
  // decides whether the path must be a repo.
  let preflight = await evidenceRepoPreflight(cwd);
  // Re-prove the fingerprint right before the spawn — a session write
  // racing the judgment→spawn window reads as drift and re-runs the
  // whole preflight once, shrinking the stale-judgment surface to the
  // reprove itself (CX-134's cached-channel sibling on the per-call path).
  if (preflight !== null && !reproveEvidenceSurface(cwd, preflight)) {
    closeEvidenceIndex(preflight);
    preflight = await evidenceRepoPreflight(cwd);
  }
  try {
    if (
      preflight !== null &&
      (preflight.refusedKeys.length > 0 || preflight.shapeViolations.length > 0)
    ) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: ${[...preflight.refusedKeys, ...preflight.shapeViolations].join(", ")}`,
      };
    }
    // argv judgment BEFORE the spawn: the r7 channel scanned only for
    // `@{…}`/reflog-shaped args — `reflog`/`stash`/`update-ref`/`config`
    // writes and every leading global option rode through unjudged, and a
    // caller `-c`/`--git-dir` lands AFTER the pins where the last write
    // wins (CX-108/109). Denylist is unprovable; the allowlist table is
    // the contract.
    if (!judge(args)) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: argv outside the ${table}: git ${args.join(" ")}`,
      };
    }
    // The verifier index is resolved per spawn — the fd form carries no
    // path at all (CX-129); the path form re-proves its on-disk bytes
    // before the redirect is trusted. An unproven index (rebuild failed,
    // CX-124, or a rewrite caught just now) refuses index-consulting ops;
    // non-index ops never consult it and proceed — a corrupt-index
    // fixture degrades per-read, not channel-wide.
    const idx = useIndexEnv ? evidenceIndexForSpawn(preflight) : { env: {}, unproven: false };
    if (idx.unproven && isIndexConsultingRead(args)) {
      closeSpawnIndexFd(idx);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: index unproven (${preflight?.indexUnproven ?? "index bytes rewritten"}): git ${args.join(" ")}`,
      };
    }
    const r = await spawnCaptured(resolveGitBin(), args, {
      cwd,
      env: {
        ...verifierGitEnv(),
        // Pins ride the env, not argv — the spawned argv is the judged
        // query verbatim so positional argv contracts (subcommand at
        // $1) hold for failure-injection seams.
        ...evidencePinEnv(args, preflight),
        // The verifier-owned claims index — the session's `.git/index`
        // is never consulted for a trusted verdict (CX-121/CX-129).
        ...idx.env,
        ...filterEvidenceExtraEnv(opts?.extraEnv),
      },
      timeoutMs: opts?.timeoutMs ?? 60_000,
      maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024,
      indexFd: idx.indexFd,
    });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } finally {
    // The per-call preflight owns its index fd — a cached preflight
    // (OriginGit) keeps it for the instance's lifetime instead.
    closeEvidenceIndex(preflight);
  }
}

/**
 * `execFile(<resolved git>, args, {cwd, env: verifierGitEnv()})` returning
 * the same `{exitCode, stdout, stderr}` shape io.exec produces, so boundary
 * call sites swap without contract churn. The executable is the resolved
 * absolute path (CX-52) and `extraEnv` adds caller-owned variables to the
 * scrubbed env — never session-inherited ones. A spawn failure reports
 * exitCode -1 — callers treat non-zero as a failed read, never as an empty
 * answer. argv is judged against `isVerifierGitQuery` — the evidence read
 * table minus `fetch` — so only provable read ops reach the trusted spawn
 * (CX-108/109).
 */
export async function verifierGit(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number; extraEnv?: Record<string, string> },
): Promise<VerifierGitResult> {
  return verifierGitSpawn(cwd, args, opts, isVerifierGitQuery, "verifier read table", true);
}

/**
 * `verifierGit` for the adversarial runner's OWN scratch clone — same
 * env/preflight/pins, but argv is judged by `isScratchGitQuery`: the
 * bounded mutation ops (clone/config/add/commit/…) the replay needs on a
 * repo it owns, everything else through the read table. A scenario-
 * authored token can never reach `reflog`/`stash`/`update-ref`, a
 * `config --file` foreign store, or a global-option redirect
 * (CX-108/109).
 */
export async function verifierScratchGit(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number; extraEnv?: Record<string, string> },
): Promise<VerifierGitResult> {
  return verifierGitSpawn(cwd, args, opts, isScratchGitQuery, "scratch table", false);
}
