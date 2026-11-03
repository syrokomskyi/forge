/*
<MODULE_CONTRACT>
<purpose>flow.publication.retire — operator-only command (RFC-1503): append a
`publish-retired` journal event for a pending publication tag so flow.push
never attempts it again. Refuses FLOW-RETIRE-01 when the tag is not pending
and FLOW-RETIRE-02 on an empty --reason.</purpose>
<non-goals>
  <item>No tag or remote mutation — the journal record is the whole effect.</item>
  <item>No digest/push — flow.digest and flow.push consume the record.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: step 3 — flow.publication.retire handler</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
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
import { collectDigest } from "../digest.ts";
import { requireGit, topLevel } from "../git.ts";
import { appendJournal, commonGitDir, FlowRegistrySchemaError } from "../registry.ts";

export interface RetirePublicationData {
  tag: string;
  retired: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Core of flow.publication.retire — callable in tests. Appends one
 * `publish-retired` journal event; the digest then drops the tag from
 * pendingPublications forever.
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

  const digest = await collectDigest(repoRoot, io, { fetch: false });
  const pending = new Set([
    ...digest.pendingPublications.map((p) => p.tag),
    ...digest.supersededPublications.map((p) => p.tag),
  ]);
  if (!pending.has(opts.tag)) {
    return {
      tag: opts.tag,
      retired: null,
      diagnostics: [
        {
          ruleId: "FLOW-RETIRE-01",
          severity: "error",
          message: `${opts.tag} is not a pending publication — only pushed-but-unpublished tags can be retired`,
          fixHint: "check flow.digest pendingPublications for the tag to retire",
        },
      ],
    };
  }

  const common = await commonGitDir(io, repoRoot);
  await appendJournal(io, common, {
    event: "publish-retired",
    branch: opts.tag,
    sha: "",
    detail: reason,
  });
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
