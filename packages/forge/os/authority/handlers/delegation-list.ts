/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority.delegation.list — read-only registry listing.
Defaults to active grants; --history includes revoked and expired entries.
--site filters to grants covering one site.</purpose>
<non-goals>
  <item>Do not evaluate whether a grant authorizes a specific act — resolveDelegation does that; this reports registry content.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial handler — active-only default, --history flag, --site filter.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import { loadDelegations, type DelegationEntry } from "../../../src/authority/delegations.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { flagString } from "../helpers.ts";

export interface AuthorityDelegationListResult {
  command: "authority.delegation.list";
  status: "pass" | "fail";
  total: number;
  shown: number;
  delegations: DelegationEntry[];
  diagnostics: string[];
}

export async function runAuthorityDelegationList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthorityDelegationListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const site = flagString(input, "site");
  const history = input.flags["history"] === true || input.flags["history"] === "true";

  const registry = await loadDelegations(workspaceRoot, context.io);
  const now = new Date();
  const isActive = (d: DelegationEntry) =>
    !d.revokedAt && (!d.expiresAt || new Date(d.expiresAt).getTime() > now.getTime());
  const coversSite = (d: DelegationEntry) =>
    site === undefined || d.sites === "workspace" || d.sites.includes(site);

  const shown = registry.delegations.filter((d) => (history || isActive(d)) && coversSite(d));

  if (outputFormat === "pretty") {
    logger.section("Authority delegations");
    if (shown.length === 0) {
      logger.info("  (none)");
    }
    for (const d of shown) {
      const state = d.revokedAt
        ? `revoked ${d.revokedAt}`
        : d.expiresAt && new Date(d.expiresAt).getTime() <= now.getTime()
          ? `expired ${d.expiresAt}`
          : "active";
      const sites = d.sites === "workspace" ? "workspace" : d.sites.join(",");
      logger.info(
        `  ${d.id}  ${d.scope}  → ${d.grantedTo}  by ${d.grantedBy}  [${sites}]  ${state}`,
      );
    }
  }

  return {
    data: {
      command: "authority.delegation.list",
      status: "pass",
      total: registry.delegations.length,
      shown: shown.length,
      delegations: shown,
      diagnostics: [],
    },
    summary: `${shown.length}/${registry.delegations.length} delegation(s)${history ? "" : " active"}`,
    exitCode: 0,
  };
}
