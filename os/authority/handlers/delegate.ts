/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority.delegate — operator-only grant path. Writes one
entry into the workspace-root authority.delegations.yaml registry and, when
running under a kernel host, fans out an authority-delegation Bordbuch event
to every covered site. Rejects non-delegable scopes, malformed actors,
unknown sites, and past expirations before any write.</purpose>
<non-goals>
  <item>Do not decide who may run this command — the human-only rule is workspace policy (AGENTS.md), not a process check.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Registry write is the durable act; the Bordbuch event is audit evidence fanned out per site and never authoritative.</item>
  <item>--site absent means a workspace grant; --site values must resolve to systems-cache siblings — a site that does not exist makes the grant meaningless.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial handler — grant append, site probe, optional --sign, per-site Bordbuch fan-out.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import {
  AGENT_OR_WILDCARD_PATTERN,
  DELEGABLE_SCOPES,
  HUMAN_ID_PATTERN,
  NON_DELEGABLE_SCOPES,
  BORDBUCH_SCOPE_PREFIX,
  isDelegableScope,
  loadDelegations,
  serializeDelegations,
  delegationsPath,
  canonicalDelegationPayload,
  type DelegationEntry,
} from "../../../src/authority/delegations.ts";
import { signDelegationPayload } from "../../../src/authority/signing.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  appendAuthorityEvent,
  coveredSites,
  flagString,
  flagStringList,
  systemsCacheSiteExists,
} from "../helpers.ts";

export interface AuthorityDelegateResult {
  command: "authority.delegate";
  status: "pass" | "fail";
  delegation?: DelegationEntry;
  bordbuch?: { appended: string[]; skipped: boolean };
  diagnostics: string[];
}

function nextDelegationId(entries: DelegationEntry[]): string {
  const max = entries.reduce((acc, e) => {
    const m = e.id.match(/^del-(\d{4,})$/);
    return m ? Math.max(acc, parseInt(m[1], 10)) : acc;
  }, 0);
  return `del-${String(max + 1).padStart(4, "0")}`;
}

export async function runAuthorityDelegate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthorityDelegateResult>> {
  const { workspaceRoot, logger } = context;
  const scope = flagString(input, "scope");
  const to = flagString(input, "to");
  const by = flagString(input, "by");
  const sites = flagStringList(input, "site");
  const expires = flagString(input, "expires");
  const note = flagString(input, "note");
  const sign = input.flags["sign"] === true || input.flags["sign"] === "true";

  if (!scope) throw new Error("authority.delegate requires --scope <scope-id>");
  if (!to) throw new Error("authority.delegate requires --to agent:<id>");
  if (!by) throw new Error("authority.delegate requires --by human:<handle>");
  if (!AGENT_OR_WILDCARD_PATTERN.test(to)) {
    throw new Error(
      `--to must name an agent identity (agent:<id>) or the agent:* wildcard — got "${to}". Agents may only act as themselves; human:<handle> grantees are not allowed.`,
    );
  }
  if (!HUMAN_ID_PATTERN.test(by)) {
    throw new Error(`--by must name the granting human (human:<handle>) — got "${by}"`);
  }
  if ((NON_DELEGABLE_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(
      `scope "${scope}" is non-delegable (RFC-1336) — security-sensitive or irreversible flows stay human-only`,
    );
  }
  if (!isDelegableScope(scope)) {
    throw new Error(
      `unknown scope "${scope}" — delegable scopes: ${[...DELEGABLE_SCOPES, `${BORDBUCH_SCOPE_PREFIX}<kind>`].join(", ")}`,
    );
  }
  if (to === "agent:*") {
    logger.warn(
      "  [authority] granting to the agent:* wildcard — any agent may claim this delegation; prefer an explicit agent:<id>",
    );
  }
  if (expires !== undefined && Number.isNaN(Date.parse(expires))) {
    throw new Error(`--expires must be an ISO-8601 datetime — got "${expires}"`);
  }
  if (expires !== undefined && new Date(expires).getTime() <= Date.now()) {
    throw new Error(`--expires "${expires}" is already in the past — grant would be born dead`);
  }

  for (const siteId of sites) {
    if (!(await systemsCacheSiteExists(workspaceRoot, siteId, context.io))) {
      throw new Error(
        `--site "${siteId}" does not resolve — no systems-cache/${siteId} sibling exists; site-scoped grants must name a real site`,
      );
    }
  }

  const registry = await loadDelegations(workspaceRoot, context.io);
  const grantedAt = new Date().toISOString();
  const entry: DelegationEntry = {
    id: nextDelegationId(registry.delegations),
    scope,
    grantedTo: to,
    grantedBy: by,
    sites: sites.length === 0 ? "workspace" : sites,
    grantedAt,
    expiresAt: expires ?? null,
    revokedAt: null,
    ...(note !== undefined ? { note } : {}),
  };

  if (sign) {
    const seed = process.env["SIGNING_PRIVATE_KEY"];
    if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error(
        "--sign requires SIGNING_PRIVATE_KEY (hex-encoded 32-byte Ed25519 seed) in the environment",
      );
    }
    entry.signature = `ed25519:${signDelegationPayload(seed, canonicalDelegationPayload(entry))}`;
  }

  if (context.dryRun) {
    return {
      data: {
        command: "authority.delegate",
        status: "pass",
        delegation: entry,
        diagnostics: ["dry-run — registry unchanged"],
      },
      summary: `[authority.delegate] would grant ${entry.id} (${scope} → ${to})`,
      exitCode: 0,
    };
  }

  registry.delegations.push(entry);
  const { resolveIo } = await import("../../../src/utils/io.ts");
  await resolveIo(context.io).writeFile(
    delegationsPath(workspaceRoot),
    serializeDelegations(registry),
  );

  const covered = await coveredSites(workspaceRoot, entry, context.io);
  const bordbuch = await appendAuthorityEvent(context, {
    kind: "authority-delegation",
    sites: covered,
    summary: `Delegation ${entry.id}: ${scope} granted to ${to} by ${by}`,
    actor: by,
    metadata: {
      delegationId: entry.id,
      scope,
      grantedTo: to,
      expiresAt: entry.expiresAt ?? null,
      ...(note !== undefined ? { note } : {}),
    },
  });

  logger.success(`[authority.delegate] granted ${entry.id}: ${scope} → ${to}`);
  return {
    data: {
      command: "authority.delegate",
      status: "pass",
      delegation: entry,
      bordbuch,
      diagnostics: [],
    },
    summary: `[authority.delegate] ${entry.id}: ${scope} → ${to} (by ${by}${expires ? `, expires ${expires}` : ""})`,
    exitCode: 0,
  };
}
