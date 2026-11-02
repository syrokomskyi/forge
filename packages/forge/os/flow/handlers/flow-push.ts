/*
<MODULE_CONTRACT>
<purpose>flow.push — the only outbound path (RFC-1491): refuse preflight
FLOW-PUSH-01/02/03/06/07, run the atomic push of develop+main+tags under
FORGE_FLOW_OP=push, journal the push, then publish the package-line tags
(pushed now plus journal-scoped pending, minus baseline) through
repo-extract with a single ours-merge reconcile — never force-push, never
a manual push path.</purpose>
<non-goals>
  <item>No digest computation beyond collectDigest — digest.ts owns the shape.</item>
  <item>No real repo-extract in tests — fixtures install a fake binary.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The digest must be quoted: a recomputed digestId mismatch refuses FLOW-PUSH-02 and names the new id, so the operator always pushes what they reviewed.</item>
  <item>A rerun with an empty develop/main/tag digest skips the push but still retries pendingPublications — publication retries are journal-scoped to this machine's pushes only (AUDIT-RFC-1491-G1).</item>
  <item>Publication failures are FLOW-PUSH-05 per tag; the command continues with the next tag and exits non-zero at the end.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 5 — flow.push (preflight, atomic push, publications, journals)</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import {
  git,
  requireGit,
  topLevel,
} from "../git.ts";
import { markerIsValid } from "../markers.ts";
import { publishTag, tagAnnotationLevel, type PublicationRow } from "../publish.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
} from "../registry.ts";
import { discoverReleaseLines, type ReleaseLine } from "../release-lines.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowPushData {
  digestId: string;
  pushed: boolean;
  refs: string[];
  publications: PublicationRow[];
  diagnostics: Diagnostic[];
}

function refuse(ruleId: string, message: string, fixHint?: string): FlowPushData {
  return {
    digestId: "",
    pushed: false,
    refs: [],
    publications: [],
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

/** Line a tag belongs to — longest tagPrefix wins. */
function lineForTag(lines: ReleaseLine[], tag: string): ReleaseLine | null {
  let best: ReleaseLine | null = null;
  for (const line of lines) {
    if (tag.startsWith(line.tagPrefix) && (best === null || line.tagPrefix.length > best.tagPrefix.length)) {
      best = line;
    }
  }
  return best;
}

/**
 * Core of flow.push — callable in tests. Every refusal is a diagnostic in
 * the returned data; nothing leaves the machine unless pushed: true.
 */
