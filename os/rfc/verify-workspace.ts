/*
<MODULE_CONTRACT>
<purpose>
RFC-1333: rfc.verify.workspace — export a committed candidate as a plain tree
(no git metadata) for a clean-context acceptance verifier, stripped of the
implementer's in-range tests and of the RFC's plan, review, session, and queue
documents, with a VERIFY-BUNDLE.md carrying only the RFC's normative prose.
</purpose>
<non-goals>
  <item>Do not run the verifier — the fo-review acceptance mode does.</item>
  <item>Do not write inside the repository — the export lives under the OS temp dir.</item>
  <item>Do not hide anything cryptographically — the verifier is pointed at the export; isolation is recorded, not enforced.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>git archive piped into tar, never a worktree: a worktree shares the object database.</item>
  <item>A test file touched in range by any commit without the verifier trailer pair is stripped.</item>
  <item>node_modules (root included) are mirrored entry by entry with workspace links rewritten into the export.</item>
  <item>The candidate resolves to a full commit sha once; a failed export removes its partial tree.</item>
  <item>Directory links are junctions on Windows; path checks use forward slashes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1333: initial implementation — git-free export, self-test and RFC-document stripping, VERIFY-BUNDLE.md.</item>
  <item>RFC-1333: review hardening — piped export, root node_modules mirroring, failure cleanup, sha resolution, Windows links.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { execFile } from "../../src/utils/sync-fs.ts";
import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "./frontmatter-io.ts";
import { RFC_DIR } from "./types.ts";
import {
  createOriginGit,
  gitEnvForCwd,
  hasVerifierTrailers,
  resolveImplementationRange,
  type OriginGit,
} from "./verification-origin.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export interface RfcVerifyWorkspaceResult {
  command: "rfc.verify.workspace";
  status: "pass" | "fail";
  rfcId: string;
  candidateSha: string;
  path: string | null;
  removed: string[];
  error?: string;
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const DOC_DIRS = ["docs/plans/", "docs/reviews/", "docs/sessions/", "docs/queues/"];
const BUNDLE_SECTIONS = ["Context", "Problem", "Decision", "Design", "Acceptance criteria"];

const EXPORT_TIMEOUT_MS = 300_000;

const toPosix = (p: string): string => p.split(sep).join("/");

function run(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: 120000, maxBuffer: 64 * 1024 * 1024, env: gitEnvForCwd() },
      (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** Test files touched in base..head by at least one commit without the verifier trailer pair. */
export async function listSelfTestFiles(
  git: OriginGit,
  base: string,
  head: string,
): Promise<string[]> {
  const out = await git.run([
    "log",
    "--first-parent",
    "-m",
    "--format=%x1e%H%x1f%B%x1f",
    "--name-only",
    `${base}..${head}`,
  ]);
  if (!out) return [];
  const self = new Set<string>();
  for (const chunk of out.split("\x1e")) {
    const [, body = "", files = ""] = chunk.split("\x1f");
    if (hasVerifierTrailers(body)) continue;
    for (const f of files.split("\n").map((l) => l.trim())) if (TEST_FILE_RE.test(f)) self.add(f);
  }
  return [...self].sort();
}

