/*
<MODULE_CONTRACT>
<purpose>RFC-1336: forge-authority — the operator-authority delegation module.
Registers the four authority.* commands: delegate + delegate.revoke
(operator-only writes to the workspace-root registry), delegation.list and
delegation.validate (read-only inspection). Runtime: autonomous — the only
engine touchpoint is the optional sibling-invocation port used for Bordbuch
audit events.</purpose>
<non-goals>
  <item>Do not implement consumer gates here — signoff, bordbuch.append, ecosystem.commit, onboarding, and rfc.validate consume src/authority/delegations.ts directly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial module — four authority.* commands.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
  <item>RFC-1336: step 5: coverage "operator" declarations — the commands are CLI-invoked by the operator (or read-only by agents), not pipeline-wired; satisfies the reachable acceptance probe.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeAuthorityModule(): Promise<ForgeModule> {
  const { runAuthorityDelegate } = await import("./handlers/delegate.ts");
  const { runAuthorityDelegateRevoke } = await import("./handlers/delegate-revoke.ts");
  const { runAuthorityDelegationList } = await import("./handlers/delegation-list.ts");
  const { runAuthorityDelegationValidate } = await import("./handlers/delegation-validate.ts");
  return {
    name: "forge-authority",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "authority.delegate",
        description:
          "RFC-1336: grant a scoped, site-bounded, expirable authority delegation to an " +
          "agent — writes one entry to authority.delegations.yaml and fans out an " +
          "authority-delegation Bordbuch event per covered site. OPERATOR-ONLY — " +
          "agents MUST NOT run this command; delegated records keep honest provenance " +
          "(reviewer: agent:<id>, delegatedBy, delegationId). " +
          "Required flags: --scope, --to, --by. Mutates the registry.",
        scope: "workspace",
        coverage: "operator" as const,
        coverageNote:
          "operator-invoked via forge/werkstatt CLI; agents MUST NOT run it (RFC-1336 grants are operator-authored)",
        mutatesState: true,
        mutatingFlags: ["scope", "to", "by"],
        reads: ["authority.delegations.yaml"],
        writes: ["authority.delegations.yaml"],
        generates: [],
        cacheable: false,
        modulePath: "packages/forge/os/authority/handlers/delegate.ts",
        flags: {
          scope: {
            kind: "string",
            required: true,
            description:
              "Delegation scope: editorial.signoff | rfc.decision | version.major | onboarding.decision | fleet.notify | bordbuch.<kind>.",
          },
          to: {
            kind: "string",
            required: true,
            description:
              "Delegate identity: agent:<id> (preferred) or the agent:* wildcard (warns).",
          },
          by: {
            kind: "string",
            required: true,
            description: "Granting human: human:<handle>.",
          },
          site: {
            kind: "string[]",
            description:
              "Site id(s) the grant covers — must resolve to systems-cache siblings. Absent means a workspace-scoped grant.",
          },
          expires: {
            kind: "string",
            description: "Optional ISO-8601 expiry; the grant becomes inactive after it.",
          },
          note: {
            kind: "string",
            description: "Free-text reason recorded on the grant.",
          },
          sign: {
            kind: "boolean",
            description:
              "Sign the entry with SIGNING_PRIVATE_KEY (Ed25519) for provenance hardening.",
          },
        },
        execute: runAuthorityDelegate,
      },
      {
        name: "authority.delegate.revoke",
        description:
          "RFC-1336: revoke a delegation by id — stamps revokedAt and fans out an " +
          "authority-delegation-revoked Bordbuch event per covered site. Idempotent. " +
          "OPERATOR-ONLY — agents MUST NOT run this command. Required flags: --id.",
        scope: "workspace",
        coverage: "operator" as const,
        coverageNote:
          "operator-invoked via forge/werkstatt CLI; agents MUST NOT run it (RFC-1336 revocations are operator-authored)",
        mutatesState: true,
        mutatingFlags: ["id"],
        reads: ["authority.delegations.yaml"],
        writes: ["authority.delegations.yaml"],
        generates: [],
        cacheable: false,
        modulePath: "packages/forge/os/authority/handlers/delegate-revoke.ts",
        flags: {
          id: {
            kind: "string",
            required: true,
            description: "Delegation id to revoke (del-NNNN).",
          },
          by: {
            kind: "string",
            description: "Revoking human (human:<handle>) — recorded when given.",
          },
        },
        execute: runAuthorityDelegateRevoke,
      },
      {
        name: "authority.delegation.list",
        description:
          "RFC-1336: list delegations — active grants by default; --history includes " +
          "revoked/expired history, --site filters to grants covering one site. Read-only.",
        scope: "workspace",
        coverage: "operator" as const,
        coverageNote:
          "operator/agent CLI read — not wired into a pipeline; agents may inspect grants",
        mutatesState: false,
        reads: ["authority.delegations.yaml"],
        cacheable: false,
        modulePath: "packages/forge/os/authority/handlers/delegation-list.ts",
        flags: {
          site: {
            kind: "string",
            description: "Only show grants covering this site (or workspace-scoped).",
          },
          history: {
            kind: "boolean",
            description: "Include revoked and expired delegations.",
          },
        },
        execute: runAuthorityDelegationList,
      },
      {
        name: "authority.delegation.validate",
        description:
          "RFC-1336: validate the authority.delegations.yaml registry — schema, " +
          "duplicate ids, non-delegable scopes, agent:* wildcards, site references, " +
          "signature integrity (DELEG-01..08). Read-only.",
        scope: "workspace",
        coverage: "operator" as const,
        coverageNote:
          "operator/agent CLI read — not wired into a pipeline; agents may audit the registry",
        mutatesState: false,
        contract: "authority",
        rules: [
          "DELEG-01",
          "DELEG-02",
          "DELEG-03",
          "DELEG-04",
          "DELEG-05",
          "DELEG-06",
          "DELEG-07",
          "DELEG-08",
        ],
        reads: ["authority.delegations.yaml"],
        cacheable: false,
        modulePath: "packages/forge/os/authority/handlers/delegation-validate.ts",
        flags: {
          site: {
            kind: "string",
            description: "Restrict DELEG-07 site probes to this site id.",
          },
        },
        execute: runAuthorityDelegationValidate,
      },
    ],
    pipelines: [],
  };
}
