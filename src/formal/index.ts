/*
<MODULE_CONTRACT>
<purpose>RFC-1391: public surface of @warpgogol/forge/formal — proof-spec schema, verdict types, and the built-in exhaustive runner.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: initial formal-tier export.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
</CHANGE_SUMMARY>
*/

export { PROOF_SPEC_SCHEMA_ID, proofSpecSchema } from "./proof-spec.ts";
export type { ProofCheckResult, ProofSpec, ProofVerdict } from "./proof-spec.ts";
export {
  EXHAUSTIVE_TOOL_VERSION,
  exhaustive,
  ExhaustiveDomainError,
  ExhaustiveRefutedError,
  exhaustiveVerdict,
  FORGE_PROOF_REPORT_ENV,
} from "./exhaustive.ts";
export type { ExhaustiveCheck, ExhaustiveFailure, ExhaustiveResult } from "./exhaustive.ts";
export { PROOF_CHECK_DEFAULT_TIMEOUT_MS, runProofCheck } from "./proof-runner.ts";
export type { RunProofCheckOptions, SpawnFn, SpawnOutcome } from "./proof-runner.ts";
