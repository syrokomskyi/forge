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
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1501: one argv-shaped read-only git allowlist for the recording and read-only adapters (RFC-1501)

READ_ONLY_GIT_QUERIES / isReadOnlyGitQuery replace the recording adapter's
first-argument allowlist; the read-only adapter and the static scan use the same
table. The kernel forwards --dry-run into commands that declare a dry-run flag,
and flow.push / flow.hold dry-runs no longer fetch. The switch-over runbook goes
back to werkstatt run flow.install --dry-run.</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
  <item>RFC-1503: review r1 — FLOW-07 on retire journal failure, journal re-read before publish, publication-order unit tests, stale catalog/inventory regen</item>
  <history>RFC-1491</history>
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
import { collectDigest, lineForTag, versionOfTag } from "../digest.ts";
import {
  git,
  requireGit,
  topLevel,
} from "../git.ts";
import { markerIsValid } from "../markers.ts";
import { publishTag, tagAnnotationLevel, type PublicationRow } from "../publish.ts";
import { planPublications, type PublicationPlanEntry } from "../publication-order.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  readJournal,
} from "../registry.ts";
import { discoverReleaseLines, type ReleaseLine } from "../release-lines.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowPushData {
  digestId: string;
  pushed: boolean;
  refs: string[];
  publications: PublicationRow[];
  /** RFC-1503: pending tags superseded this run — `{ tag, by }`. */
  superseded: Array<{ tag: string; by: string }>;
  /** RFC-1503: tags with a publish-retired journal record (informational). */
  retired: string[];
  diagnostics: Diagnostic[];
  /** RFC-1501: whether the preflight digest fetched origin; absent on early refusals. */
  fetched?: boolean;
}

