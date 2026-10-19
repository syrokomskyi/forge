/*
<MODULE_CONTRACT>
<purpose>RFC-1336: forge/authority-delegations@1 — the workspace-root
delegation registry schema plus the portable loader/resolver every
human-gated consumer shares. A delegation grants one declared agent
(grantedTo) the right to run one scope on behalf of a named human
(grantedBy), site-bounded, expirable, and revocable. The registry is
policy plus audit evidence — not a cryptographic security boundary.</purpose>
<non-goals>
  <item>Do not import kernel/site/engine packages — forge stays runtime-autonomous (FORGE-AUTONOMY-01).</item>
  <item>Do not police which process may invoke the mutating commands — the human-only rule on authority.delegate is workspace policy (AGENTS.md), not a check inside this module.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Registry absence is tolerance-neutral — ENOENT yields an empty registry; consumers treat "no file" and "no grant" identically (RFC-1336 unchanged-behavior rule).</item>
  <item>DelegationQuery carries an optional grantedBy — consumers that already know the deciding human (e.g. bordbuch.append --delegated-by) bind the query to the grantor so delegatedBy provenance cannot be fabricated against a different human's grant.</item>
  <item>sites: "workspace" covers every site; an explicit id list bounds site scope. Site-scoped queries with no site never match a site-listed grant.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial module — schema, scope catalog, loader, resolver, serializer.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
  <item>RFC-1336: delegated editorial sign-off (RFC-1336 step 3)

editorial.review.signoff admits agent:<id> reviewers under an active
editorial.signoff delegation — the record and the editorial-signoff
bordbuch event carry delegatedBy + delegationId provenance; the sign-off
schema fails closed on agent reviewers without it. leitstand.ship gains
an editorial-delegated-signoff step between sync-after-alt and
certify-main that prepares the packet (if absent) and signs as the
delegate — a journaled no-op with no delegation, so the operator path is
unchanged. certify/promote precondition remediation now names an active
delegation when one covers the site.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import type { WorkspaceIO } from "../types.ts";
import { resolveIo } from "../utils/io.ts";
import { canonicalJson } from "./signing.ts";

export const AUTHORITY_DELEGATIONS_SCHEMA_ID = "forge/authority-delegations@1";
export const DELEGATIONS_FILENAME = "authority.delegations.yaml";

export const AGENT_ID_PATTERN = /^agent:[a-z0-9][a-z0-9-]*$/;
export const AGENT_OR_WILDCARD_PATTERN = /^agent:([a-z0-9][a-z0-9-]*|\*)$/;
export const HUMAN_ID_PATTERN = /^human:[a-z0-9][a-z0-9-]*$/;

/**
 * The delegable scope catalogue (RFC-1336). `bordbuch.<kind>` is a
 * parameterized family — any concrete Bordbuch entry kind appends its own
 * scope (`bordbuch.editorial-signoff`, `bordbuch.operator-note`, …).
 */
export const DELEGABLE_SCOPES = [
  "editorial.signoff",
  "rfc.decision",
  "version.major",
  "onboarding.decision",
  "fleet.notify",
] as const;

export const BORDBUCH_SCOPE_PREFIX = "bordbuch.";

/**
 * Scopes that MUST NOT be delegated (RFC-1336 non-goals): security-sensitive
 * or irreversible flows stay human-only. Checked at grant write time and by
 * authority.delegation.validate (DELEG-04).
 */
export const NON_DELEGABLE_SCOPES = [
  "sternsystem.handover",
  "nachweis.sign",
  "nachweis.timestamp",
  "cloudflare.token",
  "fleet.claims.merge",
] as const;

const isoDatetime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: "must be an ISO-8601 datetime",
});

export const delegationEntrySchema = z
  .object({
    id: z.string().regex(/^del-[0-9]{4,}$/),
    scope: z.string().min(1),
    grantedTo: z.string().regex(AGENT_OR_WILDCARD_PATTERN),
    grantedBy: z.string().regex(HUMAN_ID_PATTERN),
    sites: z.union([z.literal("workspace"), z.array(z.string().min(1)).min(1)]),
    grantedAt: isoDatetime,
    expiresAt: isoDatetime.nullish(),
    revokedAt: isoDatetime.nullish(),
    revokedBy: z.string().regex(HUMAN_ID_PATTERN).optional(),
    note: z.string().optional(),
    /** Optional `--sign` provenance: "ed25519:<publicKeyHex>:<signatureHex>". */
    signature: z.string().optional(),
  })
  .strict();

export const authorityDelegationsSchema = z
  .object({
    schema: z.literal(AUTHORITY_DELEGATIONS_SCHEMA_ID),
    delegations: z.array(delegationEntrySchema).default([]),
  })
  .strict();

export type DelegationEntry = z.infer<typeof delegationEntrySchema>;
export type AuthorityDelegations = z.infer<typeof authorityDelegationsSchema>;

