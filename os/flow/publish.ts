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
  <item>Destination resolution mirrors publish-forge.mjs resolveDest(): destBase/destName parsed from extract.config.yaml, anchored at dirname(primary), destBase default "packages".</item>
  <item>Reconcile only on non-fast-forward (the same regex as publish-forge.mjs) — auth, hook and transient failures never trigger an ours-merge.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 5 — publishTag (extract, verify, dest push, single ours-merge reconcile)</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
</CHANGE_SUMMARY>
*/

import { dirname, join, resolve } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import { git, gitCommit } from "./git.ts";
import { runFlowScript, type FlowScriptResult } from "./scripts.ts";
import type { ReleaseLine } from "./release-lines.ts";

export interface PublicationRow {
  tag: string;
  line: string;
  status: "published" | "failed" | "skipped-baseline";
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
  const destBase = raw.match(/^destBase:\s*(\S+)\s*$/m)?.[1];
  const destName = raw.match(/^destName:\s*(\S+)\s*$/m)?.[1];
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
  const extract = await io.exec(
    join(primary, "node_modules", ".bin", "repo-extract"),
    ["--config", `${dir}/extract.config.yaml`, "--ref", tag, "--no-push"],
    { cwd: primary },
  );
  if (extract.exitCode !== 0) {
    row.status = "failed";
    row.error = `repo-extract failed (exit ${extract.exitCode}): ${extract.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
    return row;
  }

  // 2. Destination — same resolution as repo-extract/publish-forge.mjs.
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
