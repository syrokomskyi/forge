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
  <item>RFC-1616: close RFC-1616 r15 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r16 trust-boundary counterexamples</item>
  <item>RFC-1616: close r19 counterexamples CX-166 through CX-171</item>
  <item>RFC-1616: close r20 counterexamples CX-173 through CX-177</item>
  <item>RFC-1616: close r21 counterexample CX-179 + push-scan refusal polarity</item>
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
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

/** The null-device path both env pins and dead-dir targets share — platform-aware. */
export const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * `GIT_ATTR_SOURCE` pinned at the well-known EMPTY TREE — every
 * attribute-driven lever (`filter.<n>.clean`/`smudge`/`process`,
 * `diff.<n>.command`/`textconv`, `text.<n>` working-tree encodings,
 * `merge.<n>.driver`) needs an attribute to engage, and under an empty
 * attr tree no `.gitattributes`, `info/attributes`, or
 * `core.attributesFile` content ever loads (verified: a `filter=xf`
 * attribute execs the configured clean program without the pin and
 * never reaches it with the pin — `info/attributes` dies the same way).
 * The oid differs per object format; git synthesizes the empty tree in
 * every repo so no object need exist on disk. The wrong-format oid fails
 * to resolve → the read errors → fail closed, never a weakened pin.
 */
const EVIDENCE_EMPTY_TREE: Readonly<Record<string, string>> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

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
 * pass-through. `extensions.worktreeConfig=false`
 * keeps `.git/config.worktree` keys from loading; `maintenance.auto` /
 * `gc.auto` stop a pinned fetch from spawning background helpers;
 * `fetch.recurseSubmodules`/`submodule.recurse` keep the read inside the
 * one repo; the `protocol.*.allow` pins forbid exec-capable transports.
 * Transport levers (`core.gitProxy`, `remote.*.proxy`, `http.*`, `ssh.*`)
 * are deliberately NOT here — `-c` never reaches the children that read
 * them, so evidenceRepoPreflight refuses on their presence instead
 * (CX-72/CX-76).
 *
 * R13-D / CX-141 — the pinned set is UNCONDITIONAL, not dump-derived:
 * `GIT_CONFIG_LOCAL` does not exist (empirically a no-op), so a trusted
 * spawn always reads the LIVE `.git/config`. A config rewrite between the
 * judged dump and the spawn can then arm a lever the dump never saw
 * (include.path→diff.external landed forged output in ~10% of calls
 * under a 5ms flipper). Env-scope config wins over the file for the SAME
 * key name, so pinning every literal lever key unconditionally makes the
 * live bytes inert — the judgment is the keyspace, not the file bytes.
 * Pattern levers that cannot be named die by attr starvation
 * (`GIT_ATTR_SOURCE=<empty tree>` in evidenceSpawnState — worktree
 * `.gitattributes`, `info/attributes`, and `core.attributesFile` all
 * resolve to nothing under it) or by dead transports. The residual
 * config-as-data drift (`remote.origin.url`, `user.*`, `branch.<n>.*`
 * upstream claims) stays honest — config reads report live state, and
 * the fingerprint reprove refuses on byte drift anyway. The REFUSE-on-
 * seen rules stay as defense in depth.
 */
