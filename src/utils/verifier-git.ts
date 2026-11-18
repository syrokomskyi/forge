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
  <item>RFC-1616: initial verifier-git primitives — env scrub, execFile wrapper, trusted git resolution.</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
</CHANGE_SUMMARY>
*/

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return env;
}

const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";

let evidenceHooksDirPath: string | undefined;
/**
 * The `core.hooksPath` pin target — a real empty dir under the OS temp
 * root so a repo-config `core.hooksPath` resolves to nothing hookable.
 * `-c` DOES reach the hook resolver (callback-scope config), unlike the
 * transport levers, so pinning works where detection alone would not
 * (CX-74). Created lazily on first evidence spawn.
 */
function evidenceHooksDir(): string {
  if (evidenceHooksDirPath === undefined) {
    const dir = path.join(os.tmpdir(), `forge-evidence-hooks-${process.pid}`);
    mkdirSync(dir, { recursive: true });
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
 * `credential.helper=` is the documented list reset; `diff.external=cat`
 * and `interactive.diffFilter=cat` replace the driver program with a
 * pass-through (an EMPTY value makes git exec "" and fail 128 — the r5
 * verifier caught that dead `git diff`); `extensions.worktreeConfig=false`
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
  "diff.external=cat",
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
  "diff.external",
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
  { key: /^remote\.[^.]+\.(?:proxy|proxyauthmethod|vcs|promisor|partialclonefilter)$/i },
  { key: /^extensions\.(?:partialclone|worktreeconfig)$/i },
  { key: /^credential\..*helper$/i, value: /\S/ },
  { key: /^core\.fsmonitor$/i, value: /^(?!$|true$|false$|yes$|no$|on$|off$|1$|0$)/i },
];

/** The stderr prefix a refused evidence call carries — callers treat it as unverifiable, never as an empty answer. */
export const EVIDENCE_REFUSED_PREFIX = "EVIDENCE-REFUSED";

/** `.git` metadata paths whose presence refuses evidence — resolved via `--git-path` so linked worktrees land on the right common/worktree dir. */
const EVIDENCE_SHAPE_PATHS = ["info/grafts", "objects/info/alternates", "shallow"] as const;

/** Shape paths reported as diagnostics without refusing — they cannot falsify committed-object reads. */
const EVIDENCE_SHAPE_WARN_PATHS = ["info/exclude"] as const;

/**
 * `--git-path` query order for the topology check — refuse paths first,
 * then warn-only. The os/flow driver's literal argv must enumerate these
 * in this exact order for the judge's positional mapping to hold.
 */
export const EVIDENCE_SHAPE_QUERY_PATHS = [
  ...EVIDENCE_SHAPE_PATHS,
  ...EVIDENCE_SHAPE_WARN_PATHS,
] as const;

/**
 * Raw trusted-git spawn without the config preflight — the preflight's own
 * probe channel, and the binary-reachability probe callers use to tell a
 * dead resolved path (fail loud) from an unenumerable repo (fail closed).
 */
export function execEvidenceGit(cwd: string, args: string[]): Promise<VerifierGitResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        resolveGitBin(),
        ["-C", cwd, ...args],
        { cwd, env: verifierGitEnv(), timeout: 30_000 },
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
 */
export function judgeEvidenceRepoSurface(
  repoRoot: string,
  listedStdout: string,
  gitPathsStdout: string | null,
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
  if (gitPathsStdout !== null) {
    const resolved = gitPathsStdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    resolved.forEach((resolvedPath, i) => {
      // `--git-path` answers relative to the queried repo — resolve against
      // repoRoot, never the process cwd, or the file check reads nothing.
      const abs = path.isAbsolute(resolvedPath)
        ? resolvedPath
        : path.resolve(repoRoot, resolvedPath);
      let body = "";
      try {
        body = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      const effective = body.split("\n").some((l) => l.trim().length > 0 && !l.startsWith("#"));
      if (!effective) return;
      const name = EVIDENCE_SHAPE_QUERY_PATHS[i] ?? abs;
      if (i < EVIDENCE_SHAPE_PATHS.length) shapeViolations.push(name);
      else warnedShape.push(name);
    });
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
  const gitPaths = await execEvidenceGit(repoRoot, [
    "rev-parse",
    ...EVIDENCE_SHAPE_QUERY_PATHS.flatMap((p) => ["--git-path", p]),
  ]);
  return judgeEvidenceRepoSurface(
    repoRoot,
    listed.stdout,
    gitPaths.exitCode === 0 ? gitPaths.stdout : null,
  );
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
 * `execFile(<resolved git>, args, {cwd, env: verifierGitEnv()})` returning
 * the same `{exitCode, stdout, stderr}` shape io.exec produces, so boundary
 * call sites swap without contract churn. The executable is the resolved
 * absolute path (CX-52) and `extraEnv` adds caller-owned variables to the
 * scrubbed env — never session-inherited ones. A spawn failure reports
 * exitCode -1 — callers treat non-zero as a failed read, never as an empty
 * answer.
 */
export async function verifierGit(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number; extraEnv?: Record<string, string> },
): Promise<VerifierGitResult> {
  // The session-writable repo surface is judged before the spawn — a
  // transport/exec lever or a topology file git honors makes any answer
  // fabricable, so the call refuses rather than trusting it (CX-72..79).
  // A non-repo cwd (clone/init destinations) has no config to enumerate —
  // the op itself decides whether the path must be a repo.
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
  return new Promise((resolve) => {
    try {
      execFile(
        resolveGitBin(),
        [...evidencePinArgs(args, preflight), ...args],
        {
          cwd,
          env: { ...verifierGitEnv(), ...filterEvidenceExtraEnv(opts?.extraEnv) },
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
