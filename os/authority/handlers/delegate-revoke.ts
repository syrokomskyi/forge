/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority.delegate.revoke — operator-only revocation.
Sets revokedAt (+ revokedBy when --by is given) on an existing entry and
fans out an authority-delegation-revoked Bordbuch event per covered site.
Re-running on an already-revoked id is a no-op exit-0 — revocation is
idempotent.</purpose>
<non-goals>
  <item>Do not delete entries — the registry is append-only evidence; revocation is a state transition, not erasure.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial handler — revokedAt stamp + per-site Bordbuch fan-out.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import {
  HUMAN_ID_PATTERN,
  loadDelegations,
  serializeDelegations,
  delegationsPath,
} from "../../../src/authority/delegations.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { appendAuthorityEvent, coveredSites, flagString } from "../helpers.ts";

export interface AuthorityDelegateRevokeResult {
  command: "authority.delegate.revoke";
  status: "pass" | "fail";
  id: string;
  revokedAt?: string;
  alreadyRevoked?: boolean;
  bordbuch?: { appended: string[]; skipped: boolean };
  diagnostics: string[];
}

export async function runAuthorityDelegateRevoke(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthorityDelegateRevokeResult>> {
  const { workspaceRoot, logger } = context;
  const id = flagString(input, "id");
  const by = flagString(input, "by");

  if (!id) throw new Error("authority.delegate.revoke requires --id del-NNNN");
  if (by !== undefined && !HUMAN_ID_PATTERN.test(by)) {
    throw new Error(`--by must name the revoking human (human:<handle>) — got "${by}"`);
  }

  const registry = await loadDelegations(workspaceRoot, context.io);
  const entry = registry.delegations.find((d) => d.id === id);
  if (!entry) {
    throw new Error(`no delegation "${id}" in the registry`);
  }
  if (entry.revokedAt) {
    return {
      data: {
        command: "authority.delegate.revoke",
        status: "pass",
        id,
        alreadyRevoked: true,
        diagnostics: [`${id} was already revoked at ${entry.revokedAt}`],
      },
      summary: `[authority.delegate.revoke] ${id} already revoked at ${entry.revokedAt}`,
      exitCode: 0,
    };
  }

  entry.revokedAt = new Date().toISOString();
  if (by !== undefined) entry.revokedBy = by;

  if (context.dryRun) {
    return {
      data: {
        command: "authority.delegate.revoke",
        status: "pass",
        id,
        revokedAt: entry.revokedAt,
        diagnostics: ["dry-run — registry unchanged"],
      },
      summary: `[authority.delegate.revoke] would revoke ${id}`,
      exitCode: 0,
    };
  }

  await resolveIo(context.io).writeFile(
    delegationsPath(workspaceRoot),
    serializeDelegations(registry),
  );

  const covered = await coveredSites(workspaceRoot, entry, context.io);
  const bordbuch = await appendAuthorityEvent(context, {
    kind: "authority-delegation-revoked",
    sites: covered,
    summary: `Delegation ${entry.id} revoked${by ? ` by ${by}` : ""} (${entry.scope} → ${entry.grantedTo})`,
    actor: by ?? entry.grantedBy,
    metadata: {
      delegationId: entry.id,
      scope: entry.scope,
      grantedTo: entry.grantedTo,
      ...(by !== undefined ? { revokedBy: by } : {}),
    },
  });

  logger.success(`[authority.delegate.revoke] revoked ${id} (${entry.scope} → ${entry.grantedTo})`);
  return {
    data: {
      command: "authority.delegate.revoke",
      status: "pass",
      id,
      revokedAt: entry.revokedAt,
      bordbuch,
      diagnostics: [],
    },
    summary: `[authority.delegate.revoke] ${id} revoked at ${entry.revokedAt}`,
    exitCode: 0,
  };
}
