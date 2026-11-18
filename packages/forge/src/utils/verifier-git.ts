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
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r6 trust-boundary counterexamples</item>
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
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
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

let evidenceHooksDirPath: string | undefined;
/**
 * The `core.hooksPath` pin target — a fresh, uniquely-named empty dir under
 * the OS temp root so a repo-config `core.hooksPath` resolves to nothing
 * hookable. `-c` DOES reach the hook resolver (callback-scope config),
 * unlike the transport levers, so pinning works where detection alone
 * would not (CX-74). `mkdtempSync` — never a predictable pid-suffixed
 * name a session could pre-plant hooks into (CX-87). Created lazily on
 * first evidence spawn.
 */
function evidenceHooksDir(): string {
  if (evidenceHooksDirPath === undefined) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-evidence-hooks-"));
    evidenceHooksDirPath = dir;
  }
  return evidenceHooksDirPath;
}

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
  // reads (fetch → reference-transaction, CX-74) still get the dead dir.
  const onConfigRead = args?.[0] === "config";
  return [
    ...EVIDENCE_CONFIG_PINS.flatMap((kv) => ["-c", kv]),
    ...(onConfigRead ? [] : ["-c", `core.hooksPath=${evidenceHooksDir()}`]),
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
   * every lookup), `shallow` (fabricated history truncation). Presence
   * refuses the channel; `info/attributes` is exempt — driver commands
   * are neutralized by the diff/filter pins, so the file can no longer
   * reach a program.
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
   * Channel-owned `GIT_INDEX_FILE` pointing at a verifier-built rebuild
   * of the session index's claims — `.git/index` is session-writable and
   * a forged stat tuple answers `status --porcelain` clean on dirty bytes
   * (CX-121), while a HEAD-anchored index cannot express staged or
   * unborn-HEAD state. The rebuilt entries carry zero stat, so every
   * index-consulting read (status/diff/ls-files/grep --cached)
   * content-hashes the worktree instead of trusting the session's tuples.
   * Undefined when the session index cannot be enumerated.
   */
  indexEnv?: Record<string, string>;
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
];

/** The stderr prefix a refused evidence call carries — callers treat it as unverifiable, never as an empty answer. */
export const EVIDENCE_REFUSED_PREFIX = "EVIDENCE-REFUSED";

/** `.git` metadata paths whose presence refuses evidence — resolved via `--git-path` so linked worktrees land on the right common/worktree dir. */
const EVIDENCE_SHAPE_PATHS = ["info/grafts", "objects/info/alternates", "shallow"] as const;

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

/** Flags the pinned fetch form may carry — every other flag is a transport or ref lever. */
const EVIDENCE_FETCH_FLAGS = new Set([
  "--prune",
  "-p",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
  "--progress",
  "--no-tags",
  "--atomic",
]);

/**
 * The one refspec shape evidence fetches may carry: heads into
 * `refs/remotes/origin/*` — never a local integration branch (CX-81: an
 * admitted `+refs/heads/develop:refs/heads/main` force-rewrote `main`
 * on the read-only-plus-pinned-fetch channel).
 */
const EVIDENCE_FETCH_REFSPEC = /^\+?refs\/heads\/[\w.*\/-]+:refs\/remotes\/origin\/[\w.*\/-]+$/;

/**
 * The pinned fetch form: flags from the allowlist, exactly one remote
 * (name or URL) as the first positional, and only heads→origin-tracking
 * refspecs after it. `--upload-pack`, `--depth`, `--refmap`,
 * `--recurse-submodules`, `--stdin`, `-o`, `--filter`, `--update-head-ok`,
 * `--tags` and friends stay out — each reaches a transport lever or
 * writes refs outside the tracking namespace. The remote positional is
 * free-form (a dot-named remote or a path is legal) — the guardrail is
 * the preflight's `remote.<name>.*` judgment, which refuses every
 * configured lever and non-default refspec that would union in (CX-110).
 */
function isEvidenceFetchTail(tail: readonly string[]): boolean {
  let remoteSeen = false;
  for (const a of tail) {
    if (a.startsWith("-")) {
      if (!EVIDENCE_FETCH_FLAGS.has(a)) return false;
      continue;
    }
    if (!remoteSeen) {
      remoteSeen = true;
      continue;
    }
    if (!EVIDENCE_FETCH_REFSPEC.test(a)) return false;
  }
  return remoteSeen;
}

