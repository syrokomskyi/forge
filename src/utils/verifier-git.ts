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
</CHANGE_SUMMARY>
*/

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * Environment for git subprocesses on the trust boundary. Everything git
 * would inherit from the session — repository redirection (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, alternates),
 * config injection (`GIT_CONFIG_*` url rewrites), transport and exec-path
 * overrides (`GIT_SSH*`, `GIT_EXEC_PATH`), namespaces, ceilings — is dropped
 * wholesale by prefix; `refs/replace` substitution is disabled so committed
 * reads see the object's real tree/message (CX-46..CX-51); the
 * global/system config files are `/dev/null` so session-writable
 * `~/.gitconfig` `url.insteadOf`/`alias`/`filter` entries cannot rewrite
 * what a read resolves; and PATH is rebuilt around the resolved real git so
 * a session shim cannot substitute executable resolution.
 */
export function verifierGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  env["GIT_CONFIG_GLOBAL"] = process.platform === "win32" ? "NUL" : "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = process.platform === "win32" ? "NUL" : "/dev/null";
  env["PATH"] = verifierPath();
  return env;
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
  for (const [k, v] of Object.entries(extra ?? {})) env[k] = v;
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
  /^(?:GIT_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|CDPATH$|IFS$|LD_|DYLD_|PYTHONPATH$|PYTHONSTARTUP$|RUBYLIB$|PERL5LIB$|PERL5OPT$)/;

export function verifierSubprocessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ORACLE_DROP_RE.test(k)) continue;
    env[k] = v;
  }
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  for (const [k, v] of Object.entries(extra ?? {})) env[k] = v;
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
  return new Promise((resolve) => {
    try {
      execFile(
        resolveGitBin(),
        args,
        {
          cwd,
          env: { ...verifierGitEnv(), ...opts?.extraEnv },
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