const EVIDENCE_CONFIG_PINS = [
  "core.commentChar=#",
  "trailer.separators=:",
  "log.showSignature=false",
  "i18n.logOutputEncoding=UTF-8",
  // `i18n.commitEncoding` recodes commit bodies from the declared charset
  // — a post-capture flip (e.g. koi8) garbles `%B` bytes so the trailer
  // scan goes blind while the parse stays valid. Pin the honest default.
  "i18n.commitEncoding=UTF-8",
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
  // real object graph (CX-113's pack-store sibling). `.pack-*.rev` reverse
  // indexes are the same class of on-disk lookup table: read
  // opportunistically, so a planted/rewritten file remaps offsets —
  // pinned off, git rebuilds the mapping in memory.
  "pack.useBitmapIndex=false",
  "pack.readReverseIndex=false",
  // Exec levers neutralized to nothing: an empty string value is "unset"
  // for these keys — `core.worktree=` falls back to the cwd-derived
  // worktree, `core.gitProxy=` to no proxy. `false` disables
  // editor/pager spawning outright (an editor would exec whatever the
  // live config names). `diff.external` has no safe pin — git execs the
  // value INCLUDING an empty one — so presence is refused via
  // EVIDENCE_CONFIG_REFUSE and post-dump injection is caught by the
  // config-bytes fingerprint reprove.
  "core.worktree=",
  "core.editor=false",
  "sequence.editor=false",
  "merge.editor=false",
  "core.pager=false",
  "core.askpass=",
  "core.sshCommand=",
  "core.sshVariant=ssh",
  "ssh.variant=ssh",
  "core.gitProxy=",
  "core.alternateRefsCommand=",
  "core.alternateRefsPrefixes=",
  // File-path levers a read consults — repointed at the null device so a
  // session file is never opened (mailmap/orderfile reshape output, the
  // ssh signers file would let a forged signature read as valid under
  // `log --show-signature`, trace targets write into session paths).
  "gpg.program=",
  "gpg.openpgp.program=",
  "gpg.x509.program=",
  "gpg.ssh.program=",
  `gpg.ssh.defaultKeyCommand=${DEVNULL}`,
  `gpg.ssh.allowedSignersFile=${DEVNULL}`,
  `gpg.ssh.revocationFile=${DEVNULL}`,
  // `mailmap.file`/`mailmap.blob` reshape `%aN`/`%cN`/`%(authorname:mailmap)`
  // atoms into session-chosen identities; `diff.orderFile` reorders diff
  // output; trace targets write verifier output into session-named paths
  // (a `trace2.normalTarget=.git/config` would corrupt the judged file).
  `mailmap.file=${DEVNULL}`,
  "mailmap.blob=",
  `diff.orderFile=${DEVNULL}`,
  `trace2.normalTarget=${DEVNULL}`,
  `trace2.eventTarget=${DEVNULL}`,
  `trace2.perfTarget=${DEVNULL}`,
  "trace2.envVars=",
  "notes.displayRef=",
  "core.notesRef=",
  "column.ui=never",
  // Semantics levers that reshape a trusted answer — worktree/index
  // interpretation (sparse hides paths, untracked-cache answers from a
  // session file, ignorecase makes case-renames invisible, autocrlf
  // renormalizes content comparisons), display shaping (untracked mode,
  // rename detection, follow/log decorations, abbrev length), and
  // describe's tag-matching surface.
  "core.sparseCheckout=false",
  "core.untrackedCache=false",
  "core.ignoreCase=false",
  "core.autoCRLF=false",
  "core.checkStat=default",
  "core.trustcTime=false",
  "status.showUntrackedFiles=normal",
  "status.showTrackedFiles=true",
  "status.aheadBehind=true",
  "status.renames=true",
  "diff.ignoreSubmodules=none",
  "diff.renames=true",
  "diff.submodule=short",
  "grep.patternType=default",
  "grep.extendedRegexp=false",
  "log.follow=false",
  "log.showRoot=true",
  "log.decorate=",
  "log.useMailmap=false",
  "core.abbrev=auto",
  "core.bare=",
  "describe.tags=",
  "describe.all=",
  "describe.always=",
  "describe.candidates=10",
  "describe.match=*",
  "describe.exclude=",
  "push.default=current",
  "remote.pushDefault=",
  "feature.experimental=false",
  "feature.manyFiles=false",
  // `core.symlinks` stays unpinned: arming it only ever makes status
  // NOISIER (a misread link mode reports dirt), never cleaner — not a
  // forgery lever.
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
 * preflight's dynamic pins. `config` reads carry NO pins at all (CX-148):
 * every pin is command-scope config that shadows the file value, so a
 * `config --get <pinned-key>` answers the pin — verifier-curated output
 * where the contract demands file truth (and provably disagrees with
 * `--local --no-includes --list` on the same channel). Config reads
 * invoke no levers — no drivers, attrs, index, or pager on a non-tty —
 * and the scope pins (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` → null
 * device in `verifierGitEnv`) still bound the answer to the local file,
 * so holding every `-c` pair back loses no protection.
 */
export function evidencePinArgs(
  args: readonly string[],
  preflight?: EvidencePreflight | null,
): string[] {
  if (args[0] === "config") return [];
  return [
    ...evidenceConfigArgs(args),
    ...(preflight?.configArgs ?? []),
    ...(preflight?.hookArgs ?? []),
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
   * evidence once the reader pins hold — the commit-graph/MIDX caches
   * are regenerable indexes ignored under
   * `core.commitGraph=false`/`core.multiPackIndex=false`, so a forged
   * cache cannot remap parentage or oid→pack bytes. Reported for
   * digest diagnostics rather than refused.
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
   * Set when a `.git/config` file exists but its bytes could not be
   * captured into the fingerprint — an unreadable config cannot be
   * drift-checked, so the channel refuses every spawn outright (fail
   * closed, not unjudged).
   */
  configUnproven?: string;
  /**
   * The repo's `extensions.objectformat` (`sha256` when declared) —
   * selects the empty-tree oid `GIT_ATTR_SOURCE` pins so attribute-
   * driven config levers starve on every hash flavor (R13-D).
   */
  objectFormat?: string;
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
  /**
   * The resolution anchors `rev-parse` answered at capture time —
   * `gitDir` is the directory HEAD/objects live under (a linked
   * worktree's admin metadir, `<root>/.git` for a primary checkout,
   * resolved through ANY parent for a subdirectory cwd, CX-143);
   * `workTree` is `--show-toplevel` (null for bare/unresolved). Every
   * judged spawn and every internal preflight subprocess pins these
   * through `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` env, so `.git`
   * indirection files (gitfile, `commondir`) reach NOTHING in a child
   * — a post-capture plant or rewrite can only register as fingerprint
   * drift, never redirect a read.
   */
  gitDir: string | null;
  /** `gitDir`'s inode+ctime — a same-path dir swap always reads as drift. */
  gitDirStat: { ino: number; ctimeMs: number } | null;
  /**
   * The shared git dir — derived STRUCTURALLY from `gitDir`'s path
   * shape (`<common>/worktrees/<id>` → `<common>`, else `gitDir`
   * itself), NEVER from `commondir` file content: honoring the file
   * would resolve a same-uid session's forged common dir. Children
   * pin `GIT_COMMON_DIR` only when it differs from `GIT_DIR` (CX-162)
   * — in a primary `.git` a `commondir` file is instead refused on
   * presence, so the file is drift-or-refusal either way, never a
   * redirect (CX-143).
   */
  commonDir: string | null;
  /** `--show-toplevel` at capture — null for bare or unresolved repos. */
  workTree: string | null;
  /** Indirection files a redirect rewrite touches first — gitfile target, commondir. */
  indirection: readonly { path: string; bytes: Buffer | null }[];
  /** The `.git/config` file the judged dump derived from — resolved path + bytes. */
  configPath: string | null;
  configBytes: Buffer | null;
  /**
   * Every `--git-path`-resolved shape path + its CONTENT bytes at
   * judgment time — presence alone is not provable: a zero-byte
   * `info/grafts`/`shallow`/`info/attributes` rides "present" unchanged
   * while a session arms it post-capture, so the fingerprint pins the
   * bytes and the reprove compares content (R13-A). `bytes` is null
   * when the file is absent or unreadable at capture.
   */
  shapeFiles: readonly { path: string; present: boolean; bytes: Buffer | null }[];
  /** Resolved object store + every file inside it, keyed by relative path. */
  objectsDir: string | null;
  objectFiles: ReadonlyMap<string, EvidenceSurfaceFile>;
  /**
   * `<common>/worktrees/` — the linked-worktree registry git serves
   * verbatim in `worktree list`. The whole subtree is pinned so a
   * post-capture planted admin dir (phantom worktree, R13-B) always
   * reads as drift; well-formedness of each entry is the judge's job.
   */
  worktreesDir: string | null;
  worktreeFiles: ReadonlyMap<string, EvidenceSurfaceFile>;
  /**
   * The `--git-path modules`-resolved submodule-gitdir tree — the judge
   * refuses a POPULATED modules/ once, but presence+bytes alone cannot
   * fingerprint a directory (CX-179): an empty-at-capture `modules/`
   * populated inside the judgment→spawn window would consult unjudged
   * submodule config/index surface in the very `status`/`diff` spawn
   * that follows. The whole subtree is pinned like `objects/` and
   * `worktrees/` so any population reads as drift → re-preflight →
   * the populated-dir refusal.
   */
  modulesDir: string | null;
  modulesFiles: ReadonlyMap<string, EvidenceSurfaceFile>;
  /** The ambient `.git/index` the claims rebuild enumerated — resolved path + bytes. */
  indexPath: string | null;
  indexBytes: Buffer | null;
  /**
   * How the resolved `gitDir` was reached (CX-171): `"worktree"` — a
   * `.git` node (dir or gitfile) at some ancestor resolved it;
   * `"selfdir"` — git self-discovered the gitdir with no worktree node,
   * so bareness is a topological fact, not the `core.bare` config claim;
   * `"unknown"` — `gitDir` is null or the walk could not re-derive the
   * resolution (the judge refuses that pairing).
   */
  topology: RepoTopology;
}

/**
 * How the resolved gitdir was discovered — see `classifyTopology`.
 */
export type RepoTopology = "worktree" | "selfdir" | "unknown";

/**
 * Re-walk the ancestor chain git's own setup walks, from `repoRoot`
 * upward (CX-171): at each level a `.git` NODE (dir or file — a gitfile
 * counts; git follows either) means worktree discovery resolved the
 * repository — non-bare, and that level IS the worktree toplevel
 * (`--show-toplevel` cannot be asked under a pinned `GIT_DIR`: with no
 * worktree selector git treats the CWD itself as the implicit worktree
 * and answers the subdir — the same trap `GIT_WORK_TREE=<gitdir>` was
 * on bare, CX-162/CX-167). Reaching the resolved `gitDir` itself first
 * means git self-discovered it as a bare-shaped gitdir — no worktree
 * node exists anywhere, so `core.bare` claims in its config are the
 * only thing telling git otherwise; topology reports bare instead. The
 * OLD name-shape check (`basename == ".git"`, parent `worktrees/`)
 * misclassified both directions: a bare repo named `.git` read as a
 * worktree metadir, and a bare repo under a `worktrees/`-named parent
 * read as a linked worktree. Comparison is realpath-normalized so a
 * symlinked `repoRoot` component cannot skip the gitdir level.
 */
function classifyTopology(
  repoRoot: string,
  gitDir: string,
): { topology: RepoTopology; workTree: string | null } {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const gitDirReal = real(gitDir);
  // A cwd strictly INSIDE the resolved gitdir — a proper descendant,
  // never the gitdir level itself — is unprovable: the same walk-up
  // finds no worktree node whether the gitdir is self-contained (bare)
  // or a NON-bare repo's own metadir (`.git/objects` under a worktree's
  // `.git`), so bareness would rest on the session-writable `core.bare`
  // claim alone (CX-177). Answer unknown → the judge refuses.
  const rootReal = real(path.resolve(repoRoot));
  if (rootReal !== gitDirReal && rootReal.startsWith(gitDirReal + path.sep)) {
    return { topology: "unknown", workTree: null };
  }
  for (let level = path.resolve(repoRoot); ;) {
    try {
      const st = lstatSync(path.join(level, ".git"));
      if (st.isDirectory() || st.isFile() || st.isSymbolicLink()) {
        return { topology: "worktree", workTree: level };
      }
    } catch {
      /* no `.git` node at this level */
    }
    if (level === gitDir || real(level) === gitDirReal) {
      return { topology: "selfdir", workTree: null };
    }
    const parent = path.dirname(level);
    if (parent === level) return { topology: "unknown", workTree: null };
    level = parent;
  }
}

/**
 * One pinned file inside a fingerprinted subtree — the stat triple is
 * unforgeable (ctime is kernel-managed, CX-114); `link` records a
 * symlink's target string so a retarget — which never changes the
 * link's own stat — still reads as drift (R13 secondary: symlink
 * dirents under the object store were invisible to the sweep).
 */
export interface EvidenceSurfaceFile {
  ino: number;
  ctimeMs: number;
  size: number;
  link?: string;
  /**
   * The symlink resolves to a DIRECTORY — the walk records the link as
   * one leaf and never descends, so members beneath it are fingerprint-
   * invisible while git (and the loose/pack scans) DO descend through
   * it (CX-145). Git never creates symlinked dirs inside `objects/` or
   * `worktrees/`, so the judge refuses the channel on this marker —
   * refusal is the only answer an unpinnable member set can get.
   */
  linkDir?: true;
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
export function evidenceSpawnState(
  preflight: EvidencePreflight | null | undefined,
  withIndex = true,
): {
  env: Record<string, string>;
  indexFd?: number;
  unproven: boolean;
} {
  const env: Record<string, string> = {};
  // `GIT_ATTR_SOURCE=<empty tree>` starves every attribute-gated lever —
  // `filter.<n>.*`, `diff.<n>.command`/`textconv`, `text.<n>` encodings,
  // `merge.<n>.driver` are pattern keys no env pin can name, but none of
  // them engage without an attribute, and under the empty tree no
  // `.gitattributes`/`info/attributes`/`core.attributesFile` ever loads
  // (R13-D). Pinned at EVERY spawn — `log -p`/`show`/`diff` consult diff
  // drivers without touching the index — but not in verifierGitEnv: the
  // preflight's own probe spawns (`--git-path`, config dump,
  // `ls-files --stage`, `verify-pack`) never consult attrs, and the
  // scratch channel's mutations keep ambient attr semantics.
  env["GIT_ATTR_SOURCE"] =
    EVIDENCE_EMPTY_TREE[preflight?.objectFormat ?? "sha1"] ?? EVIDENCE_EMPTY_TREE["sha1"]!;
  // Resolution anchors (CX-143): `GIT_DIR`/`GIT_COMMON_DIR`/
  // `GIT_WORK_TREE` pin the judged repo inside the child — a post-
  // capture `.git` indirection rewrite (gitfile, commondir, or a
  // planted `<subdir>/.git` on a subdirectory cwd) can only read as
  // fingerprint drift; no child ever consults it again.
  Object.assign(env, resolutionEnv(preflight?.fingerprint));
  let indexFd: number | undefined;
  let unproven = preflight?.indexUnproven !== undefined;
  const idx = withIndex ? preflight?.index : undefined;
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
        unproven = true;
      } else {
        env["GIT_INDEX_FILE"] = "/dev/fd/3";
        indexFd = childFd;
      }
    } catch {
      unproven = true;
    }
  } else if (idx?.path !== undefined) {
    if (heldPathProven(idx)) env["GIT_INDEX_FILE"] = idx.path;
    else unproven = true;
  }
  return { env, indexFd, unproven };
}

/**
 * Close the per-spawn fd `evidenceSpawnState` minted — required on
 * every path that returns BEFORE `spawnCaptured` (which closes it
 * itself once the child inherited its dup).
 */
export function closeSpawnFds(fds: { indexFd?: number }): void {
  if (fds.indexFd !== undefined) {
    try {
      closeSync(fds.indexFd);
    } catch {
      /* already closed */
    }
  }
}

/** Release a preflight's held resources — per-call channels close them; cached preflights keep them. */
export function closeEvidenceIndex(preflight: EvidencePreflight | null | undefined): void {
  closeSpawnFds({ indexFd: preflight?.index?.fd });
  // Path-mode held files are addressable scratch — a discarded preflight
  // must not litter them under the temp root.
  for (const p of [preflight?.index?.path]) {
    if (p !== undefined) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone or unlinked */
      }
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

/**
 * Keys the static pins already hold — the dynamic layer adds nothing.
 * Derived from `EVIDENCE_CONFIG_PINS` itself so a new unconditional pin
 * can never be double-armed: a dump-present key otherwise falls through
 * to the default `key=` emit, which lands AFTER the static pin and
 * overrides the honest value with empty (R13-D). The extras are keys
 * pinned outside `EVIDENCE_CONFIG_PINS` (`core.hooksPath` is conditional
 * on the subcommand; `protocol.file.allow` rides the transport block).
 */
const EVIDENCE_CONFIG_STATIC = new Set([
  ...EVIDENCE_CONFIG_PINS.map((kv) => kv.split("=")[0]!.toLowerCase()),
  "core.attributesfile",
  "core.excludesfile",
  "core.hookspath",
  "protocol.file.allow",
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
  // `status`/`ls-files`/`grep` evidence reads DO consult exclude rules —
  // a session-planted pattern hides an untracked file and the trusted
  // verdict reads clean on a dirty tree (R13-D). Unlike
  // `core.excludesFile` (pinnable to DEVNULL) this path has no config
  // kill switch, so presence refuses rather than warns.
  "info/exclude",
  // `status`/`diff` descend into populated submodule gitdirs — the
  // submodule's OWN config (`include.path` → `core.fsmonitor=<prog>`
  // executes inside the trusted spawn), index stat tuples, and
  // `info/{grafts,shallow,exclude}` all live outside every judged
  // surface: only the resolved gitdir's own paths are shape-checked
  // (CX-173). A populated `modules/` tree is unjudgeable today, so its
  // presence refuses the channel — a future RFC can add per-module
  // judging; an EMPTY `modules/` dir is ignored (a removed submodule's
  // residue is honest).
  "modules",
] as const;

/**
 * Shape paths reported as diagnostics without refusing — they cannot
 * falsify committed-object reads once the reader pins hold: the
 * commit-graph/MIDX caches are ignored under the
 * `core.commitGraph=false`/`core.multiPackIndex=false` pins
 * (CX-88: a forged graph DID lie before the pin existed).
 */
const EVIDENCE_SHAPE_WARN_PATHS = [
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
export async function execEvidenceGit(
  cwd: string,
  args: string[],
  opts?: {
    extraEnv?: Record<string, string>;
    internalEnv?: Record<string, string>;
    input?: string | Buffer;
  },
): Promise<VerifierGitResult> {
  // `spawn` not `execFile`: Node's execFile silently drops `stdio[3+]`,
  // so an inherited claims-index fd requires spawn outright (CX-129).
  const r = await spawnCaptured(resolveGitBin(), ["-C", cwd, ...evidenceSpawnArgs(args)], {
    cwd,
    env: {
      ...verifierGitEnv(),
      ...(opts?.extraEnv ?? {}),
      // Resolution pins land last — verifier-owned, never overridable
      // (CX-143).
      ...(opts?.internalEnv ?? {}),
    },
    timeoutMs: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts?.input,
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
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
  // `-v`/`-vv`/`--verbose` decorate each line with the upstream tracking
  // claim — `branch.<n>.{remote,merge}` is session-writable config, so
  // the column can fabricate a tracking relationship (R13-D).
  "-v",
  "--verbose",
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
 * namespace inside the trusted channel. `config` is admitted only in its
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
  // `--branch`/`-b` adds the `## <branch>...<upstream>` tracking line —
  // the upstream claim is `branch.<n>.{remote,merge}` config, which a
  // session rewrite can fabricate (R13-D). The long-format equivalent
  // dies by the `branch.<HEAD>.*` pins the judge emits.
  // `--show-stash` prints "Your stash currently has N entries" — N is
  // a count of `.git/logs/refs/stash` REFLOG lines, session-fabricable
  // with no real stash objects: the CX-92 exclusion class (CX-146).
  { prefix: ["status"], forbid: ["--branch", "-b", "--show-stash"] },
  // `--notes`/`--show-notes` add session-planted `refs/notes/*` bodies to
  // the display set — argv overrides the `notes.displayRef=`/`core.notesRef=`
  // pins verbatim, serving the provenance class the `%(notes)` atom refusal
  // exists to close (CX-154). `--no-notes` suppresses and stays admitted.
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
      "--notes",
      "--show-notes",
    ],
  },
  { prefix: ["diff"], forbid: ["--output", "--ext-diff", "--textconv", "--no-index"] },
  {
    prefix: ["show"],
    forbid: ["--output", "--ext-diff", "--textconv", "-g", "--reflog", "--notes", "--show-notes"],
  },
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
  // `check-ignore` is a pure read — ignore-rule matching against
  // `.gitignore`/`info/exclude`/`core.excludesFile`, no drivers, no
  // writes. `--stdin` reads piped pathnames; the spawn's stdin is
  // caller-supplied `opts.input` (or EOF), never a hang (CX-166: the
  // audit gate's exclusion check runs ON the channel so its
  // fingerprint re-prove bounds the rule-source TOCTOU the same way
  // every other read's is bounded).
  { prefix: ["check-ignore"] },
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
  // `%(upstream)`/`%(push)`/`%(track)` expand `branch.<n>.{remote,merge,
  // pushremote}` claims — session-writable config that can fabricate a
  // tracking relationship in `for-each-ref --format` output (R13-D).
  // `%(notes)` expands the session-planted notes ref. Both families
  // cannot be pinned by name (the branch/ref names are positional), so
  // the atoms are refused outright — fail closed, never a shaped answer.
  if (args.some((a) => /%\((?:upstream|push|track|notes)/i.test(a))) return false;
  // `%N` expands session-planted notes in `log`/`show` format strings —
  // the `%(notes)` atom check misses the placeholder form, and the
  // displayRef pins then curate the answer to "" (CX-154). `%n` is a
  // newline and stays admitted; `rev-list` leaves `%N` literal
  // (verified git 2.53) so only the expanding subcommands judge it.
  if ((args[0] === "log" || args[0] === "show") && args.slice(1).some((a) => a.includes("%N"))) {
    return false;
  }
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
    // A symlinked fanout is a shape violation the judge refuses — skip
    // the descent here too so a session-owned target tree is never
    // walked (CX-145).
    try {
      if (lstatSync(absDir).isSymbolicLink()) continue;
    } catch {
      continue;
    }
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
      // safeReadBytes: a FIFO swap-in between the stat check and the
      // read must not block the verifier (CX-144); a non-regular or
      // unreadable loose entry is non-servable, the same outcome a
      // corrupt object gets.
      const bytes = safeReadBytes(abs);
      try {
        if (bytes === null) throw new Error("unreadable");
        const inflated = inflateSync(bytes);
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

export async function scanPackObjects(
  objectsDir: string,
  internalEnv?: Record<string, string>,
): Promise<string[]> {
  const forged: string[] = [];
  const packDir = path.join(objectsDir, "pack");
  // A symlinked pack dir is a shape violation the judge refuses — skip
  // the enumeration so a session-owned target tree is never walked
  // (CX-145).
  try {
    if (lstatSync(packDir).isSymbolicLink()) return forged;
  } catch {
    return forged;
  }
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
    const r = await execEvidenceGit(path.dirname(packDir), ["verify-pack", "-s", absIdx], {
      internalEnv,
    });
    if (r.exitCode === 0) {
      if (verifiedPackFiles.size > 4_000) verifiedPackFiles.clear();
      verifiedPackFiles.set(absIdx, stKey);
    } else {
      forged.push(`objects/pack/${name}`);
    }
  }
  return forged;
}

let evidenceHeldSeq = 0;
/**
 * The named-fallback held-file name — flat under the OS temp root,
 * unique per process + sequence. A same-uid session can still discover
 * and overwrite the file, but the per-spawn byte re-prove turns any
 * rewrite into `unproven`/`configUnproven` (a refused read), never a
 * forged view (CX-129).
 */
function evidenceHeldName(stem: string): string {
  return `forge-evidence-${stem}-${process.pid}-${++evidenceHeldSeq}`;
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
 * Held bytes a same-uid session can never reach: prefer O_TMPFILE — an
 * unnamed inode, never path-addressable; fall back to a named file that
 * is written, reopened read-only, byte-proven, and unlinked while the
 * fd is still held. The fd is what children inherit (the verifier-owned
 * index on fd 3) — a rewrite attack has no path left to target
 * (CX-129).
 */
function createHeldFile(bytes: Buffer, stem: string): number | null {
  const oTmpfile = (fsConstants as { O_TMPFILE?: number }).O_TMPFILE;
  if (typeof oTmpfile === "number") {
    // O_TMPFILE straight on the OS temp root — the inode is created
    // NAMELESS, so nothing ever lands in a directory listing for a
    // same-uid session to discover, chmod, or overwrite (CX-129). `/tmp`
    // is root-owned/sticky — the session cannot chmod the dir itself to
    // block the creation, and no `forge-evidence-*` name exists for
    // its enumeration probes to find.
    try {
      const fd = openSync(os.tmpdir(), oTmpfile | fsConstants.O_RDWR, 0o600);
      writeSync(fd, bytes);
      return fd;
    } catch {
      /* tmpfs/fs lacks O_TMPFILE — named fallback below */
    }
  }
  const p = path.join(os.tmpdir(), evidenceHeldName(stem));
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

/**
 * Re-prove a path-mode held file's on-disk bytes before a spawn trusts
 * the pin — the no-`/dev/fd` fallback leaves an addressable file a
 * same-uid session can rewrite, so `GIT_INDEX_FILE=<path>` must
 * byte-compare right before use or the pinned scope silently reads
 * forged bytes (R13-D parity with the fd form's re-prove). Returns
 * true for fd-form held files — the open file description pins them
 * already.
 */
export function heldPathProven(held: EvidenceIndex): boolean {
  if (held.path === undefined) return true;
  const b = safeReadBytes(held.path);
  return b !== null && b.equals(held.bytes);
}

/**
 * Produce the `EvidenceIndex` a preflight stores — fd form where
 * `/dev/fd` exists, named-path fallback elsewhere (the per-spawn byte
 * re-prove still applies). `null` when even the fallback write failed.
 */
export function heldEvidenceFile(bytes: Buffer, stem: string): EvidenceIndex | null {
  const fd = createHeldFile(bytes, stem);
  if (fd !== null && existsSync("/dev/fd")) return { fd, bytes };
  if (fd !== null) closeSync(fd);
  const p = path.join(os.tmpdir(), evidenceHeldName(stem));
  try {
    writeFileSync(p, bytes, { mode: 0o600 });
  } catch {
    return null;
  }
  return { path: p, bytes };
}

export async function prepareEvidenceIndex(
  repoRoot: string,
  internalEnv?: Record<string, string>,
): Promise<EvidenceIndexPreparation> {
  // The claims listing spawns with the static pins via env: `ls-files`
  // consults `core.fsmonitor` even for a pure --stage dump — a session
  // program must not exec inside the enumeration (CX-115 class). The
  // static pins are unconditional (R13-D): the live config the spawn
  // reads cannot arm a lever the pin set does not name. Resolution pins
  // anchor it to the same gitdir the fingerprint judged (CX-143).
  const claims = await execEvidenceGit(repoRoot, ["ls-files", "--stage", "-z"], {
    extraEnv: evidencePinEnv(["ls-files"]),
    internalEnv,
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
  const index = heldEvidenceFile(bytes, "index");
  // No /dev/fd (win32): the on-disk fallback stays addressable but every
  // spawn re-verifies its bytes against `bytes` before trusting it —
  // a session rewrite flips the index to unproven, never to forged data.
  return index === null
    ? { failure: ".git/index claims write failed (held file creation failed)" }
    : { index };
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
  headBranch?: string | null,
  fingerprint?: EvidenceFingerprint,
): EvidencePreflight {
  const configArgs: string[] = [];
  const hookArgs: string[] = [];
  const refusedKeys: string[] = [];
  const shapeViolations: string[] = [];
  const warnedShape: string[] = [];
  let objectFormat: string | undefined;
  for (const entry of listedStdout.split("\0")) {
    if (entry.length === 0) continue;
    const nl = entry.indexOf("\n");
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    if (key === "extensions.objectformat") objectFormat = value.toLowerCase();
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
    const name = EVIDENCE_SHAPE_QUERY_PATHS[i] ?? `shape#${i}`;
    // An unresolved shape path is a violation, not a skip — the
    // `--git-path` query answering null means the surface could not be
    // enumerated, which is the same unproven class a refused file is.
    if (resolvedPath === null) {
      shapeViolations.push(name);
      return;
    }
    // `--git-path` answers relative to the queried repo — resolve against
    // repoRoot, never the process cwd, or the file check reads nothing.
    // A newline inside the path itself is preserved (per-path queries,
    // CX-89) and resolves to the real file location.
    const abs = path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(repoRoot, resolvedPath);
    const buf = safeReadBytes(abs);
    if (buf === null) {
      // Classify the non-capturable path: a vanished entry leaves stat
      // to fail identically (the fingerprint reprove reads drift), a
      // DIRECTORY is the expected shape for warn paths like
      // `objects/info/commit-graphs` (and unparseable-as-file on refuse
      // paths — git ignores a directory-shaped rules file), a regular
      // file that failed to read is unprovable either way, and a
      // FIFO/socket/device on a refuse path blocks git's own read —
      // refuse. Warn-path non-regulars stay warn: the unconditional
      // reader pins (`core.commitGraph=false`, MIDX off) make the file
      // unreachable, so it cannot falsify committed-object reads
      // (CX-144).
      let lst;
      try {
        lst = lstatSync(abs);
      } catch {
        return;
      }
      if (lst.isDirectory()) {
        // `modules` is the one refuse path judged as a DIRECTORY: a
        // populated submodule gitdir carries its own config
        // (`include.path` → `core.fsmonitor` executes inside the
        // trusted spawn), index, and info surface — none of it judged
        // (CX-173). Any entry refuses; an empty `modules/` is honest
        // residue from a removed submodule.
        if (i < EVIDENCE_SHAPE_PATHS.length && name === "modules") {
          try {
            if (readdirSync(abs).length > 0) shapeViolations.push(name);
          } catch {
            /* unreadable dir — the fingerprint reprove reads the drift */
          }
        }
        return;
      }
      if (lst.isFile() || i < EVIDENCE_SHAPE_PATHS.length) {
        shapeViolations.push(name);
      } else {
        warnedShape.push(name);
      }
      return;
    }
    const body = buf.toString("utf8");
    // Any non-empty non-comment line is content. git's parsers comment
    // col-0 `#` only — a whitespace-only line is a LITERAL path entry
    // (`.git/objects/   `, CX-91) and so is `   # x` (`.git/objects/   # x`,
    // CX-95); only a bare first-byte `#` is a comment.
    const effective = body.split("\n").some((l) => l.length > 0 && !l.startsWith("#"));
    if (!effective) return;
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
    // `<common>/worktrees/<id>` admin dirs are session-writable and git
    // serves them verbatim in `worktree list` — a hand-crafted entry
    // produces a phantom worktree on every channel (R13-B). Each entry
    // must carry the state `git worktree add` itself writes: a `gitdir`
    // file naming the target's `.git`, a `commondir` resolving back to
    // this common dir, and a well-formed `HEAD` (symref or object name —
    // never a bare `refs/…` line). `index` is conditional — a
    // `--no-checkout` worktree legitimately has none until its first
    // checkout — but a present index must carry DIRC magic. A fully
    // well-formed entry is indistinguishable from `git worktree add`
    // output — a state a same-uid session can produce anyway — so
    // well-formedness is the honest bound; anything less refuses the
    // channel. The stale/missing-target case git tolerates on listing
    // stays tolerated: the check pins admin SHAPE, never target liveness.
    const commonDir = path.dirname(absObjects);
    let wtEntries: import("node:fs").Dirent[];
    try {
      wtEntries = readdirSync(path.join(commonDir, "worktrees"), { withFileTypes: true });
    } catch {
      wtEntries = [];
    }
    // Symlinked dirs inside the fingerprinted trees (CX-145): the
    // fingerprint walk records a symlink as ONE leaf and never
    // descends, while git and the loose/pack scans DO descend through
    // it — members beneath are fingerprint-invisible, so an in-place
    // member rewrite survives the reprove forever and the cached
    // channel serves the forged bytes under real names. Git never
    // creates symlinked dirs inside `objects/` or `worktrees/` — the
    // same asymmetric-hardening bound the `worktrees/<id>` judge below
    // already enforces on the Dirent level — so presence refuses.
    for (const [rel, st] of fingerprint?.objectFiles ?? []) {
      if (st.linkDir === true) shapeViolations.push(`objects/${rel}`);
    }
    for (const [rel, st] of fingerprint?.worktreeFiles ?? []) {
      if (st.linkDir === true) shapeViolations.push(`worktrees/${rel}`);
    }
    for (const e of wtEntries) {
      const meta = path.join(commonDir, "worktrees", e.name);
      let wellFormed = e.isDirectory();
      if (wellFormed) {
        const gd = safeReadBytes(path.join(meta, "gitdir"))?.toString("utf8").trim();
        const cd = safeReadBytes(path.join(meta, "commondir"))?.toString("utf8").trim();
        const hd = safeReadBytes(path.join(meta, "HEAD"))?.toString("utf8").trim();
        const ix = safeReadBytes(path.join(meta, "index"));
        wellFormed =
          gd !== undefined &&
          gd.length > 0 &&
          path.basename(gd) === ".git" &&
          cd !== undefined &&
          cd.length > 0 &&
          path.resolve(meta, cd) === commonDir &&
          hd !== undefined &&
          /^(?:ref: refs\/\S+|[0-9a-f]{40,64})$/.test(hd) &&
          (ix === null || (ix.length >= 4 && ix.subarray(0, 4).toString("latin1") === "DIRC"));
      }
      if (!wellFormed) shapeViolations.push(`worktrees/${e.name}`);
    }
  }
  // `commondir`/`gitdir` files belong ONLY inside a worktree metadir
  // (`<common>/worktrees/<id>/`) — git never writes them into a primary
  // `.git`, yet it still HONORS a `commondir` file found there: its
  // content overrides even env-pinned resolution for refs/objects
  // (empirical, git 2.53 — `GIT_COMMON_DIR` wins `--git-path` answers
  // but the ref store re-reads the file), so a planted primary
  // `commondir` is a redirect no env pin can neutralize (CX-143). Its
  // presence is therefore a violation, never inert: refusal is the only
  // answer a session's forged common cannot ride. Inside a metadir the
  // same file is REQUIRED and must resolve back to the structurally
  // derived common dir — content pointing elsewhere is the same class.
  if (fingerprint?.gitDir != null && fingerprint.commonDir != null) {
    const isMetadir = fingerprint.commonDir !== fingerprint.gitDir;
    for (const entry of fingerprint.indirection) {
      const name = path.basename(entry.path);
      if (path.dirname(entry.path) !== fingerprint.gitDir) continue;
      if (name === "commondir") {
        if (isMetadir) {
          const txt = entry.bytes?.toString("utf8").trim();
          const resolved =
            txt !== undefined && txt.length > 0
              ? path.isAbsolute(txt)
                ? txt
                : path.resolve(fingerprint.gitDir, txt)
              : null;
          if (resolved !== fingerprint.commonDir) {
            shapeViolations.push(`commondir (${entry.path})`);
          }
        } else if (entry.bytes !== null) {
          shapeViolations.push(`commondir (${entry.path})`);
        }
      } else if (name === "gitdir" && !isMetadir && entry.bytes !== null) {
        shapeViolations.push(`gitdir (${entry.path})`);
      }
    }
  }
  // Upstream-lever neutralization (R13-D): `status`'s long format
  // displays `branch.<cur>.{remote,merge}` claims verbatim — a config
  // flip post-dump could fabricate "ahead of 'session-ref'" tracking
  // text. The pin only covers HEAD's branch because that is the only
  // upstream status ever evaluates; every other surface for the claim
  // (`for-each-ref %(upstream)`/`%(track)`/`%(push)`, `status -sb`,
  // `branch -v`) is argv-refused instead. Config-unexpressible names
  // cannot be armed through config at all, so they need no pin.
  if (headBranch !== undefined && headBranch !== null && /^[\w][\w./-]*$/.test(headBranch)) {
    configArgs.push(
      "-c",
      `branch.${headBranch}.remote=`,
      "-c",
      `branch.${headBranch}.merge=`,
      "-c",
      `branch.${headBranch}.pushremote=`,
    );
  }
  // `core.bare` is a DERIVED pin, not a blanket false (CX-162/CX-171):
  // the unconditional `core.bare=` made `rev-parse --is-bare-repository`
  // answer "false" on a genuinely bare repo on a perfectly healthy
  // channel — the channel itself emitting fabricated evidence, no
  // refusal needed, and every bare-aware consumer (`detectRepoKind`,
  // `collectFlowCheck`, `isFlowAdopted`) silently re-derived identity
  // from filesystem paths git never serves. Bareness is a TOPOLOGICAL
  // fact computed from the anchored resolution, never the config claim
  // (a session `core.bare` claim is neutralized to empty by the key
  // loop above, and this pin lands last so it wins): `"worktree"`
  // topology → false; `"selfdir"` — git found the gitdir itself with no
  // `.git` node to hang a worktree on — is bare no matter what the
  // session wrote in `core.bare` (a planted `bare=false` inside a real
  // bare repo otherwise reopens the exempt-marker path, CX-171).
  if (fingerprint?.gitDir != null && fingerprint.topology === "unknown") {
    // Git resolved a gitdir the ancestor walk cannot re-derive — the
    // resolution is unexplainable under the captured surface, so no
    // pin can be proven right; refuse rather than guess (CX-171).
    shapeViolations.push("topology");
  }
  const derivedBare = fingerprint?.topology === "selfdir";
  configArgs.push("-c", `core.bare=${derivedBare ? "true" : ""}`);
  return { configArgs, hookArgs, refusedKeys, shapeViolations, warnedShape, objectFormat };
}

/**
 * Synchronous byte capture that can never block: a FIFO, device node,
 * or socket planted at a `.git` metadata path hangs `readFileSync` at
 * open() — the verifier deadlocks instead of refusing (CX-144). The
 * file is opened O_NONBLOCK (a no-op on regular files) and fstat gates
 * the read to regular files only; anything else is uncapturable, which
 * the callers treat as unprovable (fail closed) — never as absent.
 */
function safeReadBytes(abs: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * The `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` env pins a fingerprint's
 * resolution anchors emit — applied to every internal preflight
 * subprocess (`--git-path`, config dump, claims `ls-files`, verify-pack)
 * and to every judged spawn, so `.git` indirection files (gitfile,
 * `commondir`, and a planted `<subdir>/.git`) reach nothing inside a
 * child: env selectors preempt discovery and indirection files outright
 * (CX-143). Null members simply emit nothing (bare repos have no
 * worktree pin).
 */
export function resolutionEnv(
  fp: Partial<Pick<EvidenceFingerprint, "gitDir" | "commonDir" | "workTree">> | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (fp?.gitDir != null) env["GIT_DIR"] = fp.gitDir;
  // `GIT_COMMON_DIR` only when it genuinely differs — i.e. a linked
  // worktree metadir. Pinning it equal to `GIT_DIR` is NOT an identity
  // no-op: a set GIT_COMMON_DIR takes setup down the linked-worktree
  // branch, which derives the worktree from CWD — on a bare repo that
  // fabricates a worktree and `--is-bare-repository` answers `false`
  // even under a `core.bare=true` config pin (CX-162). For a normal
  // repo the redirect defense is unchanged: a planted `commondir` file
  // in a primary `.git` is refused on presence, and the ambient env is
  // scrubbed, so nothing left can re-point the common dir.
  if (fp?.commonDir != null && fp.commonDir !== fp.gitDir) env["GIT_COMMON_DIR"] = fp.commonDir;
  if (fp?.workTree != null) env["GIT_WORK_TREE"] = fp.workTree;
  return env;
}

/**
 * Every file inside a fingerprinted subtree, keyed by path relative to
 * the root — loose objects, packs, `info/*`, worktree admin files, and
 * any session-dropped extra file. The stat triple (ino, ctimeMs, size)
 * is unforgeable: ctime is kernel-managed (CX-114), so a rewrite, a
 * replant, or a new file is always drift — never a stale-but-consistent
 * fingerprint. Symlink dirents pin the TARGET string plus the resolved
 * target's stat — a retarget changes neither link nor stat in place but
 * always differs in the recorded pair (R13 secondary: symlinks were
 * invisible to the sweep, leaving a retarget race).
 */
function enumerateTreeFiles(root: string): Map<string, EvidenceSurfaceFile> {
  const files = new Map<string, EvidenceSurfaceFile>();
  for (let i = 0, stack = [""]; i < stack.length; i++) {
    const rel = stack[i]!;
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const er = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        stack.push(er);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const ap = path.join(root, er);
      try {
        if (e.isSymbolicLink()) {
          const link = readlinkSync(ap);
          let st;
          try {
            st = statSync(ap);
          } catch {
            st = lstatSync(ap);
          }
          files.set(er, {
            ino: st.ino,
            ctimeMs: st.ctimeMs,
            size: st.size,
            link,
            // A dir target means members beneath the link are never
            // fingerprinted by this leaf (CX-145) — flagged for the
            // judge; equal stat+link tuples imply equal flags.
            ...(st.isDirectory() ? { linkDir: true as const } : {}),
          });
        } else {
          const st = statSync(ap);
          files.set(er, { ino: st.ino, ctimeMs: st.ctimeMs, size: st.size });
        }
      } catch {
        /* vanished mid-scan — the judge's own sweep sees the same state */
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
/**
 * BEFORE the first spawn: find the `.git` git's own discovery would see
 * and prove the metadata git opens at startup is regular — a FIFO
 * `.git/config` (or `HEAD`, a gitfile, `commondir`) blocks open()
 * forever, deadlocking every child instead of refusing (CX-144). The
 * scan mirrors git's walk-up so a subdirectory cwd sees the parent's
 * `.git`; any non-regular member is reported and the caller refuses
 * WITHOUT spawning — no child ever enters a blocking read.
 */
/**
 * Whether a repo-shaped surface exists at or above `dir` — any `.git`
 * node (dir, gitfile, link, FIFO) at lstat level, or a bare-repo
 * signature (`HEAD` + `objects/` + `refs/`). Consulted ONLY when the
 * trusted channel could not answer: `-1` means both "no repo" and
 * "unenumerable repo", indistinguishable by exit code — a same-UID
 * session can fabricate the not-a-repo shape (`.git/HEAD` FIFO →
 * preflight null, CX-156), so existence of git state to forge is the
 * honest discriminator. Absent → genuinely nothing to protect.
 */
export function repoShaped(repoRoot: string): boolean {
  let dir = path.resolve(repoRoot);
  for (let depth = 0; depth <= 64; depth++) {
    try {
      lstatSync(path.join(dir, ".git"));
      return true;
    } catch {
      /* absent — keep walking */
    }
    // Bare-repo signature: HEAD (any node type — a FIFO counts, it is
    // still the surface to forge) plus the objects/refs directories.
    try {
      lstatSync(path.join(dir, "HEAD"));
      if (
        statSync(path.join(dir, "objects")).isDirectory() &&
        statSync(path.join(dir, "refs")).isDirectory()
      ) {
        return true;
      }
    } catch {
      /* not a bare signature */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function discoverGitMetaHazards(repoRoot: string): string[] {
  const hazards: string[] = [];
  const scanGitdir = (gitdir: string) => {
    for (const name of ["config", "HEAD", "commondir", "gitdir", "packed-refs"]) {
      const ap = path.join(gitdir, name);
      try {
        if (!statSync(ap).isFile()) hazards.push(ap);
      } catch {
        /* absent — fine */
      }
    }
    // Loose refs: git opens every ref file its read resolves — a FIFO or
    // device under refs/ stalls the child to the spawn timeout before the
    // channel can fail closed (residual r16 observation). Stat every
    // member: dirs and regular files are legitimate, anything else fails
    // closed pre-spawn. Bounded by depth and member count.
    const stack: Array<{ dir: string; depth: number }> = [
      { dir: path.join(gitdir, "refs"), depth: 0 },
    ];
    let scanned = 0;
    while (stack.length > 0 && scanned < 8192) {
      const { dir, depth } = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned++;
        const ap = path.join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(ap);
        } catch {
          continue; // dangling or unreadable — git fails honestly on it
        }
        if (st.isDirectory()) {
          if (depth < 32) stack.push({ dir: ap, depth: depth + 1 });
          continue;
        }
        if (!st.isFile()) hazards.push(ap);
      }
    }
  };
  for (let dir = path.resolve(repoRoot), depth = 0; depth <= 64; depth++) {
    const p = path.join(dir, ".git");
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(p);
    } catch {
      /* absent — keep walking */
    }
    if (st === null) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    if (st.isDirectory()) {
      scanGitdir(p);
      return hazards;
    }
    if (!st.isFile()) {
      // `.git` as a FIFO/socket/device — discovery blocks reading it.
      hazards.push(p);
      return hazards;
    }
    // `.git` file: a gitfile redirect. An unreadable one (FIFO swap)
    // hangs git's own open — hazard; a malformed one fails honestly.
    const bytes = safeReadBytes(p);
    if (bytes === null) {
      hazards.push(p);
      return hazards;
    }
    const m = /^gitdir:\s*(.+)$/m.exec(bytes.toString("utf8").trim());
    if (m !== null) {
      const meta = path.isAbsolute(m[1]!.trim()) ? m[1]!.trim() : path.resolve(dir, m[1]!.trim());
      scanGitdir(meta);
      // A linked-worktree metadir (`<common>/worktrees/<id>`) holds no
      // refs of its own — they live in the structural common dir two
      // levels up; scan it too or a FIFO there still stalls the child.
      if (path.basename(path.dirname(meta)) === "worktrees") {
        scanGitdir(path.dirname(path.dirname(meta)));
      }
    }
    return hazards;
  }
  return hazards;
}

export async function captureEvidenceSurface(
  repoRoot: string,
  runGit: EvidenceGitRunner,
  prior?: Pick<EvidenceFingerprint, "gitDir" | "commonDir" | "workTree"> | null,
): Promise<{
  configPath: string | null;
  indexPath: string | null;
  objectsDir: string | null;
  shapePaths: (string | null)[];
  /** `symbolic-ref --short HEAD` — the current branch name for the
   * upstream-lever pin, or null (detached/absent/failed). */
  headBranch: string | null;
  anyFailed: boolean;
  /** Non-regular `.git` metadata that would block git's own startup
   * reads (CX-144) — the caller refuses without spawning. */
  hazards: string[];
  fingerprint: EvidenceFingerprint;
}> {
  const dotGitAbs = path.join(repoRoot, ".git");
  const indirection: { path: string; bytes: Buffer | null }[] = [];
  let dotGit: EvidenceFingerprint["dotGit"] = { kind: "absent" };
  // Non-regular metadata scan runs FIRST — everything after this point
  // spawns git children that would block on a FIFO read (CX-144).
  const hazards = discoverGitMetaHazards(repoRoot);
  if (hazards.length > 0) {
    try {
      const st = statSync(dotGitAbs);
      if (st.isDirectory()) dotGit = { kind: "dir", ino: st.ino, ctimeMs: st.ctimeMs };
    } catch {
      /* absent */
    }
    return {
      configPath: null,
      indexPath: null,
      objectsDir: null,
      shapePaths: EVIDENCE_SHAPE_QUERY_PATHS.map(() => null),
      headBranch: null,
      anyFailed: true,
      hazards,
      fingerprint: {
        dotGit,
        gitDir: null,
        gitDirStat: null,
        commonDir: null,
        workTree: null,
        indirection,
        configPath: null,
        configBytes: null,
        shapeFiles: [],
        objectsDir: null,
        objectFiles: new Map(),
        worktreesDir: null,
        worktreeFiles: new Map(),
        modulesDir: null,
        modulesFiles: new Map(),
        indexPath: null,
        indexBytes: null,
        topology: "unknown",
      },
    };
  }
  try {
    const st = statSync(dotGitAbs);
    if (st.isDirectory()) {
      dotGit = { kind: "dir", ino: st.ino, ctimeMs: st.ctimeMs };
      const cdBytes = safeReadBytes(path.join(dotGitAbs, "commondir"));
      indirection.push({ path: path.join(dotGitAbs, "commondir"), bytes: cdBytes });
    } else if (st.isFile()) {
      const bytes = safeReadBytes(dotGitAbs);
      if (bytes !== null) {
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
      // A non-regular `.git` (FIFO, socket, device) records as absent —
      // git's own resolution below fails identically, which is the
      // fail-closed answer (CX-144).
    }
  } catch {
    /* .git absent — the op fails on its own */
  }
  // Resolution anchors — `rev-parse --absolute-git-dir` is the ONLY
  // read that consults `.git` indirection, and only on a FRESH capture:
  // a re-capture after drift (the reprove loop's re-preflight) pins the
  // prior fingerprint's `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` into
  // the resolve env, so a commondir/gitfile plant between captures
  // cannot steer the re-resolution into a forged common dir — env pins
  // preempt indirection files inside children, and the plant still
  // reads as indirection drift (CX-143). `--show-toplevel` resolves the
  // worktree the same way (absent for bare repos — no pin is emitted).
  const resolution = await runGit(repoRoot, ["rev-parse", "--absolute-git-dir"], {
    preflight: false,
    internalEnv: resolutionEnv(prior),
  });
  let gitDir = resolution.exitCode === 0 ? resolution.stdout.replace(/\r?\n$/, "") || null : null;
  if (gitDir !== null && !path.isAbsolute(gitDir)) gitDir = path.resolve(repoRoot, gitDir);
  // A linked-worktree metadir is identified by the MARKER PAIR git
  // itself writes — `commondir` (→ the common dir) and `gitdir` (→ the
  // worktree's `.git` file) — not by path name alone: a self-contained
  // gitdir sitting under a `worktrees/`-named parent is a bare repo,
  // and name-shape classification refused every judged read on it
  // (CX-171). Markers BELOW the structural position stay what they
  // were — a `commondir`/`gitdir` pair anywhere else is the redirect
  // plant the presence-refusal below still refuses.
  const isMetadir =
    gitDir !== null &&
    path.basename(path.dirname(gitDir)) === "worktrees" &&
    safeReadBytes(path.join(gitDir, "commondir")) !== null &&
    safeReadBytes(path.join(gitDir, "gitdir")) !== null;
  // commonDir is derived STRUCTURALLY — a marker-proven metadir under
  // `<common>/worktrees/` belongs to `<common>`, anything else is its
  // own common dir. `commondir` file content is never honored: honoring
  // it would resolve a session-forged target wholesale; children pin
  // GIT_COMMON_DIR only when it differs from GIT_DIR, and a commondir
  // file in a primary `.git` is refused on presence (CX-143/CX-162).
  const commonDir = isMetadir ? path.dirname(path.dirname(gitDir!)) : gitDir;
  // Topological bareness (CX-162/CX-171): re-walk the ancestor chain git
  // itself walked. A `.git` NODE (dir or file) at some level means the
  // gitdir was resolved through worktree discovery — non-bare. Reaching
  // the resolved gitdir itself first means git self-discovered it as a
  // gitdir — no worktree node exists, so `--is-bare-repository` falls
  // back to the `core.bare` config claim; the claim is session-writable,
  // so the channel reports the topological fact instead: bare. PATH NAME
  // SHAPE cannot decide this — a self-contained bare repo literally
  // named `.git` or parked under a `worktrees/`-named parent is still
  // bare (CX-171). On a bare repo `--show-toplevel` must NOT run: with
  // `GIT_DIR` pinned and no worktree selector, git treats the CWD itself
  // as the implicit worktree and answers the gitdir — the fingerprint
  // then pins `GIT_WORK_TREE=<gitdir>` into every judged spawn, where
  // the env selector outranks the `core.bare=true` pin and re-fabricates
  // "non-bare". `workTree=null` on bare is the honest resolution.
  const topologyResult =
    gitDir === null
      ? { topology: "unknown" as RepoTopology, workTree: null }
      : classifyTopology(repoRoot, gitDir);
  const topology = topologyResult.topology;
  // The worktree toplevel is the level where the `.git` node was found
  // during discovery — a structural fact of the walk, never a spawned
  // answer: `--show-toplevel` under a pinned `GIT_DIR` resolves the CWD
  // itself as the implicit worktree (CX-162's bare-repo trap applies to
  // every subdirectory cwd, CX-167). A `core.worktree` claim that would
  // override this derivation is a refused config claim, so the channel
  // refuses before a wrong anchor can pin.
  const workTree = topologyResult.workTree;
  // Every internal spawn below runs pinned to the resolved anchors — a
  // mid-capture indirection rewrite can no longer re-point a
  // `--git-path` resolve into fresh fake-land.
  const internalEnv = resolutionEnv({ gitDir, commonDir, workTree });
  // Resolved-gitdir indirection — for a subdirectory cwd the parent
  // `.git` is unreachable through `repoRoot`, so its commondir/gitdir/
  // HEAD only joins the fingerprint at the resolved anchor (CX-143).
  // A planted commondir then drifts the fingerprint AND can never be
  // followed: `GIT_COMMON_DIR` preempts it where pinned, and where the
  // pin is withheld (CX-162) presence alone is a violation.
  if (gitDir !== null) {
    const seen = new Set(indirection.map((i) => i.path));
    for (const name of ["commondir", "gitdir", "HEAD"]) {
      const ap = path.join(gitDir, name);
      if (seen.has(ap)) continue;
      indirection.push({ path: ap, bytes: safeReadBytes(ap) });
    }
  }
  let gitDirStat: EvidenceFingerprint["gitDirStat"] = null;
  if (gitDir !== null) {
    try {
      const st = statSync(gitDir);
      if (st.isDirectory()) gitDirStat = { ino: st.ino, ctimeMs: st.ctimeMs };
    } catch {
      /* vanished mid-capture — reprove reads the stat mismatch as drift */
    }
  }
  const queries = ["config", "index", "objects", ...EVIDENCE_SHAPE_QUERY_PATHS];
  const pending: Promise<{ exitCode: number | null; stdout: string; stderr: string }>[] = [];
  for (const p of queries) {
    pending.push(
      runGit(repoRoot, ["rev-parse", "--git-path", p], { preflight: false, internalEnv }),
    );
  }
  // The current branch name feeds the upstream-lever pin — `status`'s
  // long format displays `branch.<cur>.{remote,merge}` claims verbatim,
  // so the judge pins those keys for HEAD's branch (R13-D). Kept OUT of
  // the resolve results: detached HEAD/fresh-repo exits non-zero and
  // must not count as surface failure.
  const headBranchPending = runGit(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"], {
    preflight: false,
    internalEnv,
  });
  const [results, headBranchResult] = await Promise.all([Promise.all(pending), headBranchPending]);
  const headBranch =
    headBranchResult.exitCode === 0 ? headBranchResult.stdout.trim() || null : null;
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
  const shapeFiles: { path: string; present: boolean; bytes: Buffer | null }[] = [];
  for (const p of shapePaths) {
    const ap = p === null ? null : path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
    // Content bytes, not just presence — a zero-byte shape file armed
    // after capture must read as drift, not as the same fingerprint
    // (R13-A).
    const present = ap !== null && existsSync(ap);
    shapeFiles.push({
      path: ap ?? "",
      present,
      bytes: ap === null || !present ? null : safeReadBytes(ap),
    });
  }
  // `<common>/worktrees` comes from the structurally derived common
  // dir — a subdirectory cwd now fingerprints the parent repo's
  // worktree registry the same way a root cwd does (CX-143).
  const worktreesDir = commonDir === null ? null : path.join(commonDir, "worktrees");
  // `modules` resolved through the same `--git-path` query as every
  // refuse shape path; a populated dir is a violation the fingerprint
  // must see (CX-179) — enumerate its tree like objects/worktrees.
  const modulesResolved = shapePaths[EVIDENCE_SHAPE_QUERY_PATHS.indexOf("modules")] ?? null;
  const modulesDir =
    modulesResolved === null
      ? null
      : path.isAbsolute(modulesResolved)
        ? modulesResolved
        : path.resolve(repoRoot, modulesResolved);
  const fingerprint: EvidenceFingerprint = {
    dotGit,
    gitDir,
    gitDirStat,
    commonDir,
    workTree,
    indirection,
    configPath: configAbs,
    configBytes: configAbs === null ? null : safeReadBytes(configAbs),
    shapeFiles,
    objectsDir: objectsAbs,
    objectFiles: objectsAbs === null ? new Map() : enumerateTreeFiles(objectsAbs),
    worktreesDir,
    worktreeFiles: worktreesDir === null ? new Map() : enumerateTreeFiles(worktreesDir),
    modulesDir,
    modulesFiles: modulesDir === null ? new Map() : enumerateTreeFiles(modulesDir),
    indexPath: indexAbs,
    indexBytes: indexAbs === null ? null : safeReadBytes(indexAbs),
    topology,
  };
  return {
    configPath,
    indexPath,
    objectsDir,
    shapePaths,
    headBranch,
    anyFailed,
    hazards,
    fingerprint,
  };
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
  // The resolved gitdir itself: a same-path directory swap (rename
  // dance, replanted `.git`) keeps the path but always changes the
  // inode — same unforgeable stat contract as `dotGit`.
  if (fp.gitDir !== null) {
    try {
      const st = statSync(fp.gitDir);
      if (
        !st.isDirectory() ||
        fp.gitDirStat === null ||
        st.ino !== fp.gitDirStat.ino ||
        st.ctimeMs !== fp.gitDirStat.ctimeMs
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (fp.configPath !== null) {
    const b = safeReadBytes(fp.configPath);
    if (b === null ? fp.configBytes !== null : fp.configBytes === null || !b.equals(fp.configBytes))
      return false;
  }
  for (const s of fp.shapeFiles) {
    if (s.path === "") continue;
    if (existsSync(s.path) !== s.present) return false;
    // Content, not just presence — a zero-byte file armed after capture
    // keeps `present` true while the fingerprinted bytes differ (R13-A).
    const b = safeReadBytes(s.path);
    if (b === null ? s.bytes !== null : s.bytes === null || !b.equals(s.bytes)) return false;
  }
  if (fp.objectsDir !== null) {
    const cur = enumerateTreeFiles(fp.objectsDir);
    if (cur.size !== fp.objectFiles.size) return false;
    for (const [rel, st] of fp.objectFiles) {
      const c = cur.get(rel);
      if (
        c === undefined ||
        c.ino !== st.ino ||
        c.ctimeMs !== st.ctimeMs ||
        c.size !== st.size ||
        c.link !== st.link
      ) {
        return false;
      }
    }
  }
  if (fp.worktreesDir !== null) {
    const cur = enumerateTreeFiles(fp.worktreesDir);
    if (cur.size !== fp.worktreeFiles.size) return false;
    for (const [rel, st] of fp.worktreeFiles) {
      const c = cur.get(rel);
      if (
        c === undefined ||
        c.ino !== st.ino ||
        c.ctimeMs !== st.ctimeMs ||
        c.size !== st.size ||
        c.link !== st.link
      ) {
        return false;
      }
    }
  }
  if (fp.modulesDir !== null) {
    // An empty-at-capture `modules/` populated mid-window is invisible
    // to the shape-file byte check — the tree pin is what turns
    // population into drift → re-preflight → populated-dir refusal
    // (CX-179).
    const cur = enumerateTreeFiles(fp.modulesDir);
    if (cur.size !== fp.modulesFiles.size) return false;
    for (const [rel, st] of fp.modulesFiles) {
      const c = cur.get(rel);
      if (
        c === undefined ||
        c.ino !== st.ino ||
        c.ctimeMs !== st.ctimeMs ||
        c.size !== st.size ||
        c.link !== st.link
      ) {
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
    /**
     * Verifier-owned env applied verbatim (never filtered, never
     * caller-visible): the fingerprint's resolution pins. Internal
     * preflight subprocesses carry it so `.git` indirection plants
     * cannot steer their resolution mid-capture (CX-143).
     */
    internalEnv?: Record<string, string>;
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
export async function evidenceRepoPreflight(
  repoRoot: string,
  prior?: EvidenceFingerprint | null,
): Promise<EvidencePreflight | null> {
  // Indirection → resolves → fingerprint, fused so the ordering contract
  // (CX-134/135) cannot be misordered: `.git` gitfile/commondir bytes are
  // captured BEFORE the resolves they govern and the fingerprint freezes
  // same-or-older state BEFORE the judged reads below — the config dump
  // is the first. `--git-path objects` resolves the real object store —
  // shared for linked worktrees — so the loose-object re-hash judges the
  // same files the reads below would serve (CX-104). A failed resolve
  // feeds the judge `null`, which it counts as a violation — an unproven
  // object store must refuse, not silently skip the check. `prior` is
  // the previous capture's fingerprint on a drift re-preflight — its
  // resolution anchors pin this capture's resolves so a mid-flight
  // commondir/gitfile plant cannot steer re-resolution (CX-143).
  const { objectsDir, shapePaths, headBranch, hazards, fingerprint } = await captureEvidenceSurface(
    repoRoot,
    execEvidenceGit,
    prior,
  );
  // Resolution pins for every internal subprocess — the judged surface
  // and the spawns it enumerates stay anchored to the captured gitdir.
  const internalEnv = resolutionEnv(fingerprint);
  // A `.git/config` that exists but could not be byte-captured cannot be
  // drift-checked by the reprove — refuse every spawn rather than let a
  // live unjudged file reach it (R13-D). A NON-REGULAR config (FIFO,
  // socket, device — CX-144) is uncapturable by definition; its dump
  // would only hang git's own config read, so the dump is skipped and
  // the unproven flag refuses every read on its own. A `hazards` member
  // is the same class one level up — git's own STARTUP metadata
  // (`.git` itself, config, HEAD, gitfile/commondir targets) is
  // non-regular, so every subprocess blocks at open() and the whole
  // surface is unprovable before any dump could run.
  const configUnproven =
    hazards.length > 0
      ? `non-regular .git metadata (${hazards.join(", ")}) — git startup reads would block`
      : fingerprint.configPath !== null &&
          fingerprint.configBytes === null &&
          existsSync(fingerprint.configPath)
        ? ".git/config exists but could not be captured — spawn would read unjudged config"
        : undefined;
  const listed =
    configUnproven === undefined
      ? await execEvidenceGit(
          repoRoot,
          ["config", "--local", "--no-includes", "--list", "--null"],
          { internalEnv },
        )
      : { exitCode: 0, stdout: "", stderr: "" };
  if (listed.exitCode !== 0) {
    return null;
  }
  const preflight = judgeEvidenceRepoSurface(
    repoRoot,
    listed.stdout,
    shapePaths,
    objectsDir,
    headBranch,
    fingerprint,
  );
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
    preflight.shapeViolations.push(...(await scanPackObjects(absObjects, internalEnv)));
  }
  // `.git/index` is session-writable — a forged stat tuple answers
  // status/diff clean on dirty bytes (CX-121). Rebuild the index's claims
  // into a verifier-owned zero-stat index the trusted spawns inherit as
  // an fd, so no same-uid-rewritable path ever holds it (CX-129). A
  // failed rebuild marks the index unproven (CX-124): index-consulting
  // reads refuse, non-index reads stay trustworthy. A non-regular index
  // (CX-144) skips the spawn — its claims enumeration would only block
  // git's own open of the FIFO.
  const indexNonRegular =
    fingerprint.indexPath !== null &&
    fingerprint.indexBytes === null &&
    (() => {
      try {
        return !statSync(fingerprint.indexPath!).isFile();
      } catch {
        return false;
      }
    })();
  const prepared =
    hazards.length > 0
      ? { failure: "non-regular .git metadata — claims enumeration would block" }
      : indexNonRegular
        ? { failure: ".git/index is a non-regular file — claims enumeration would block" }
        : await prepareEvidenceIndex(repoRoot, internalEnv);
  preflight.index = prepared.index;
  preflight.indexUnproven = prepared.failure;
  preflight.configUnproven = configUnproven;
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
      // The child inherited its own dup of the held fd at fork — the
      // parent's per-spawn copy is dead weight after spawn() returns
      // (and on a spawn error it never reached a child at all).
      closeSpawnFds({ indexFd: opts.indexFd });
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
 * for `verifierGit`, the bounded mutation set for `verifierScratchGit`,
 * the anchored mutation table for `evidenceAnchoredGit`. `useIndexEnv`
 * applies the preflight's claims-rebuilt verifier index — read-table
 * ops only; mutations need the repo's real index (CX-121's env is a
 * read-judgment surface, never a write path). `opts.anchored` hands in
 * a caller-owned preflight: the fingerprint is re-proved once and ANY
 * drift refuses — re-judging the live surface would "heal" into the
 * swapped repo the caller meant to be protected from (CX-169).
 */
async function verifierGitSpawn(
  cwd: string,
  args: string[],
  opts:
    | {
        timeoutMs?: number;
        maxBuffer?: number;
        extraEnv?: Record<string, string>;
        anchored?: EvidencePreflight | null;
        input?: string | Buffer;
      }
    | undefined,
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
  let preflight: EvidencePreflight | null;
  let ownsPreflight = true;
  if (opts?.anchored !== undefined) {
    preflight = opts.anchored;
    ownsPreflight = false;
    // Anchored semantics: the caller proved THIS surface around its
    // earlier reads — a `.git` swap before the mutation is exactly the
    // window the anchor exists to close. Refuse on the first failed
    // reprove; a fresh preflight would only attest the foreign repo. A
    // NULL anchor has nothing left to re-prove either: anchored ops run
    // `useIndexEnv=false`, so the null-preflight refusal below never
    // fires and the spawn would proceed with NO resolution pins —
    // `git add`/`reset` mutating whatever `.git` ambient walk-up finds,
    // CX-169's class on the mutation side (CX-175).
    if (preflight === null) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: no anchored judgment — the repo surface was never proven; refusing the mutation`,
      };
    }
    if (!reproveEvidenceSurface(cwd, preflight)) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: repository surface drifted since the anchored judgment — refusing the mutation`,
      };
    }
  } else {
    preflight = await evidenceRepoPreflight(cwd);
    // Re-prove the fingerprint right before the spawn, and keep re-
    // preflighting while the surface drifts — a session write racing the
    // judgment→spawn window reads as drift and the bounded loop re-judges
    // the live state, shrinking the stale-judgment surface to the reprove
    // itself (CX-134's cached-channel sibling on the per-call path; R13-D1:
    // a one-shot reprove+reflight left a whole second-preflight window for
    // a config flipper — the loop makes the LAST check always immediate
    // before the spawn).
    for (
      let attempt = 0;
      preflight !== null && !reproveEvidenceSurface(cwd, preflight);
      attempt++
    ) {
      // The prior fingerprint's resolution anchors pin the re-preflight's
      // resolves — a commondir/gitfile plant between captures cannot
      // steer re-resolution into a forged common dir (CX-143).
      const priorFp = preflight.fingerprint;
      closeEvidenceIndex(preflight);
      preflight = attempt >= 2 ? null : await evidenceRepoPreflight(cwd, priorFp);
    }
  }
  try {
    // A surface that cannot be enumerated is unverifiable — the read
    // table fails closed (no config judgment exists to trust). The
    // scratch channel keeps null-preflight ops: clone/init legitimately
    // run on non-repo cwds (R13 secondary asymmetry).
    if (preflight === null && useIndexEnv) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: repo surface could not be enumerated — evidence would be unverifiable`,
      };
    }
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
    // A config that exists but could not be captured refuses EVERYTHING
    // — its bytes are live-unjudgeable for drift and the spawn would
    // read them (R13-D). The levers themselves are dead either way: env
    // pins cover the literal keyspace and `GIT_ATTR_SOURCE` starves the
    // pattern class, so this guard is about provability, not exposure.
    if (preflight?.configUnproven !== undefined) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: ${preflight.configUnproven}: git ${args.join(" ")}`,
      };
    }
    // The verifier index is resolved per spawn — fd form carries no path
    // at all (CX-129); the path form re-proves its on-disk bytes before
    // the redirect is trusted. An unproven index (rebuild failed,
    // CX-124, or a rewrite caught just now) refuses index-consulting
    // ops; non-index ops never consult it and proceed — but they still
    // carry `GIT_ATTR_SOURCE` because `log -p`/`show`/`diff` engage
    // attribute-gated drivers without touching the index (R13-D).
    const spawnState = evidenceSpawnState(preflight, useIndexEnv);
    if (spawnState.unproven && isIndexConsultingRead(args)) {
      closeSpawnFds(spawnState);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: index unproven (${preflight?.indexUnproven ?? "index bytes rewritten"}): git ${args.join(" ")}`,
      };
    }
    const r = await spawnCaptured(resolveGitBin(), evidenceSpawnArgs(args), {
      cwd,
      env: {
        ...verifierGitEnv(),
        // Pins ride the env, not argv — the spawned argv is the judged
        // query verbatim so positional argv contracts (subcommand at
        // $1) hold for failure-injection seams.
        ...evidencePinEnv(args, preflight),
        // The verifier-owned claims index + `GIT_ATTR_SOURCE` — the
        // session's `.git/index` is never consulted, and no attribute
        // ever engages a config-named program (CX-121/CX-129, R13-D).
        ...spawnState.env,
        ...filterEvidenceExtraEnv(opts?.extraEnv),
      },
      timeoutMs: opts?.timeoutMs ?? 60_000,
      maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024,
      indexFd: spawnState.indexFd,
      input: opts?.input,
    });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } finally {
    // The per-call preflight owns its held fds — a cached or anchored
    // preflight outlives this spawn and stays open for its owner.
    if (ownsPreflight) closeEvidenceIndex(preflight);
  }
}

/**
 * `diff.external` is the one lever env cannot neutralize — git execs the
 * config value as a program, and an EMPTY pinned value execs "" (both
 * 128/forged). Presence in the judged config already refuses
 * (EVIDENCE_CONFIG_REFUSE), but a rewrite landing in the residual
 * reprove→spawn window would still arm it — so the trusted body injects
 * `--no-ext-diff` into every diff-producing query (`diff`/`log`/`show`;
 * `rev-list` never emits patches on this surface). The flag lands before
 * a `--` pathspec separator when one exists, else appended — leading
 * argv positions stay byte-identical for the $1/$2 injection seams
 * (CX-115). Ambient `GIT_EXTERNAL_DIFF` is already dropped by
 * verifierSpawnEnv's allowlist.
 */
const EXT_DIFF_SUBCOMMANDS = new Set(["diff", "log", "show"]);
function withNoExtDiff(args: readonly string[]): string[] {
  if (!EXT_DIFF_SUBCOMMANDS.has(args[0] ?? "")) return [...args];
  const dd = args.indexOf("--");
  if (dd === -1) return [...args, "--no-ext-diff"];
  return [...args.slice(0, dd), "--no-ext-diff", ...args.slice(dd)];
}

/**
 * `ls-files` exclude-rule flags — `--exclude-standard` reads
 * `.gitignore`/`info/exclude`/`core.excludesFile`, all session-
 * authored surfaces (CX-142): a planted `*` rule makes an untracked
 * payload invisible to the enumeration. A trusted enumeration must
 * answer EVERY untracked file, so the flags are stripped from the
 * spawned argv — the judged argv keeps them verbatim (the strip is a
 * strict widening, never a narrowing).
 */
const LS_FILES_EXCLUDE_FLAGS = new Set([
  "--exclude-standard",
  "--no-exclude-standard",
  "--ignored",
]);
const LS_FILES_EXCLUDE_PREFIXES = ["--exclude=", "--exclude-from=", "--exclude-per-directory="];

/**
 * Spawn-argv transform applied AFTER argv judgment on every trusted
 * spawn — the judged caller argv stays verbatim while the spawned body
 * gains honesty flags no config/env pin can express (CX-141/CX-142):
 *
 * - `diff`/`log`/`show` gain `--no-ext-diff` (the `diff.external`
 *   lever execs even an empty value; presence is REFUSE'd but argv is
 *   the only airtight neutralizer).
 * - `status` gains `--ignored` — hidden-by-`.gitignore` files surface
 *   as `!!` entries instead of disappearing (CX-142). Callers that
 *   treat ignored files as non-dirt filter `!!` themselves; a session-
 *   authored `.gitignore` is always dirt via the fs cross-check.
 * - `ls-files` drops exclude-rule flags before `--` — a trusted
 *   enumeration answers every untracked file (CX-142).
 * - `grep --untracked`/`--no-index` gains `--no-exclude-standard` —
 *   git greps apply exclude rules to untracked files otherwise.
 */
export function evidenceSpawnArgs(args: readonly string[]): string[] {
  const base = withNoExtDiff(args);
  const op = base[0] ?? "";
  const dd = base.indexOf("--");
  let head = dd === -1 ? base : base.slice(0, dd);
  const tail = dd === -1 ? [] : base.slice(dd);
  if (op === "status") {
    if (!head.some((a) => a === "--ignored" || a.startsWith("--ignored="))) {
      head = [...head, "--ignored"];
    }
  } else if (op === "ls-files") {
    head = head.filter(
      (a) =>
        !LS_FILES_EXCLUDE_FLAGS.has(a) && !LS_FILES_EXCLUDE_PREFIXES.some((p) => a.startsWith(p)),
    );
  } else if (op === "grep" && (head.includes("--untracked") || head.includes("--no-index"))) {
    if (!head.includes("--no-exclude-standard")) head = [...head, "--no-exclude-standard"];
  }
  return [...head, ...tail];
}

/**
 * `.gitignore` files present in the worktree that no commit owns —
 * session-authored ignore rules. A worktree `.gitignore` can hide
 * itself AND every sibling path it matches from `status`/`ls-files`
 * (CX-142): a session plants `*` and dirty content, and the trusted
 * enumeration answers clean. `--ignored` exposes the hidden entries
 * as `!!` lines, but the ONLY way to prove an ignore rule is
 * session-authored rather than committed policy is a filesystem walk
 * plus a tracked-set check — git's own enumeration is the channel
 * under attack. The walk is anchored at the worktree TOPLEVEL resolved
 * through the judged channel, never the caller's cwd: a rule one level
 * up still applies to a subdirectory cwd, and a cwd-scoped walk would
 * never see it (CX-167). Returned paths are toplevel-relative.
 *
 * Returns every `.gitignore` path NOT in the tracked set; when
 * `tracked` cannot answer (failed ls-files), every found rule counts
 * as session-authored — fail closed, never silently clean. `tracked`
 * maps the found paths to the subset git knows (its index claims) —
 * `null` on a failed read — and receives the resolved root so its
 * pathspec queries anchor where the relative names are true. `null`
 * return marks the toplevel itself unresolvable (refused channel,
 * bare/non-worktree cwd) — an unverifiable rule set, never "no rules".
 */
export async function sessionIgnoreRulePaths(
  worktree: string,
  tracked: (paths: string[], root: string) => Promise<Set<string> | null>,
): Promise<string[] | null> {
  const top = await verifierGit(worktree, ["rev-parse", "--show-toplevel"]);
  const root = top.exitCode === 0 ? top.stdout.trim() : "";
  if (root.length === 0) return null;
  const found: string[] = [];
  for (const stack = [""]; stack.length > 0;) {
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const er = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        // `.git` never carries worktree content (a linked-worktree
        // `.git` is a FILE, which this branch skips anyway).
        if (e.name !== ".git") stack.push(er);
      } else if (e.name === ".gitignore") {
        found.push(er);
      }
    }
  }
  if (found.length === 0) return [];
  const trackedSet = await tracked(found, root);
  return trackedSet === null ? found : found.filter((p) => !trackedSet.has(p));
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
  opts?: {
    timeoutMs?: number;
    maxBuffer?: number;
    extraEnv?: Record<string, string>;
    /**
     * A caller-owned preflight to anchor this read to — reused so a
     * read→mutation sequence judges ONE proven surface; drift against
     * it refuses rather than re-judging a swapped repo (CX-169).
     */
    preflight?: EvidencePreflight | null;
    /** Optional bytes piped to the child's stdin (`check-ignore --stdin`). */
    input?: string | Buffer;
  },
): Promise<VerifierGitResult> {
  return verifierGitSpawn(
    cwd,
    args,
    { ...opts, anchored: opts?.preflight },
    isVerifierGitQuery,
    "verifier read table",
    true,
  );
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

/**
 * Mutating ops forge may run on a repo it just judged — narrower than
 * the scratch table (no clone/init/config writes): the only anchored
 * uses are staging and un-staging path lists (`add -A --`,
 * `reset -q --`). Everything outside the table is a caller bug, not a
 * use case (CX-169/CX-170).
 */
const ANCHORED_MUTATION_OPS: Readonly<Record<string, readonly string[]>> = {
  // `-N`/`--intent-to-add` records a zero-blob placeholder — staged
  // content claims must be real objects. `-f`/`--force` force-stages
  // ignore-hidden paths. `--pathspec-from-(file|stdin)` reads the path
  // set from a session file. `-p`/`-i`/`-e` open interactive loops on a
  // no-tty spawn. `--chmod` rewrites entry modes.
  add: [
    "-N",
    "--intent-to-add",
    "-f",
    "--force",
    "--pathspec-from-file",
    "--pathspec-file-nul",
    "--pathspec-from-stdin",
    "-p",
    "--patch",
    "-i",
    "--interactive",
    "-e",
    "--edit",
    "--chmod",
  ],
  // `--hard`/`--soft`/`--merge`/`--keep` move HEAD or clobber worktree
  // bytes — the only anchored use is `reset -q -- <paths>` un-staging.
  reset: [
    "--hard",
    "--soft",
    "--merge",
    "--keep",
    "--pathspec-from-file",
    "--pathspec-file-nul",
    "--pathspec-from-stdin",
  ],
};

/**
 * Runtime argv judgment for the anchored-mutation channel — only the
 * ops above, and never a ref-store handle (`@{…}` is a fabrication
 * channel in every position).
 */
export function isAnchoredMutationQuery(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args.some((a) => a.includes("@{"))) return false;
  const forbid = ANCHORED_MUTATION_OPS[args[0]!];
  if (forbid === undefined) return false;
  return !args.slice(1).some((a) => isForbiddenEvidenceArg(a, forbid));
}

/**
 * A trusted mutation anchored to a caller-captured preflight: forge
 * writes into the repo it just proved — `pinnedGitAdd`, archive
 * move-staging, the lockfile un-stage (CX-169/CX-170). The anchored
 * fingerprint is re-proved immediately before the spawn and drift
 * refuses outright: an ambient `git add` between a judged read and the
 * mutation would follow a swapped `.git` indirection into a foreign
 * index, while a fresh preflight would happily attest THAT repo
 * (CX-169). The spawn still carries the full evidence env — resolved
 * binary, scrubbed env, resolution pins, `GIT_ATTR_SOURCE` starvation
 * — so `info/attributes` `filter.*` drivers never rewrite staged bytes
 * (they refuse the channel anyway via shapeViolations). `opts.preflight`
 * is required: `null` means the caller's own preflight found nothing
 * provable, and the op fails closed downstream the same way a missing
 * repo does.
 */
export async function evidenceAnchoredGit(
  cwd: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    maxBuffer?: number;
    extraEnv?: Record<string, string>;
    preflight: EvidencePreflight | null;
  },
): Promise<VerifierGitResult> {
  return verifierGitSpawn(
    cwd,
    args,
    {
      timeoutMs: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
      extraEnv: opts.extraEnv,
      anchored: opts.preflight,
    },
    isAnchoredMutationQuery,
    "anchored mutation table",
    false,
  );
}