export async function pushFlow(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { digest: string; dryRun: boolean; now?: Date },
): Promise<FlowPushData> {
  const common = await commonGitDir(io, repoRoot);
  const primary = await primaryWorktree(io, repoRoot);

  // --- preflight -------------------------------------------------------------
  const digest = await collectDigest(repoRoot, io, { fetch: true });
  const noOrigin = digest.diagnostics.find(
    (d) => d.ruleId === "FLOW-PUSH-01" && d.severity === "error",
  );
  if (noOrigin !== undefined) {
    return refuse("FLOW-PUSH-01", noOrigin.message, "add an 'origin' remote first");
  }
  if (digest.digestId !== opts.digest) {
    return refuse(
      "FLOW-PUSH-02",
      `the digest is stale — the current digestId is ${digest.digestId}, not ${opts.digest}`,
      `run flow.digest, review the new state and re-run flow.push --digest ${digest.digestId}`,
    );
  }

  for (const [branch, remote] of [
    ["develop", digest.develop.remote],
    ["main", digest.main.remote],
  ] as const) {
    if (remote === null) continue;
    const ancestor = await git(repoRoot, io, [
      "merge-base",
      "--is-ancestor",
      remote,
      branch,
    ]);
    if (ancestor.exitCode !== 0) {
      return refuse(
        "FLOW-PUSH-03",
        `origin/${branch} is not an ancestor of ${branch} — someone pushed elsewhere`,
        "fetch, inspect the divergence and reconcile before pushing",
      );
    }
  }

  const { lines } = await discoverReleaseLines(repoRoot, io);

  // Publications: package-line tags pushed now + journal-scoped pending,
  // minus baseline annotations.
  const publicationTags = new Map<string, ReleaseLine>();
  for (const tag of digest.tags) {
    const line = lineForTag(lines, tag);
    if (line !== null && line.id !== "repo") publicationTags.set(tag, line);
  }
  for (const pending of digest.pendingPublications) {
    const line = lines.find((l) => l.id === pending.line) ?? lineForTag(lines, pending.tag);
    if (line !== null && line.id !== "repo") publicationTags.set(pending.tag, line);
  }
  const publishable: Array<{ tag: string; line: ReleaseLine }> = [];
  const baselineSkipped: PublicationRow[] = [];
  for (const [tag, line] of [...publicationTags.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const level = await tagAnnotationLevel(repoRoot, io, tag);
    if (level === "baseline") {
      baselineSkipped.push({
        tag,
        line: line.id,
        status: "skipped-baseline",
        dest: null,
        verify: null,
        reconciled: false,
        destHead: null,
      });
    } else {
      publishable.push({ tag, line });
    }
  }

  for (const { line } of publishable) {
    const dir = line.paths[0]!;
    if (!(await markerIsValid(join(primary, dir, "forge.generated.yaml"), io))) {
      return refuse(
        "FLOW-PUSH-06",
        `package line ${line.id} has no valid forge.generated.yaml in ${dir} — it must not be published`,
        "re-run flow.install to restore the marker, or remove the line's tags",
      );
    }
  }

  const extractBin = join(primary, "node_modules", ".bin", "repo-extract");
  if (publishable.length > 0 && !(await io.exists(extractBin))) {
    return refuse(
      "FLOW-PUSH-07",
      `${extractBin} is missing while ${publishable.length} tag(s) wait to publish`,
      "install the workspace dependencies so repo-extract is linked",
    );
  }

  const refspecs = [
    "refs/heads/develop:refs/heads/develop",
    "refs/heads/main:refs/heads/main",
    ...digest.tags.map((t) => `refs/tags/${t}:refs/tags/${t}`),
  ];

  if (opts.dryRun) {
    return {
      digestId: digest.digestId,
      pushed: false,
      refs: refspecs,
      publications: [
        ...baselineSkipped,
        ...publishable.map(
          (p): PublicationRow => ({
            tag: p.tag,
            line: p.line.id,
            status: "published",
            dest: null,
            verify: null,
            reconciled: false,
            destHead: null,
          }),
        ),
      ],
      diagnostics: [],
    };
  }

  // --- push ------------------------------------------------------------------
  const hasRefs = digest.develop.ahead > 0 || digest.main.ahead > 0 || digest.tags.length > 0;
  let pushed = false;
  if (hasRefs) {
    const push = await git(repoRoot, io, ["push", "--atomic", "origin", ...refspecs], {
      env: { FORGE_FLOW_OP: "push" },
    });
    if (push.exitCode !== 0) {
      return {
        digestId: digest.digestId,
        pushed: false,
        refs: refspecs,
        publications: [],
        diagnostics: [
          {
            ruleId: "FLOW-PUSH-04",
            severity: "error",
            message: `git push --atomic failed — nothing was updated: ${push.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`,
            fixHint: "inspect the remote error, reconcile, and re-run with a fresh digest",
          },
        ],
      };
    }
    pushed = true;
    try {
      await appendJournal(io, common, {
        event: "push",
        branch: "develop",
        sha: digest.develop.local,
        base: digest.develop.remote ?? undefined,
        detail: digest.tags.join(" "),
      });
    } catch {
      // journal failure is non-fatal bookkeeping — the refs already moved.
    }
  }

  // --- publications ------------------------------------------------------------
  const publications: PublicationRow[] = [...baselineSkipped];
  const diagnostics: Diagnostic[] = [];
  for (const { tag, line } of publishable) {
    const row = await publishTag(primary, io, { line, tag });
    publications.push(row);
    if (row.status === "failed") {
      diagnostics.push({
        ruleId: "FLOW-PUSH-05",
        severity: "error",
        message: `publication of ${tag} (${line.id}) failed: ${row.error ?? "unknown"}`,
        fixHint: "fix the extract or destination, then re-run flow.push with a fresh digest — pending publications are retried",
      });
      continue;
    }
    if (row.status === "published") {
      try {
        await appendJournal(io, common, {
          event: "publish",
          branch: tag,
          sha: row.destHead ?? "",
          detail: row.dest ?? "",
        });
      } catch {
        // bookkeeping — the publication itself already happened.
      }
    }
  }

  return {
    digestId: digest.digestId,
    pushed,
    refs: refspecs,
    publications,
    diagnostics,
  };
}

export async function runFlowPush(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowPushData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.push must run inside a git repository");
  }

  const digestFlag = typeof input.flags["digest"] === "string" ? input.flags["digest"] : "";
  if (digestFlag.length === 0) {
    return {
      data: refuse(
        "FLOW-PUSH-02",
        "--digest <id> is required — run flow.digest first and quote its digestId",
      ),
      exitCode: 1,
      summary: "[flow.push] missing --digest",
    };
  }

  let data: FlowPushData;
  try {
    data = await pushFlow(repoRoot, io, {
      digest: digestFlag,
      dryRun: input.flags["dry-run"] === true,
    });
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      data = refuse("FLOW-07", error.message);
    } else {
      throw error;
    }
  }
  const errors = data.diagnostics.filter((d) => d.severity === "error");

  if (outputFormat === "pretty") {
    for (const d of data.diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
    if (data.pushed) {
      logger.info(`  pushed: ${data.refs.join(", ")}`);
    }
    for (const pub of data.publications) {
      if (pub.status === "published") {
        logger.info(`  published ${pub.tag} → ${pub.dest}${pub.reconciled ? " (reconciled)" : ""}`);
      } else if (pub.status === "skipped-baseline") {
        logger.info(`  skipped baseline tag ${pub.tag}`);
      }
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary: data.pushed
      ? `[flow.push] pushed ${data.refs.length} ref(s), ${data.publications.filter((p) => p.status === "published").length} publication(s)`
      : `[flow.push] refused — ${errors.length} error(s)`,
  };
}