function refuse(ruleId: string, message: string, fixHint?: string): FlowPushData {
  return {
    digestId: "",
    pushed: false,
    refs: [],
    publications: [],
    superseded: [],
    retired: [],
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
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
  // RFC-1501: a dry-run never fetches — `git fetch origin --prune` rewrites
  // and prunes remote-tracking refs. It judges the digest exactly like
  // `flow.digest --no-fetch`; a real push still fetches first.
  const digest = await collectDigest(repoRoot, io, { fetch: !opts.dryRun });
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

  // Publications (RFC-1503): candidates = package-line tags pushed now +
  // journal-scoped pending, minus baseline annotations; per line only the
  // highest version is attempted — lower ones supersede, retired tags drop.
  const journalEvents = await readJournal(io, common);
  const publishedTags = new Set(
    journalEvents.filter((e) => e.event === "publish").map((e) => e.branch),
  );
  const retiredTags = new Set(
    journalEvents.filter((e) => e.event === "publish-retired").map((e) => e.branch),
  );

  const publicationTags = new Map<string, ReleaseLine>();
  const addCandidate = (tag: string, lineId: string | null): void => {
    const line =
      (lineId === null ? null : lines.find((l) => l.id === lineId)) ?? lineForTag(lines, tag);
    if (line !== null && line.id !== "repo") publicationTags.set(tag, line);
  };
  for (const tag of digest.tags) addCandidate(tag, null);
  for (const pending of digest.pendingPublications) addCandidate(pending.tag, pending.line);
  for (const sup of digest.supersededPublications) addCandidate(sup.tag, sup.line);

  const baselineSkipped: PublicationRow[] = [];
  const planCandidates: PublicationPlanEntry[] = [];
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
      planCandidates.push({ tag, line: line.id });
    }
  }
  let plan = planPublications(planCandidates, publishedTags, retiredTags, (tag, lineId) =>
    versionOfTag(lines, tag, lineId),
  );
  let publishable: Array<{ tag: string; line: ReleaseLine }> = plan.attempt.map((p) => ({
    tag: p.tag,
    line: lines.find((l) => l.id === p.line)!,
  }));

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

  // Sha-pinned refspecs — the push ships exactly the reviewed tips; a local
  // branch that moved since the digest stays local instead of sneaking in.
  const refspecs = [
    `${digest.develop.local}:refs/heads/develop`,
    `${digest.main.local}:refs/heads/main`,
    ...digest.tags.map((t) => `refs/tags/${t}:refs/tags/${t}`),
  ];

  if (opts.dryRun) {
    return {
      digestId: digest.digestId,
      fetched: digest.fetched,
      pushed: false,
      refs: refspecs,
      publications: [
        ...baselineSkipped,
        ...publishable.map(
          (p): PublicationRow => ({
            tag: p.tag,
            line: p.line.id,
            status: "pending",
            dest: null,
            verify: null,
            reconciled: false,
            destHead: null,
          }),
        ),
      ],
      superseded: plan.superseded.map((s) => ({
        tag: s.tag,
        by: s.by ?? plan.attempt.find((a) => a.line === s.line)?.tag ?? "",
      })),
      retired: [...retiredTags].sort((a, b) => a.localeCompare(b)),
      diagnostics: [],
    };
  }

  // --- push ------------------------------------------------------------------
  const hasRefs = digest.develop.ahead > 0 || digest.main.ahead > 0 || digest.tags.length > 0;
  const journalWarnings: string[] = [];
  let pushed = false;
  if (hasRefs) {
    const push = await git(repoRoot, io, ["push", "--atomic", "origin", ...refspecs], {
      env: { FORGE_FLOW_OP: "push" },
    });
    if (push.exitCode !== 0) {
      return {
        digestId: digest.digestId,
        fetched: digest.fetched,
        pushed: false,
        refs: refspecs,
        publications: [],
        superseded: [],
        retired: [...retiredTags].sort((a, b) => a.localeCompare(b)),
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
    } catch (error) {
      journalWarnings.push(
        `push journal record could not be appended — pending-publication retries for ${digest.tags.join(", ") || "no tags"} are lost: ${String(error)}`,
      );
    }
  }

  // --- publications ------------------------------------------------------------
  // RFC-1503 review r1 F-5: re-read the journal after the push — a retire or
  // supersede record appended meanwhile must drop the tag from this run's
  // attempts. The window can only be narrowed, not closed: appendJournal
  // takes no push-spanning lock.
  const freshJournal = await readJournal(io, common);
  const freshPublished = new Set(
    freshJournal.filter((e) => e.event === "publish").map((e) => e.branch),
  );
  const freshRetired = new Set(
    freshJournal.filter((e) => e.event === "publish-retired").map((e) => e.branch),
  );
  const freshSuperseded = new Set(
    freshJournal.filter((e) => e.event === "publish-superseded").map((e) => e.branch),
  );
  if (
    freshPublished.size !== publishedTags.size ||
    freshRetired.size !== retiredTags.size
  ) {
    for (const tag of freshPublished) publishedTags.add(tag);
    for (const tag of freshRetired) retiredTags.add(tag);
    plan = planPublications(
      planCandidates.filter((c) => !freshSuperseded.has(c.tag)),
      publishedTags,
      retiredTags,
      (tag, lineId) => versionOfTag(lines, tag, lineId),
    );
    publishable = plan.attempt.map((p) => ({
      tag: p.tag,
      line: lines.find((l) => l.id === p.line)!,
    }));
  } else {
    plan = {
      attempt: plan.attempt,
      superseded: plan.superseded.filter((s) => !freshSuperseded.has(s.tag)),
    };
  }

  const publications: PublicationRow[] = [...baselineSkipped];
  const supersededOut: Array<{ tag: string; by: string }> = [];
  const diagnostics: Diagnostic[] = journalWarnings.map(
    (message): Diagnostic => ({
      ruleId: "FLOW-07",
      severity: "warning",
      message,
    }),
  );

  const recordSuperseded = async (tag: string, by: string): Promise<void> => {
    try {
      await appendJournal(io, common, {
        event: "publish-superseded",
        branch: tag,
        sha: "",
        detail: by,
      });
      supersededOut.push({ tag, by });
    } catch (error) {
      diagnostics.push({
        ruleId: "FLOW-07",
        severity: "warning",
        message: `publish-superseded record for ${tag} could not be appended — the tag stays pending and will be re-evaluated on the next push: ${String(error)}`,
      });
    }
  };

  // Superseded on sight — a pending tag at or below the line's newest
  // published version is never extracted (RFC-1503 AC-3).
  for (const sup of plan.superseded) {
    if (sup.by !== null) await recordSuperseded(sup.tag, sup.by);
  }
  // Shadowed candidates — superseded only once their line's highest tag
  // actually publishes (RFC-1503 AC-2).
  const shadowed = new Map<string, string[]>();
  for (const sup of plan.superseded) {
    if (sup.by === null) {
      const list = shadowed.get(sup.line) ?? [];
      list.push(sup.tag);
      shadowed.set(sup.line, list);
    }
  }

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
      } catch (error) {
        diagnostics.push({
          ruleId: "FLOW-07",
          severity: "warning",
          message: `publish journal record for ${tag} could not be appended — the tag will be retried as pending: ${String(error)}`,
        });
      }
      for (const low of shadowed.get(line.id) ?? []) {
        await recordSuperseded(low, tag);
      }
    }
  }

  return {
    digestId: digest.digestId,
    fetched: digest.fetched,
    pushed,
    refs: refspecs,
    publications,
    superseded: supersededOut,
    retired: [...freshRetired].sort((a, b) => a.localeCompare(b)),
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
  const publishedCount = data.publications.filter((p) => p.status === "published").length;

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
      } else if (pub.status === "pending") {
        logger.info(`  would publish ${pub.tag} (dry-run)`);
      }
    }
    for (const sup of data.superseded) {
      logger.info(`  superseded ${sup.tag} by ${sup.by}`);
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary: input.flags["dry-run"] === true
      ? `[flow.push] dry-run — ${data.refs.length} ref(s), ${data.publications.length} publication candidate(s)`
      : data.pushed || publishedCount > 0
        ? `[flow.push] pushed ${data.refs.length} ref(s), ${publishedCount} publication(s)`
        : `[flow.push] refused — ${errors.length} error(s)`,
  };
}
