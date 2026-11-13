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
  <item>RFC-1491: step 3 — flow.digest risk digest with journal-attributed items, categories, digestId</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1498: step 4 — CI tag triggers and FLOW-11 in flow.digest

flow.digest now reads .github/workflows on the primary checkout and reports tagTriggers: for every digest tag the workflows whose on.push.tags filter matches its name. Matching evaluates the GitHub glob subset — star inside a segment, double-star across, question for one char; character classes and leading negations report FLOW-11 as pattern not understood and match nothing. A workflow that cannot be parsed reports FLOW-11 and contributes nothing, never blocking the digest. tagTriggers feeds digestId so a workflow change invalidates a quoted id, the pretty output prints one line per triggered tag, and flow.module declares FLOW-11 warning plus the workflows read glob. Tests AC-7 (a v1.0.1 tag maps to the v-star workflow only) and AC-8 (broken YAML and a bracket pattern warn while the digest still returns). Compass metadata updated.</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
  <item>RFC-1580: digest trail, manifest review export, operating model and skills

flow.digest lists X-Correctness-Weakening trailers and verifier-trailer commits (correctnessTrail, part of digestId); rfc.verify.workspace --manifest exports the oracle-review surface with MANIFEST-REVIEW-BUNDLE.md hashes; operating model §7 product tiers and §8 'a self oracle never covers an anchor of a product correctness manifest'; fo-review oracle review mode producing forge/oracle-review@1; fo-idea-implement step 4.4c; correctness-gate reference page; forge AGENTS.md gate rules.</item>
  <history>RFC-1491</history>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import type { Diagnostic } from "../../../src/types.ts";
import { collectDigest, type FlowDigestData } from "../digest.ts";
import { requireGit, topLevel } from "../git.ts";
import { FlowRegistrySchemaError, RISK_CATEGORIES } from "../registry.ts";

export type { FlowDigestData };

/** Diagnostic-only digest for a registry that cannot be read at all. */
function emptyDigestData(diagnostics: Diagnostic[]): FlowDigestData {
  return {
    digestId: "",
    remote: "origin",
    fetched: false,
    develop: { local: "", remote: null, ahead: 0 },
    main: { local: "", remote: null, ahead: 0 },
    tags: [],
    items: [],
    byCategory: Object.fromEntries(RISK_CATEGORIES.map((c) => [c, [] as string[]])) as FlowDigestData["byCategory"],
    held: [],
    pendingPublications: [],
    supersededPublications: [],
    tagTriggers: [],
    correctnessTrail: { weakenings: [], verifierCommits: [] },
    diagnostics,
  };
}

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
  let data: FlowDigestData;
  try {
    data = await collectDigest(repoRoot, io, { fetch: !noFetch });
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return {
        data: emptyDigestData([
          { ruleId: "FLOW-07", severity: "error", message: error.message },
        ]),
        exitCode: 1,
        summary: "[flow.digest] refused — registry unreadable",
      };
    }
    throw error;
  }
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
    for (const sup of data.supersededPublications) {
      const by = sup.by === null ? "waits behind a higher pending tag" : `superseded by ${sup.by}`;
      logger.info(`  superseded publication: ${sup.tag} (${sup.line}) — ${by}`);
    }
    for (const trigger of data.tagTriggers) {
      logger.info(`  tag ${trigger.tag} triggers: ${trigger.workflows.join(", ")}`);
    }
    for (const w of data.correctnessTrail.weakenings) {
      logger.warn(`  accepted correctness weakening ${w.sha.slice(0, 9)}: ${w.reason}`);
    }
    for (const v of data.correctnessTrail.verifierCommits) {
      logger.info(`  verifier-trailer commit ${v.sha.slice(0, 9)} ${v.subject}${v.report ? ` (report ${v.report})` : ""}`);
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