/** Keep only the normative sections of the RFC body. */
export function extractBundleSections(body: string): string {
  return body
    .split(/^(?=## )/m)
    .filter((p) => BUNDLE_SECTIONS.some((h) => new RegExp(`^## ${h}\\r?\\n`).test(p)))
    .join("\n")
    .trim();
}

/** Directory links use junctions on Windows (no Developer Mode needed). */
async function linkPath(target: string, dst: string): Promise<void> {
  const isDir = (await lstat(target).catch(() => null))?.isDirectory() ?? true;
  const type = isDir ? (process.platform === "win32" ? "junction" : "dir") : "file";
  await symlink(target, dst, type);
}

/**
 * Mirror `<pkg>/node_modules` (root included) entry by entry. A link that
 * resolves inside the repository but outside any node_modules is a workspace
 * link and is rewritten into the export, so siblings run at the candidate.
 */
async function mirrorNodeModules(mainRoot: string, outRoot: string, pkgRel: string): Promise<void> {
  const srcDir = join(mainRoot, pkgRel, "node_modules");
  const dstDir = join(outRoot, pkgRel, "node_modules");
  if (!existsSync(srcDir) || existsSync(dstDir)) return;
  await mkdir(dstDir, { recursive: true });
  const link = async (rel: string): Promise<void> => {
    const src = join(srcDir, rel);
    let target = src;
    if ((await lstat(src)).isSymbolicLink()) {
      const resolved = resolve(dirname(src), await readlink(src));
      const inRepo = toPosix(relative(mainRoot, resolved));
      const workspaceLink =
        !inRepo.startsWith("..") &&
        inRepo !== "node_modules" &&
        !inRepo.startsWith("node_modules/") &&
        !inRepo.includes("/node_modules/");
      target = workspaceLink ? join(outRoot, inRepo) : resolved;
    }
    await mkdir(dirname(join(dstDir, rel)), { recursive: true });
    await linkPath(target, join(dstDir, rel));
  };
  for (const name of await readdir(srcDir)) {
    if (name.startsWith("@")) {
      for (const sub of await readdir(join(srcDir, name))) await link(join(name, sub));
    } else {
      await link(name);
    }
  }
}

/** `git archive <sha> | tar -x` through pipes — no temp tarball, no drive-letter paths. */
function exportTree(workspaceRoot: string, sha: string, out: string): Promise<string | null> {
  const exitOf = (child: ReturnType<typeof spawn>): Promise<number | null> =>
    new Promise((r) => {
      child.on("error", () => r(-1));
      child.on("close", (code) => r(code));
    });
  const archive = spawn("git", ["archive", "--format=tar", sha], {
    cwd: workspaceRoot,
    env: gitEnvForCwd(),
  });
  const tar = spawn("tar", ["-x", "-f", "-"], { cwd: out });
  let err = "";
  archive.stderr?.on("data", (d) => (err += String(d)));
  tar.stderr?.on("data", (d) => (err += String(d)));
  // An early tar exit must surface as a failed export, not an uncaught EPIPE.
  tar.stdin?.on("error", () => {});
  archive.stdout?.on("error", () => {});
  archive.stdout?.pipe(tar.stdin!);
  tar.on("close", (code) => {
    if (code !== 0) archive.kill();
  });
  const timer = setTimeout(() => {
    err += `export timed out after ${EXPORT_TIMEOUT_MS} ms`;
    archive.kill();
    tar.kill();
  }, EXPORT_TIMEOUT_MS);
  // Both processes must exit before the verdict — tar can close first.
  return Promise.all([exitOf(archive), exitOf(tar)]).then(([g, t]) => {
    clearTimeout(timer);
    return g === 0 && t === 0 ? null : err.trim() || `export failed (git ${g}, tar ${t})`;
  });
}

export async function buildVerifyWorkspace(opts: {
  workspaceRoot: string;
  rfcId: string;
  candidateSha: string;
  outDir?: string;
}): Promise<RfcVerifyWorkspaceResult> {
  const { workspaceRoot, rfcId } = opts;
  // Resolve once to a full commit sha: a moving branch name must not shift the binding.
  const resolved = (
    await run(workspaceRoot, "git", ["rev-parse", "--verify", `${opts.candidateSha}^{commit}`])
  ).stdout.trim();
  const candidateSha = resolved || opts.candidateSha;
  const fail = (error: string): RfcVerifyWorkspaceResult => ({
    command: "rfc.verify.workspace",
    status: "fail",
    rfcId,
    candidateSha,
    path: null,
    removed: [],
    error,
  });
  if (!resolved) return fail(`candidate ${opts.candidateSha} is not a commit`);

  const rfcDir = join(workspaceRoot, RFC_DIR);
  const fileName = (await listRfcFiles(rfcDir)).find((f) => rfcFileMatchesId(f, rfcId));
  if (!fileName) return fail(`${rfcId} not found`);
  const parsed = await readAndParseRfc(rfcDir, fileName);
  if (!parsed || "error" in parsed) return fail(`${rfcId} unparseable`);

  const git = createOriginGit(workspaceRoot);
  const rfcRel = toPosix(relative(workspaceRoot, join(rfcDir, fileName)));
  const range = await resolveImplementationRange(git, rfcRel);
  if (!range.base) return fail(`${rfcId} has no status: accepted transition in history`);
  const selfTests = await listSelfTestFiles(git, range.base, candidateSha);

  const selfCreated = opts.outDir === undefined;
  const out = opts.outDir ?? (await mkdtemp(join(tmpdir(), `rfc-verify-${rfcId.toLowerCase()}-`)));
  let result: RfcVerifyWorkspaceResult;
  try {
    await mkdir(out, { recursive: true });
    const exportError = await exportTree(workspaceRoot, candidateSha, out);
    if (exportError) {
      result = fail(`export failed: ${exportError}`);
    } else {
      const removed: string[] = [];
      const drop = async (rel: string): Promise<void> => {
        if (existsSync(join(out, rel))) {
          await rm(join(out, rel), { recursive: true, force: true });
          removed.push(rel);
        }
      };
      for (const f of selfTests) await drop(f);
      const idRe = new RegExp(`\\b${rfcId}\\b`, "i");
      const tracked = (
        await run(workspaceRoot, "git", ["ls-tree", "-r", "--name-only", candidateSha])
      ).stdout.split("\n");
      for (const f of tracked) {
        if (!DOC_DIRS.some((d) => f.startsWith(d))) continue;
        const abs = join(out, f);
        if (existsSync(abs) && (idRe.test(f) || idRe.test(await readFile(abs, "utf8")))) {
          await drop(f);
        }
      }
      const slug = rfcId.toLowerCase();
      await drop(`${RFC_DIR}/verification/${slug}.generated.yaml`);
      await drop(`docs/metrics/rfcs/${slug}.metrics.yaml`);

      await mirrorNodeModules(workspaceRoot, out, ".");
      for (const pj of tracked.filter(
        (f) => f.endsWith("/package.json") && !f.includes("node_modules/"),
      )) {
        await mirrorNodeModules(workspaceRoot, out, dirname(pj));
      }

      await writeFile(
        join(out, "VERIFY-BUNDLE.md"),
        [
          `# Acceptance verification bundle — ${rfcId}`,
          "",
          `Candidate: ${candidateSha}`,
          "",
          "Removed from this tree (exists in the candidate, intentionally hidden):",
          ...removed.map((r) => `- ${r}`),
          "",
          extractBundleSections(parsed.parsed.body),
          "",
        ].join("\n"),
      );
      result = {
        command: "rfc.verify.workspace",
        status: "pass",
        rfcId,
        candidateSha,
        path: out,
        removed,
      };
    }
  } catch (e) {
    result = fail(e instanceof Error ? e.message : String(e));
  }
  // A failed export must not leave a partial tree behind.
  if (result.status === "fail" && selfCreated) await rm(out, { recursive: true, force: true });
  return result;
}

export async function runRfcVerifyWorkspace(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerifyWorkspaceResult>> {
  const rfcId = String(input.flags["id"] ?? "").toUpperCase();
  const candidateSha = String(input.flags["candidate"] ?? "");
  if (!rfcId || !candidateSha) {
    const data: RfcVerifyWorkspaceResult = {
      command: "rfc.verify.workspace",
      status: "fail",
      rfcId,
      candidateSha,
      path: null,
      removed: [],
      error: "--id and --candidate are required",
    };
    return {
      data,
      exitCode: 1,
      summary: "rfc.verify.workspace: --id and --candidate are required",
    };
  }
  const data = await buildVerifyWorkspace({
    workspaceRoot: context.workspaceRoot,
    rfcId,
    candidateSha,
  });
  return {
    data,
    exitCode: data.status === "pass" ? 0 : 1,
    summary:
      data.status === "pass"
        ? `rfc.verify.workspace: ${rfcId} at ${candidateSha.slice(0, 9)} → ${data.path} (${data.removed.length} path(s) hidden)`
        : `rfc.verify.workspace: ${data.error}`,
  };
}
