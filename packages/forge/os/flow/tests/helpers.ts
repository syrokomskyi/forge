/*
<MODULE_CONTRACT>
<purpose>Throwaway-repository scaffolding for os/flow tests (RFC-1486): every
git command runs inside a fresh repo under the OS temp dir — never against the
enclosing workspace — and the guard hook is installed exactly the way
flow.install does it (committed hooks dir + core.hooksPath).</purpose>
<non-goals>
  <item>No production code — test scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Hooks live in &lt;repo&gt;/hooks (committed), never .git/hooks — worktrees check out committed content (AUDIT-RFC-1486-G1).</item>
  <item>FORGE_FLOW_OP is always set explicitly ("" for the unset cases) so a leaked outer value cannot make tests non-deterministic.</item>
  <item>Fixtures exclude docs/.index/ via a self-ignoring root .gitignore — the kernel counters journal regenerates it on every rule evaluation, and unignored it rides the flow.open sweep into branch trees and collides merges. `.git/info/exclude` cannot carry the patterns: CX-141 made effective content there refuse the evidence channel outright.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1603: key the artifact cache on the copied tree and end mission.close with a converging tail sync</item>
  <item>RFC-1603: record the sweep/journal collision friction and the fixture-ignore decision</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
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
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
  <history>RFC-1486, RFC-1490, RFC-1491, RFC-1502, RFC-1580, RFC-1606</history>
</CHANGE_SUMMARY>
*/

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import type { ExecResult } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  GUARD_BEGIN_MARKER,
  GUARD_END_MARKER,
  MANAGED_BLOCK,
  managedBlock,
  resolveGuardAssetPath,
} from "../guard-files.ts";

const PREMERGE_MANAGED_BLOCK = managedBlock("pre-merge-commit");
const PREPUSH_MANAGED_BLOCK = managedBlock("pre-push");

export { GUARD_BEGIN_MARKER, GUARD_END_MARKER, MANAGED_BLOCK };

/** Absolute path of the shipped guard asset — resolved on first use. */
export const GUARD_ASSET = resolveGuardAssetPath();

