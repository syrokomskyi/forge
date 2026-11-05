/*
<MODULE_CONTRACT>
<purpose>Generated-artifact publication for one release tag (RFC-1491):
repo-extract the package line's extract repo at the tag, run the
extract-verify hook, push the destination once — reconciling with a single
ours-merge only on a non-fast-forward rejection, never force-pushing —
and return the RFC publications[] row for the journal.</purpose>
<non-goals>
  <item>No push orchestration — handlers/flow-push.ts owns preflight and the atomic push.</item>
  <item>No real repo-extract in tests — fixtures install a fake node_modules/.bin/repo-extract.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Destination resolution mirrors the retired publish-forge.mjs (RFC-1499) resolveDest(): destBase/destName parsed from extract.config.yaml, anchored at dirname(primary), destBase default "packages".</item>
  <item>Reconcile only on non-fast-forward (the same regex as the retired publish-forge.mjs, RFC-1499) — auth, hook and transient failures never trigger an ours-merge.</item>
  <item>verifyLineAtRef (RFC-1502) extracts into an mkdtemp scratch via `--dest` — the configured destination is never touched — and a spawn failure of the repo-extract binary reports as a verification failure, not a crash.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1499: step 2 — retire publish-forge/bump-forge scripts, add extract-verify hook</item>
  <item>RFC-1502: steps 1-5 — release-prepare hook, pre-tag extract verification, ordered steps</item>
  <item>RFC-1502: step 7 — remediation entries, docs, deviations, generated indexes</item>
  <item>RFC-1502: review r1 — fix-cut rollback on FLOW-CUT-12/13, populated steps[], hook validation, GIT_* env scrub</item>
  <history>RFC-1491</history>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import { git, gitCommit } from "./git.ts";
import { runFlowScript, type FlowScriptResult } from "./scripts.ts";
import type { ReleaseLine } from "./release-lines.ts";

export interface PublicationRow {
  tag: string;
  line: string;
  status: "published" | "failed" | "skipped-baseline" | "pending";
  dest: string | null;
  verify: FlowScriptResult | null;
  reconciled: boolean;
  destHead: string | null;
  /** FLOW-PUSH-05 detail when status === "failed". */
  error?: string;
}