/**
 * The argv space `gitEvidence` may spawn — a mirror of the shared
 * READ_ONLY_GIT_QUERIES table plus `fetch`, the one mutating op the
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
  { prefix: ["ls-remote"], forbid: ["--upload-pack", "--exec", "-u", "--stdin"] },
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
  // The one mutating op — fetch — is held to the single pinned refspec
  // shape rather than the prefix/forbid form (CX-81: an arbitrary admitted
  // refspec force-rewrote a local integration branch).
  if (args[0] === "fetch") return isEvidenceFetchTail(args.slice(1));
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
  if (args.length === 0 || args[0] === "fetch") return false;
  return isEvidenceGitQuery(args);
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

let evidenceIndexDirPath: string | undefined;
let evidenceIndexSeq = 0;
function evidenceIndexDir(): string {
  if (evidenceIndexDirPath === undefined) {
    evidenceIndexDirPath = mkdtempSync(path.join(os.tmpdir(), "forge-evidence-idx-"));
  }
  return evidenceIndexDirPath;
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
 * writes into a shared index. Returns `{}` when the session index cannot
 * be enumerated — the ambient index then surfaces git's own error.
 */
export async function prepareEvidenceIndex(repoRoot: string): Promise<Record<string, string>> {
  const indexFile = path.join(evidenceIndexDir(), `index-${++evidenceIndexSeq}`);
  const env = { GIT_INDEX_FILE: indexFile };
  // Both spawns carry the static pins via env: `ls-files` consults
  // `core.fsmonitor` even for a pure --stage dump, and `update-index`
  // can refresh the fsmonitor token — a session program must not exec
  // inside the claims enumeration or the rebuild (CX-115 class).
  const claims = await execEvidenceGit(repoRoot, ["ls-files", "--stage", "-z"], {
    extraEnv: evidencePinEnv(["ls-files"]),
  });
  if (claims.exitCode !== 0) return {};
  // `-z` claims feed `--index-info` verbatim.
  const rebuilt = await execEvidenceGit(repoRoot, ["update-index", "-z", "--index-info"], {
    extraEnv: { ...env, ...evidencePinEnv(["update-index"]) },
    input: claims.stdout,
  });
  if (rebuilt.exitCode !== 0) return {};
  // An empty claim set leaves no file — GIT_INDEX_FILE aimed at a
  // nonexistent path is git's own empty-index answer, matching ambient.
  return env;
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
      hookArgs.push("-c", `core.hooksPath=${evidenceHooksDir()}`);
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

/**
 * Spawning half of the preflight for the runner channel — `verifierGit`
 * shells out itself, so it captures the two enumerations and hands them
 * to the pure judge. `null` when the repo surface cannot be enumerated
 * (non-repo cwds included — the op itself decides whether it needed one);
 * the os/flow evidence channel runs its own driver inside `gitEvidence`
 * so every subprocess stays in the argv-judged body.
 */
export async function evidenceRepoPreflight(repoRoot: string): Promise<EvidencePreflight | null> {
  const listed = await execEvidenceGit(repoRoot, [
    "config",
    "--local",
    "--no-includes",
    "--list",
    "--null",
  ]);
  if (listed.exitCode !== 0) return null;
  const shapePaths = await Promise.all(
    EVIDENCE_SHAPE_QUERY_PATHS.map(async (p) => {
      const r = await execEvidenceGit(repoRoot, ["rev-parse", "--git-path", p]);
      if (r.exitCode !== 0) return null;
      // strip exactly the terminating newline — a newline inside the path
      // itself is real and must reach the resolver (CX-89)
      return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    }),
  );
  // `--git-path objects` resolves the real object store — shared for
  // linked worktrees — so the loose-object re-hash judges the same files
  // the reads below would serve (CX-104). A failed resolve feeds the
  // judge `null`, which it counts as a violation — an unproven object
  // store must refuse, not silently skip the check.
  const objects = await execEvidenceGit(repoRoot, ["rev-parse", "--git-path", "objects"]);
  const objectsDir =
    objects.exitCode === 0
      ? objects.stdout.endsWith("\n")
        ? objects.stdout.slice(0, -1)
        : objects.stdout
      : null;
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
  // into a verifier-owned zero-stat file every index-consulting spawn
  // redirects to.
  preflight.indexEnv = await prepareEvidenceIndex(repoRoot);
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
 * Shared spawn for the trusted-git channels: surface preflight → argv
 * judgment → pinned execFile. `judge` picks the table — the read table
 * for `verifierGit`, the bounded mutation set for `verifierScratchGit`.
 * `useIndexEnv` applies the preflight's claims-rebuilt throwaway index —
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
  const preflight = await evidenceRepoPreflight(cwd);
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
  return new Promise((resolve) => {
    try {
      execFile(
        resolveGitBin(),
        args,
        {
          cwd,
          env: {
            ...verifierGitEnv(),
            // Pins ride the env, not argv — the spawned argv is the judged
            // query verbatim so positional argv contracts (subcommand at
            // $1) hold for failure-injection seams.
            ...evidencePinEnv(args, preflight),
            // The preflight's claims-rebuilt throwaway index — the
            // session's `.git/index` is never consulted for a trusted
            // verdict (CX-121).
            ...(useIndexEnv ? (preflight?.indexEnv ?? {}) : {}),
            ...filterEvidenceExtraEnv(opts?.extraEnv),
          },
          timeout: opts?.timeoutMs ?? 60_000,
          maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: String(e) });
    }
  });
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