export function gitExec(
  repo: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ExecResult> {
  return ambientIo.exec("git", ["-C", repo, ...args], { env });
}

// ---------------------------------------------------------------------------
// Loopback `git daemon` for fixture remotes — the trusted evidence channel
// pins `protocol.file.allow=never` on `ls-remote`/`fetch` (CX-131: a session
// authors everything a file:/path transport returns), so any fixture that
// needs REAL remote evidence serves its bare origin over loopback git://.
// `origin` stays the on-disk path for direct bare-repo manipulation.
// ---------------------------------------------------------------------------

const daemons: ChildProcess[] = [];
afterEach(() => {
  for (const d of daemons.splice(0)) d.kill();
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function waitForPort(port: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      s.once("connect", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Spawn `git daemon` serving `basePath` on a free loopback port (push
 * enabled — fixture remotes must accept `git push`). Returns the port;
 * the process is killed by the suite's afterEach.
 */
export async function serveGitDaemon(basePath: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const d = spawn(
      "git",
      [
        "daemon",
        "--export-all",
        "--reuseaddr",
        "--enable=receive-pack",
        `--base-path=${basePath}`,
        "--listen=127.0.0.1",
        `--port=${port}`,
      ],
      { stdio: "ignore" },
    );
    if (await waitForPort(port)) {
      daemons.push(d);
      return port;
    }
    d.kill();
  }
  throw new Error(`git daemon failed to start under ${basePath}`);
}

/**
 * Register `name` in `repo` as a remote serving `bareDir` over loopback
 * git:// — the trusted channel denies file:/path remotes (CX-131), so
 * fixtures needing real remote evidence use this instead of a path remote.
 * Returns the git:// URL (for forge.yaml expectedRemote declarations).
 */
export async function remoteAddGitDaemon(
  repo: string,
  bareDir: string,
  name = "origin",
): Promise<string> {
  const base = join(bareDir, "..");
  const port = await serveGitDaemon(base);
  const url = `git://127.0.0.1:${port}/${bareDir.split("/").pop()}`;
  await gitExec(repo, ["remote", "add", name, url]);
  return url;
}

/**
 * `git init` in a fresh temp dir with deterministic local config (no global
 * git config may leak in). `seedCommit` creates a root commit — skipped for
 * unborn-HEAD cases.
 */
/**
 * RFC-1580: flow.integrate spawns `<primary>/node_modules/.bin/forge
 * correctness.gate` and refuses FLOW-INT-18 when it is missing. Test
 * primaries get a stand-in that answers a passing gate (or the verdict in
 * `<primary>/.correctness-gate.json` when a test drops one there). The path
 * is excluded via a self-ignoring root .gitignore so it never reads as
 * primary dirt — `.git/info/exclude` would refuse the evidence channel
 * outright (CX-141: effective content there can hide untracked state).
 */
export async function installFakePrimaryForge(repo: string): Promise<void> {
  const bin = join(repo, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "forge");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "correctness.gate" ]; then',
      '  primary="$(dirname "$(dirname "$(dirname "$0")")")"',
      '  if [ -f "$primary/.correctness-gate.json" ]; then cat "$primary/.correctness-gate.json"; exit "$(cat "$primary/.correctness-gate.exit" 2>/dev/null || echo 0)"; fi',
      '  echo \'{"command":"correctness.gate","mode":"warn","status":"pass","bundlePath":null,"violations":[],"weakenings":[],"acceptedWeakening":null}\'',
      "  exit 0",
      "fi",
      'echo "fake forge: unsupported $*" >&2',
      "exit 64",
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  // docs/.index/ mirrors the real repo's .gitignore (line ~360): the kernel
  // counters journal appends docs/.index/checks/counters.jsonl on every
  // rule-evaluating command — unignored, the flow.open sweep stages it into
  // the branch tree and the next journal append collides the integrate
  // merge. The file must cover itself too: `info/exclude` is a refused
  // evidence surface (CX-141), and an unignored root .gitignore would
  // itself read as untracked dirt — a `/.gitignore` self-line keeps the
  // whole ignore set invisible to both ambient and evidence status.
  await writeFile(
    join(repo, ".gitignore"),
    "/.gitignore\nnode_modules/\n.correctness-gate.json\n.correctness-gate.exit\ndocs/.index/\n",
  );
}

/**
 * RFC-1606: point the primary's `node_modules/.bin/forge` at a real forge CLI
 * (this checkout's own `bin/cli.ts`) — for tests that must run the genuine
 * command rather than the passing stand-in. Overwrites the stand-in
 * `installFakePrimaryForge` planted; the self-ignoring `.gitignore` already
 * covers the path.
 * NODE_OPTIONS is scrubbed: vitest registers its ESM loader there, and a
 * bare `node` child resolving it outside the workspace exits 1 before
 * printing anything — the "no JSON result" flake (F-0278's env half).
 */
export async function installRealPrimaryForge(repo: string, cliPath: string): Promise<void> {
  const bin = join(repo, "node_modules", ".bin", "forge");
  await writeFile(
    bin,
    `#!/bin/sh\nexec env -u NODE_OPTIONS node ${JSON.stringify(cliPath)} "$@"\n`,
  );
  await chmod(bin, 0o755);
}

export async function initRepo(opts?: {
  branch?: string;
  seedCommit?: boolean;
  prefix?: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), opts?.prefix ?? "flow-test-"));
  const init = await gitExec(dir, ["init", "-b", opts?.branch ?? "main"]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  await gitExec(dir, ["config", "user.email", "flow-test@example.invalid"]);
  await gitExec(dir, ["config", "user.name", "flow-test"]);
  await gitExec(dir, ["config", "commit.gpgsign", "false"]);
  await installFakePrimaryForge(dir);
  if (opts?.seedCommit !== false) {
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await gitExec(dir, ["add", "seed.txt"]);
    const seed = await gitExec(dir, ["commit", "-m", "seed"]);
    if (seed.exitCode !== 0) throw new Error(`seed commit failed: ${seed.stderr}`);
  }
  return dir;
}

/**
 * Install the guard the way flow.install does it: hooks/flow-guard.sh byte
 * copy of the asset, hooks/pre-commit carrying the managed block right after
 * the shebang, core.hooksPath pointing at the committed dir.
 */
export async function installGuard(repo: string): Promise<void> {
  const hooksDir = join(repo, "hooks");
  await mkdir(hooksDir, { recursive: true });
  await copyFile(resolveGuardAssetPath(), join(hooksDir, "flow-guard.sh"));
  await writeFile(join(hooksDir, "pre-commit"), `#!/bin/sh\n${MANAGED_BLOCK}`);
  await writeFile(join(hooksDir, "pre-merge-commit"), `#!/bin/sh\n${PREMERGE_MANAGED_BLOCK}`);
  await writeFile(join(hooksDir, "pre-push"), `#!/bin/sh\n${PREPUSH_MANAGED_BLOCK}`);
  await chmod(join(hooksDir, "flow-guard.sh"), 0o755);
  await chmod(join(hooksDir, "pre-commit"), 0o755);
  await chmod(join(hooksDir, "pre-merge-commit"), 0o755);
  await chmod(join(hooksDir, "pre-push"), 0o755);
  const hooksPath = await gitExec(repo, ["config", "core.hooksPath", "hooks"]);
  if (hooksPath.exitCode !== 0) {
    throw new Error(`core.hooksPath failed: ${hooksPath.stderr}`);
  }
}

/** Attempt a commit; env overrides merge over process.env (set "" to neutralize). */
export function tryCommit(repo: string, env?: Record<string, string>): Promise<ExecResult> {
  return gitExec(repo, ["commit", "--allow-empty", "-m", "probe"], env);
}

/** Invoke the installed guard directly with HEAD on the current branch. */
export function runGuardDirect(repo: string, env?: Record<string, string>): Promise<ExecResult> {
  return ambientIo.exec("sh", [join(repo, "hooks", "flow-guard.sh"), "pre-commit"], {
    cwd: repo,
    env,
  });
}

/**
 * Governed repo (forge.yaml + develop) wired to a fresh bare origin, both
 * branches fully pushed — the RFC-1491 fixture shape (digest/push/hold).
 * The repo lives inside its own parent dir so extract destinations anchored
 * at dirname(primary) stay per-test isolated.
 */
export async function initRepoWithOrigin(
  dirs: string[],
  opts?: { prefix?: string; fakeExtract?: boolean },
): Promise<{
  repo: string;
  origin: string;
  originUrl: string;
  extractLog: string;
  parent: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), opts?.prefix ?? "flow-origin-"));
  dirs.push(parent);
  const repo = join(parent, "repo");
  const origin = join(parent, "origin.git");
  const extractLog = join(parent, "extract.log");

  await mkdir(repo, { recursive: true });
  const init = await gitExec(repo, ["init", "-b", "main"]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  await gitExec(repo, ["config", "user.email", "flow-test@example.invalid"]);
  await gitExec(repo, ["config", "user.name", "flow-test"]);
  await gitExec(repo, ["config", "commit.gpgsign", "false"]);
  const bare = await gitExec(parent, ["init", "--bare", "-b", "develop", "origin.git"]);
  if (bare.exitCode !== 0) throw new Error(`bare init failed: ${bare.stderr}`);
  // A path remote is session-servable — the trusted channel's
  // protocol.file.allow=never pin denies it honestly (CX-131). Serve the
  // fixture origin over loopback git:// so digest fetch/ls-remote keep
  // real remote evidence; `origin` stays the bare path for direct ops.
  const originUrl = `git://127.0.0.1:${await serveGitDaemon(parent)}/origin.git`;
  await writeFile(
    join(repo, "forge.yaml"),
    `schema: "forge/workspace@1"\npush:\n  expectedRemote: ${JSON.stringify(originUrl)}\n`,
  );
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await gitExec(repo, ["add", "-A"]);
  const seed = await gitExec(repo, ["commit", "-m", "seed"]);
  if (seed.exitCode !== 0) throw new Error(`seed commit failed: ${seed.stderr}`);
  await gitExec(repo, ["branch", "develop", "HEAD"]);

  await gitExec(repo, ["remote", "add", "origin", originUrl]);
  await gitExec(repo, ["switch", "develop"]);
  const push = await gitExec(repo, ["push", "-u", "origin", "develop", "main"]);
  if (push.exitCode !== 0) throw new Error(`initial push failed: ${push.stderr}`);

  await installFakePrimaryForge(repo);
  if (opts?.fakeExtract) await installFakeRepoExtract(repo, extractLog);
  return { repo, origin, originUrl, extractLog, parent };
}

