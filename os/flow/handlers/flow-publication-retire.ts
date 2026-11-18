/*
<MODULE_CONTRACT>
<purpose>flow.publication.retire — operator-only command (RFC-1503): append a
`publish-retired` journal event for a pushed-but-unpublished tag so
flow.push never attempts it again. Refuses FLOW-RETIRE-01 when the tag
fails the pending gate (no journal `push` record, already
published/superseded/retired, or no such local tag) and FLOW-RETIRE-02
on an empty --reason.</purpose>
<non-goals>
  <item>No tag or remote mutation — the journal record is the whole effect.</item>
  <item>No digest/push — flow.digest and flow.push consume the record.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: step 3 — flow.publication.retire handler</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
  <item>RFC-1503: review r1 — FLOW-07 on retire journal failure, journal re-read before publish, publication-order unit tests, stale catalog/inventory regen</item>
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
</CHANGE_SUMMARY>
*/

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { gitEvidence, requireGit, topLevel } from "../git.ts";
import { appendJournal, commonGitDir, FlowRegistrySchemaError, readJournal } from "../registry.ts";

export interface RetirePublicationData {
  tag: string;
  retired: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Core of flow.publication.retire — callable in tests. Appends one
 * `publish-retired` journal event; the tag then never re-enters the
 * pending set this gate derives.
 */
export async function retirePublication(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { tag: string; reason: string },
): Promise<RetirePublicationData> {
  const reason = opts.reason.trim();
  if (reason.length === 0) {
    return {
      tag: opts.tag,
      retired: null,
      diagnostics: [
        {
          ruleId: "FLOW-RETIRE-02",
          severity: "error",
          message: "--reason must not be empty — the journal records it verbatim",
          fixHint: "pass a short reason naming why the tag can never publish",
        },
      ],
    };
  }

  const common = await commonGitDir(io, repoRoot);
  // Journal-derived pending is sufficient for this gate (R13-C): retire's
  // only effect is a `publish-retired` suppressor record the session could
  // write directly, so fabricated provenance can never escalate through
  // it — the tag itself must still resolve locally.
  const journal = await readJournal(io, common);
  const pushed = new Set<string>();
  const excluded = new Set<string>();
  for (const event of journal) {
    if (event.event === "push") {
      for (const token of event.detail.split(/[^A-Za-z0-9._/@-]+/)) {
        if (token.length > 0) pushed.add(token);
      }
    } else if (
      event.event === "publish" ||
      event.event === "publish-superseded" ||
      event.event === "publish-retired"
    ) {
      excluded.add(event.branch);
    }
  }
  const tagExists =
    pushed.has(opts.tag) &&
    (await gitEvidence(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${opts.tag}`]))
      .exitCode === 0;
  if (!tagExists || excluded.has(opts.tag)) {
    return {
      tag: opts.tag,
      retired: null,
      diagnostics: [
        {
          ruleId: "FLOW-RETIRE-01",
          severity: "error",
          message: `${opts.tag} is not a pending publication — only pushed-but-unpublished tags can be retired`,
          fixHint:
            "the tag needs a journal `push` record, no publish/supersede/retire record, and a local refs/tags entry",
        },
      ],
    };
  }
  try {
    await appendJournal(io, common, {
      event: "publish-retired",
      branch: opts.tag,
      sha: "",
      detail: reason,
    });
  } catch (error) {
    return {
      tag: opts.tag,
      retired: null,
      diagnostics: [
        {
          ruleId: "FLOW-07",
          severity: "error",
          message: `publish-retired record for ${opts.tag} could not be appended: ${String(error)}`,
        },
      ],
    };
  }
  return { tag: opts.tag, retired: opts.tag, diagnostics: [] };
}

export async function runFlowPublicationRetire(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RetirePublicationData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.publication.retire must run inside a git repository");
  }

  const tag = typeof input.flags["tag"] === "string" ? input.flags["tag"] : "";
  const reason = typeof input.flags["reason"] === "string" ? input.flags["reason"] : "";
  let data: RetirePublicationData;
  try {
    data = await retirePublication(repoRoot, io, { tag, reason });
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      data = {
        tag,
        retired: null,
        diagnostics: [{ ruleId: "FLOW-07", severity: "error", message: error.message }],
      };
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
    if (data.retired !== null) {
      logger.info(`  retired publication: ${data.retired}`);
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary:
      data.retired !== null
        ? `[flow.publication.retire] ${data.retired} retired — it will never be attempted again`
        : `[flow.publication.retire] refused — ${errors[0]?.ruleId ?? "unknown"}`,
  };
}
