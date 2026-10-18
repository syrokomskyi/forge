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
  <item>git archive export, never a worktree: a worktree shares the object database, so stripped tests would be one git show away.</item>
  <item>A test file touched in range by any commit without the verifier trailer pair is the implementer's and is stripped.</item>
  <item>node_modules are mirrored with workspace links rewritten into the export so sibling packages run at the candidate.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1333: initial implementation.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
</CHANGE_SUMMARY>
*/

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
import { dirname, join, relative, resolve } from "node:path";

import { execFile } from "../../src/utils/sync-fs.ts";
import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "./frontmatter-io.ts";
import { RFC_DIR } from "./types.ts";
import {
  createOriginGit,
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

function run(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
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
  const parts = body.split(/^(?=## )/m);
  return parts
    .filter((p) =>
      BUNDLE_SECTIONS.some((h) => p.startsWith(`## ${h}\n`) || p.startsWith(`## ${h}\r\n`)),
    )
    .join("\n")
    .trim();
}

async function mirrorNodeModules(mainRoot: string, outRoot: string, pkgRel: string): Promise<void> {
  const srcDir = join(mainRoot, pkgRel, "node_modules");
  const dstDir = join(outRoot, pkgRel, "node_modules");
  if (!existsSync(srcDir) || existsSync(dstDir)) return;
  if (pkgRel === "" || pkgRel === ".") {
    await symlink(srcDir, dstDir, "dir");
    return;
  }
  await mkdir(dstDir, { recursive: true });
  const link = async (rel: string): Promise<void> => {
    const src = join(srcDir, rel);
    let target = src;
    if ((await lstat(src)).isSymbolicLink()) {
      const resolved = resolve(dirname(src), await readlink(src));
      const inRepo = relative(mainRoot, resolved);
      target =
        !inRepo.startsWith("..") && inRepo !== "node_modules" && !inRepo.startsWith("node_modules/")
          ? join(outRoot, inRepo)
          : resolved;
    }
    await mkdir(dirname(join(dstDir, rel)), { recursive: true });
    await symlink(target, join(dstDir, rel));
  };
  for (const name of await readdir(srcDir)) {
    if (name.startsWith("@"))
      for (const sub of await readdir(join(srcDir, name))) await link(join(name, sub));
    else await link(name);
  }
}

export async function buildVerifyWorkspace(opts: {
  workspaceRoot: string;
  rfcId: string;
  candidateSha: string;
  outDir?: string;
}): Promise<RfcVerifyWorkspaceResult> {
  const { workspaceRoot, rfcId, candidateSha } = opts;
  const fail = (error: string): RfcVerifyWorkspaceResult => ({
    command: "rfc.verify.workspace",
    status: "fail",
    rfcId,
    candidateSha,
    path: null,
    removed: [],
    error,
  });
  const rfcDir = join(workspaceRoot, RFC_DIR);
  const fileName = (await listRfcFiles(rfcDir)).find((f) => rfcFileMatchesId(f, rfcId));
  if (!fileName) return fail(`${rfcId} not found`);
  const parsed = await readAndParseRfc(rfcDir, fileName);
  if (!parsed || "error" in parsed) return fail(`${rfcId} unparseable`);

  const git = createOriginGit(workspaceRoot);
  const rfcRel = relative(workspaceRoot, join(rfcDir, fileName));
  const range = await resolveImplementationRange(git, rfcRel);
  if (!range.base) return fail(`${rfcId} has no status: accepted transition in history`);
  const selfTests = await listSelfTestFiles(git, range.base, candidateSha);

  const out = opts.outDir ?? (await mkdtemp(join(tmpdir(), `rfc-verify-${rfcId.toLowerCase()}-`)));
  await mkdir(out, { recursive: true });
  const tarPath = `${out}.tar`;
  const archived = await run(workspaceRoot, "git", [
    "archive",
    "--format=tar",
    "-o",
    tarPath,
    candidateSha,
  ]);
  if (!archived.ok) return fail(`git archive failed: ${archived.stderr.trim()}`);
  const extracted = await run(out, "tar", ["-xf", tarPath]);
  await rm(tarPath, { force: true });
  if (!extracted.ok) return fail(`tar extract failed: ${extracted.stderr.trim()}`);

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
    if (existsSync(abs) && (idRe.test(f) || idRe.test(await readFile(abs, "utf8")))) await drop(f);
  }
  const slug = rfcId.toLowerCase();
  await drop(`${RFC_DIR}/verification/${slug}.generated.yaml`);
  await drop(`docs/metrics/rfcs/${slug}.metrics.yaml`);

  if (existsSync(join(workspaceRoot, "node_modules")))
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
  return {
    command: "rfc.verify.workspace",
    status: "pass",
    rfcId,
    candidateSha,
    path: out,
    removed,
  };
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