/** `destBase`/`destName` from extract.config.yaml, anchored at dirname(primary) (resolveDest parity). */
export async function resolveExtractDest(
  primary: string,
  io: WorkspaceIO,
  line: ReleaseLine,
): Promise<string | null> {
  const dir = line.paths[0];
  if (dir === undefined) return null;
  const configPath = join(primary, dir, "extract.config.yaml");
  if (!(await io.exists(configPath))) return null;
  const raw = await io.readFile(configPath);
  const unquote = (v: string | undefined): string | undefined =>
    v?.replace(/^["']|["']$/g, "");
  const destBase = unquote(raw.match(/^destBase:\s*(\S+)\s*$/m)?.[1]);
  const destName = unquote(raw.match(/^destName:\s*(\S+)\s*$/m)?.[1]);
  if (destName === undefined) return null;
  return resolve(
    dirname(primary),
    destBase ?? "packages",
    destName,
  );
}

/** The annotation's `level:` field — baseline tags are never published. */
export async function tagAnnotationLevel(
  repoRoot: string,
  io: WorkspaceIO,
  tag: string,
): Promise<string | null> {
  const result = await git(repoRoot, io, [
    "for-each-ref",
    `refs/tags/${tag}`,
    "--format=%(contents)",
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.match(/^level:\s*(\S+)\s*$/m)?.[1] ?? null;
}

/**
 * Publish one package-line tag: extract at the tag ref, verify via the hook,
 * push the destination. A non-fast-forward rejection reconciles once with
 * fetch + ours-merge (local tree is the authoritative export), never force.
 */
export async function publishTag(
  primary: string,
  io: WorkspaceIO,
  opts: { line: ReleaseLine; tag: string },
): Promise<PublicationRow> {
  const { line, tag } = opts;
  const row: PublicationRow = {
    tag,
    line: line.id,
    status: "published",
    dest: null,
    verify: null,
    reconciled: false,
    destHead: null,
  };

  const dir = line.paths[0];
  if (dir === undefined) {
    row.status = "failed";
    row.error = `line ${line.id} has no package directory`;
    return row;
  }

  const level = await tagAnnotationLevel(primary, io, tag);
  if (level === "baseline") {
    row.status = "skipped-baseline";
    return row;
  }

  // 1. Extract — the binary lives in the adopting repository's own install.
  // node_modules/.bin/repo-extract is a POSIX sh shim even on Windows (the
  // package ships one file), so the extract runs through `sh` — same seam
  // flow scripts already use — rather than spawning the shim as an exec.
  const extract = await io.exec(
    "sh",
    [
      join(primary, "node_modules", ".bin", "repo-extract"),
      "--config", `${dir}/extract.config.yaml`, "--ref", tag, "--no-push",
    ],
    { cwd: primary },
  );
  if (extract.exitCode !== 0) {
    row.status = "failed";
    row.error = `repo-extract failed (exit ${extract.exitCode}): ${extract.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
    return row;
  }

  // 2. Destination — same resolution as the retired publish-forge.mjs (RFC-1499).
  const dest = await resolveExtractDest(primary, io, line);
  row.dest = dest;
  if (dest === null || !(await io.exists(join(dest, ".git")))) {
    row.status = "failed";
    row.error = `extract destination could not be resolved for ${tag} (destName in ${dir}/extract.config.yaml)`;
    return row;
  }

  // 3. Verify hook — absent script reports skipped, a failure stops here.
  const verify = await runFlowScript(io, "extract-verify", {
    primary,
    cwd: primary,
    env: {
      FORGE_FLOW_EXTRACT_DEST: dest,
      FORGE_FLOW_TAG: tag,
      FORGE_FLOW_LINE: line.id,
    },
  });
  row.verify = verify;
  if (verify.status === "failed") {
    row.status = "failed";
    row.error = `extract-verify failed (exit ${verify.exitCode}): ${verify.stderrTail}`;
    return row;
  }

  // 4. Push the extract destination — `branch --show-current` first, the
  // rev-parse fallback keeps a detached export HEAD pushable.
  const branchShown = await git(dest, io, ["branch", "--show-current"]);
  const branch =
    branchShown.stdout.trim() ||
    (await git(dest, io, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const firstPush = await git(dest, io, ["push", "-u", "origin", branch]);
  if (firstPush.exitCode !== 0) {
    const out = `${firstPush.stdout}\n${firstPush.stderr}`;
    if (!/non-fast-forward|\(fetch first\)/i.test(out)) {
      row.status = "failed";
      row.error = `destination push failed: ${out.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
    // Reconcile once — the exported tree is authoritative; remote history
    // is preserved. Never force-push.
    row.reconciled = true;
    await git(dest, io, ["fetch", "origin"]);
    const merge = await gitCommit(
      dest,
      io,
      [
        "merge",
        "-s",
        "ours",
        "--allow-unrelated-histories",
        "-m",
        "merge: reconcile remote export history (local tree is authoritative export)",
        `origin/${branch}`,
      ],
      "publish",
    );
    if (merge.exitCode !== 0) {
      row.status = "failed";
      row.error = `reconcile merge failed: ${merge.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
    const retry = await git(dest, io, ["push", "-u", "origin", branch]);
    if (retry.exitCode !== 0) {
      row.status = "failed";
      row.error = `destination push failed after reconcile: ${retry.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
  }

  row.destHead = (await git(dest, io, ["rev-parse", "HEAD"])).stdout.trim();
  return row;
}

export interface LineVerifyResult {
  ok: boolean;
  /** True when the line carries no extract.config.yaml — nothing to verify. */
  skipped: boolean;
  /** FLOW-CUT-13 detail when ok === false. */
  detail: string;
}

/**
 * Pre-tag extract verification (RFC-1502): extract the line at `ref` into a
 * scratch directory under os.tmpdir() — `--dest` redirects the output, the
 * configured destination is never written — then run the extract-verify
 * hook against the scratch. The scratch is always removed. A line without
 * an extract.config.yaml is skipped (nothing publishable to verify).
 */
export async function verifyLineAtRef(
  primary: string,
  io: WorkspaceIO,
  opts: { line: ReleaseLine; ref: string },
): Promise<LineVerifyResult> {
  const { line, ref } = opts;
  const dir = line.paths[0];
  if (dir === undefined || !(await io.exists(join(primary, dir, "extract.config.yaml")))) {
    return { ok: true, skipped: true, detail: "" };
  }
  const scratch = await mkdtemp(join(tmpdir(), "flow-extract-"));
  try {
    const extractBin = join(primary, "node_modules", ".bin", "repo-extract");
    let extract;
    try {
      // The .bin shim is a POSIX sh script — exec it through sh so the
      // verification extract works on Windows runners as well as POSIX.
      extract = await io.exec(
        "sh",
        [
          extractBin,
          "--config", `${dir}/extract.config.yaml`, "--ref", ref, "--dest", scratch, "--no-push",
        ],
        { cwd: primary },
      );
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        detail: `repo-extract could not run at ${extractBin}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (extract.exitCode !== 0) {
      const last = extract.stderr.trim().split("\n").filter((l) => l.length > 0).slice(-1)[0] ?? "";
      return { ok: false, skipped: false, detail: `repo-extract failed (exit ${extract.exitCode}): ${last}` };
    }
    const verify = await runFlowScript(io, "extract-verify", {
      primary,
      cwd: primary,
      env: {
        FORGE_FLOW_EXTRACT_DEST: scratch,
        FORGE_FLOW_REF: ref,
        FORGE_FLOW_LINE: line.id,
      },
    });
    if (verify.status === "failed") {
      return { ok: false, skipped: false, detail: `extract-verify failed (exit ${verify.exitCode}): ${verify.stderrTail}` };
    }
    return { ok: true, skipped: false, detail: "" };
  } finally {
    // Scratch removal is best-effort — a removal failure must not mask a
    // computed verification result (nor crash the cut after ok was decided).
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
