/*
<MODULE_CONTRACT>
<purpose>flow.digest — read-only operator command (RFC-1491): prints the risk
digest of the unpushed outbound state. The digestId it reports is the id
flow.push must quote; --no-fetch skips the git fetch for offline review.</purpose>
<non-goals>
  <item>No outbound mutation — only the optional fetch touches remote-tracking refs.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 3 — flow.digest handler</item>
  <item>RFC-1491: step 3 — flow.digest risk digest with journal-attributed items, categories, digestId</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { collectDigest, type FlowDigestData } from "../digest.ts";
import { requireGit, topLevel } from "../git.ts";
import { RISK_CATEGORIES } from "../registry.ts";

export type { FlowDigestData };

export async function runFlowDigest(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowDigestData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.digest must run inside a git repository");
  }

  const noFetch = input.flags["no-fetch"] === true;
  const data = await collectDigest(repoRoot, io, { fetch: !noFetch });
  const errors = data.diagnostics.filter((d) => d.severity === "error");

  if (outputFormat === "pretty") {
    logger.section("Outbound digest");
    logger.info(
      `  develop: ${data.develop.local.slice(0, 9)} (ahead ${data.develop.ahead})` +
        `  main: ${data.main.local.slice(0, 9)} (ahead ${data.main.ahead})` +
        `  fetched: ${data.fetched}`,
    );
    if (data.tags.length > 0) logger.info(`  tags: ${data.tags.join(", ")}`);
    for (const category of RISK_CATEGORIES) {
      const ids = data.byCategory[category];
      if (ids.length === 0) continue;
      logger.info(`  ${category}:`);
      for (const id of ids) {
        const item = data.items.find((i) => i.id === id);
        if (item === undefined) continue;
        const label = item.branch ?? "(unattributed)";
        const subjects = item.subjects.length > 0 ? ` — ${item.subjects.join("; ")}` : "";
        logger.info(`    ${item.id} ${item.kind} ${label} (${item.commits} commit(s))${subjects}`);
      }
    }
    for (const held of data.held) {
      logger.info(`  held: ${held.branch} @ ${held.tip.slice(0, 9)} [${held.riskCategory}] — ${held.reason}`);
    }
    for (const pending of data.pendingPublications) {
      logger.info(`  pending publication: ${pending.tag} (${pending.line})`);
    }
    for (const d of data.diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
    logger.info(`  digestId: ${data.digestId}`);
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `[flow.digest] ${data.digestId} — ${data.items.length} item(s), ${data.tags.length} tag(s), ${data.pendingPublications.length} pending publication(s)`,
  };
}
