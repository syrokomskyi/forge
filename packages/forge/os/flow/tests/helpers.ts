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
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: review r1 — committed-state adoption gate, uncommitted-hook committedness, step-failure trail, idempotency declaration, lazy asset resolution</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1502: steps 1-5 — release-prepare hook, pre-tag extract verification, ordered steps</item>
  <history>RFC-1486</history>
</CHANGE_SUMMARY>
*/

import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export {
  GUARD_BEGIN_MARKER,
  GUARD_END_MARKER,
  MANAGED_BLOCK,
};

/** Absolute path of the shipped guard asset — resolved on first use. */
export const GUARD_ASSET = resolveGuardAssetPath();

export function gitExec(
  repo: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ExecResult> {
  return ambientIo.exec("git", ["-C", repo, ...args], { env });
}

/**
 * `git init` in a fresh temp dir with deterministic local config (no global
 * git config may leak in). `seedCommit` creates a root commit — skipped for
 * unborn-HEAD cases.
 */
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
export function tryCommit(
  repo: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return gitExec(repo, ["commit", "--allow-empty", "-m", "probe"], env);
}

/** Invoke the installed guard directly with HEAD on the current branch. */
export function runGuardDirect(
  repo: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
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
): Promise<{ repo: string; origin: string; extractLog: string; parent: string }> {
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
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await gitExec(repo, ["add", "-A"]);
  const seed = await gitExec(repo, ["commit", "-m", "seed"]);
  if (seed.exitCode !== 0) throw new Error(`seed commit failed: ${seed.stderr}`);
  await gitExec(repo, ["branch", "develop", "HEAD"]);

  const bare = await gitExec(parent, ["init", "--bare", "-b", "develop", "origin.git"]);
  if (bare.exitCode !== 0) throw new Error(`bare init failed: ${bare.stderr}`);
  await gitExec(repo, ["remote", "add", "origin", origin]);
  await gitExec(repo, ["switch", "develop"]);
  const push = await gitExec(repo, ["push", "-u", "origin", "develop", "main"]);
  if (push.exitCode !== 0) throw new Error(`initial push failed: ${push.stderr}`);

  if (opts?.fakeExtract) await installFakeRepoExtract(repo, extractLog);
  return { repo, origin, extractLog, parent };
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
export async function installFakeRepoExtract(
  repo: string,
  log: string,
): Promise<string> {
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
  const exists =
    (await gitExec(repo, ["branch", "--list", name])).stdout.trim().length > 0;
  const result = exists
    ? await gitExec(repo, ["switch", name])
    : await gitExec(repo, ["switch", "-c", name]);
  if (result.exitCode !== 0) {
    throw new Error(`switch to ${name} failed: ${result.stderr}`);
  }
}