/**
 * A fake `<repo>/node_modules/.bin/repo-extract`: logs argv to `log`, then
 * materializes the destination exactly like resolveExtractDest does — a
 * git repo at <parent>/<destBase|packages>/<destName> with one export
 * commit and a bare `origin` at <parent>/extract-origins/<destName>.git.
 * A `--dest <dir>` argument overrides the computed destination (RFC-1502's
 * pre-tag verify extracts into a scratch). Set FAKE_EXTRACT_FAIL=1 in its
 * env — or drop a `.fail-extract` marker in the caller's cwd — to make it
 * exit 3 (FLOW-PUSH-05 / FLOW-CUT-13 tests).
 */
export async function installFakeRepoExtract(repo: string, log: string): Promise<string> {
  const bin = join(repo, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "repo-extract");
  await writeFile(
    script,
    `#!/bin/sh
set -eu
echo "$@" >> ${JSON.stringify(log)}
if [ "\${FAKE_EXTRACT_FAIL:-0}" = "1" ] || [ -f "$PWD/.fail-extract" ]; then
  echo "fake extract failure" >&2
  exit 3
fi
cfg=""; ref=""; destOverride=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) cfg="$2"; shift 2 ;;
    --ref) ref="$2"; shift 2 ;;
    --dest) destOverride="$2"; shift 2 ;;
    *) shift ;;
  esac
done
lineDir=$(dirname "$cfg")
destName=$(grep '^destName:' "$lineDir/extract.config.yaml" | sed 's/^destName: *//' | tr -d ' ')
destBase=$(grep '^destBase:' "$lineDir/extract.config.yaml" | sed 's/^destBase: *//' | tr -d ' ')
destBase=\${destBase:-packages}
dest="\${destOverride:-$(dirname "$PWD")/$destBase/$destName}"
mkdir -p "$dest"
if [ ! -d "$dest/.git" ]; then git -C "$dest" init -b main >/dev/null; fi
# A CI runner has no global git identity; publish's reconcile merge commits
# in the destination, so the destination carries its own.
git -C "$dest" config user.email t@t
git -C "$dest" config user.name t
echo "export $ref" > "$dest/export.txt"
git -C "$dest" add export.txt
git -C "$dest" -c user.email=t@t -c user.name=t commit -q -m "export $ref"
dorigin="$(dirname "$PWD")/extract-origins/$destName.git"
mkdir -p "$(dirname "$dorigin")"
if [ ! -f "$dorigin/HEAD" ]; then git init --bare -b main "$dorigin" >/dev/null; fi
git -C "$dest" remote remove origin 2>/dev/null || true
git -C "$dest" remote add origin "$dorigin"
`,
  );
  await chmod(script, 0o755);
  return script;
}

/** Switch to a branch, creating it when it does not exist yet. */
export async function checkoutOrCreate(repo: string, name: string): Promise<void> {
  const exists = (await gitExec(repo, ["branch", "--list", name])).stdout.trim().length > 0;
  const result = exists
    ? await gitExec(repo, ["switch", name])
    : await gitExec(repo, ["switch", "-c", name]);
  if (result.exitCode !== 0) {
    throw new Error(`switch to ${name} failed: ${result.stderr}`);
  }
}