export class DelegationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationRegistryError";
  }
}

export function delegationsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DELEGATIONS_FILENAME);
}

/** True when the scope string names a delegable scope (catalogue or bordbuch.*). */
export function isDelegableScope(scope: string): boolean {
  return (
    (DELEGABLE_SCOPES as readonly string[]).includes(scope) ||
    scope.startsWith(BORDBUCH_SCOPE_PREFIX)
  );
}

/**
 * Load the delegation registry. An absent file means zero delegations (RFC-1336:
 * the file is optional); parse/schema failures are load-bearing and throw
 * DelegationRegistryError — a corrupted registry must never silently resolve
 * to "no delegations" or every gate disarms.
 */
export async function loadDelegations(
  workspaceRoot: string,
  io?: WorkspaceIO,
): Promise<AuthorityDelegations> {
  const effectiveIo = resolveIo(io);
  const filePath = delegationsPath(workspaceRoot);
  let source: string;
  try {
    source = await effectiveIo.readFile(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: AUTHORITY_DELEGATIONS_SCHEMA_ID, delegations: [] };
    }
    throw new DelegationRegistryError(
      `cannot read ${DELEGATIONS_FILENAME}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e) {
    throw new DelegationRegistryError(
      `${DELEGATIONS_FILENAME} is not parseable YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = authorityDelegationsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new DelegationRegistryError(`${DELEGATIONS_FILENAME} schema violation — ${issues}`);
  }
  return parsed.data;
}

const REGISTRY_HEADER = `# Operator authority delegations (RFC-1336) — ${AUTHORITY_DELEGATIONS_SCHEMA_ID}
# Human-granted, scoped, revocable powers for agent delegates.
# Agents MUST NOT edit this file — grants and revocations go through
# authority.delegate / authority.delegate.revoke (operator-only).
`;

/** Serialize a registry for write-back — canonical header, stable key order. */
export function serializeDelegations(registry: AuthorityDelegations): string {
  return REGISTRY_HEADER + YAML.stringify(registry);
}

/**
 * The bytes a `--sign` signature covers: canonical JSON of the entry without
 * its signature field (imported here so signers and verifiers share one
 * canonicalization — signing.ts owns the crypto).
 */
export function canonicalDelegationPayload(entry: DelegationEntry): string {
  const { signature: _signature, ...rest } = entry;
  return canonicalJson(rest);
}

/**
 * Query a loaded registry for an active grant. A delegation is active when it
 * is not revoked and not expired (expiresAt strictly in the future, or null).
 * `grantedBy` binds the query to the grantor when the caller already knows
 * which human must have authorized the act; `site` limits the match to grants
 * covering that site (`sites: "workspace"` covers all). Multiple matches
 * resolve to the most recently granted entry.
 */
export interface DelegationQuery {
  scope: string;
  /**
   * Acting agent identity — "agent:<id>". When omitted the query is an
   * existence check: any active grant covering scope+site matches regardless
   * of grantee (used by precondition helpers that only need to know a
   * delegation exists).
   */
  agent?: string;
  /** Site the operation targets; absent means a workspace-scope operation. */
  site?: string;
  /** When set, only grants recorded by this human match (grantor binding). */
  grantedBy?: string;
}

export function resolveDelegation(
  registry: AuthorityDelegations,
  query: DelegationQuery,
  now: Date = new Date(),
): DelegationEntry | null {
  const matches = registry.delegations.filter((d) => {
    if (d.scope !== query.scope) return false;
    if (d.revokedAt) return false;
    if (d.expiresAt && new Date(d.expiresAt).getTime() <= now.getTime()) return false;
    if (query.agent !== undefined && d.grantedTo !== query.agent && d.grantedTo !== "agent:*") {
      return false;
    }
    if (query.grantedBy !== undefined && d.grantedBy !== query.grantedBy) return false;
    if (d.sites === "workspace") return true;
    return query.site !== undefined && d.sites.includes(query.site);
  });
  if (matches.length === 0) return null;
  // Most specific grantee first (an explicit agent:<id> beats the wildcard),
  // then most recently granted.
  const specificity = (d: DelegationEntry) => (d.grantedTo === "agent:*" ? 0 : 1);
  return matches.reduce((a, b) =>
    specificity(a) !== specificity(b)
      ? specificity(a) > specificity(b)
        ? a
        : b
      : a.grantedAt >= b.grantedAt
        ? a
        : b,
  );
}

/**
 * The actor identity a delegated operation records. A grant to an explicit
 * `agent:<id>` names its actor; a wildcard `agent:*` grant requires the caller
 * to supply the session's agent id so provenance stays specific.
 */
export function delegationActor(grant: DelegationEntry, sessionAgentId?: string): string | null {
  if (grant.grantedTo !== "agent:*") return grant.grantedTo;
  if (sessionAgentId && AGENT_ID_PATTERN.test(sessionAgentId)) return sessionAgentId;
  return null;
}
