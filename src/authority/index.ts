/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority barrel — the consumer-facing surface of the
delegation model (schema, loader, resolver, scope catalogue). Werkstatt
engine/site consumers import from @warpgogol/forge/authority.</purpose>
<non-goals>
  <item>Do not re-export signing internals — signature verification is a validator concern (verifyDelegationSignature is importable from ./signing.ts for tests).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial barrel.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
  <item>RFC-1336: delegated rfc.decision/version.major/onboarding.decision + docs (RFC-1336 steps 4-5)</item>
</CHANGE_SUMMARY>
*/

export {
  AGENT_ID_PATTERN,
  AGENT_OR_WILDCARD_PATTERN,
  AUTHORITY_DELEGATIONS_SCHEMA_ID,
  BORDBUCH_SCOPE_PREFIX,
  DELEGABLE_SCOPES,
  DELEGATIONS_FILENAME,
  DelegationRegistryError,
  HUMAN_ID_PATTERN,
  NON_DELEGABLE_SCOPES,
  authorityDelegationsSchema,
  canonicalDelegationPayload,
  delegationActor,
  delegationEntrySchema,
  delegationsPath,
  isDelegableScope,
  loadDelegations,
  normalizeAgentId,
  resolveDelegation,
  serializeDelegations,
} from "./delegations.ts";
export type { AuthorityDelegations, DelegationEntry, DelegationQuery } from "./delegations.ts";
