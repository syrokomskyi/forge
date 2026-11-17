/*
<MODULE_CONTRACT>
<purpose>RFC-1616: adversarial scenario contracts — the forge/adversarial-scenario@1
fixture format replayed by `forge adversarial.run` in a scratch clone and the
forge/adversarial-result@1 output shape. Each scenario describes setup commits,
the attack edit, the gate invocation, and the expected refusal rule.</purpose>
<non-goals>
  <item>Does not run scenarios — os/adversarial owns the scratch-clone runner.</item>
  <item>Does not enumerate the catalog — fixtures ship under docs/adversarial/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial contract — adversarialScenarioSchema, AdversarialResult.</item>
  <item>RFC-1616: step 1 — policy-bundle schema + adversarial types

forge/policy-bundle@1 zod contract, canonicalJson + canonicalPolicyDigest (stable-key sha256 over parsed doc + file contents), forge/adversarial-scenario@1 fixture schema and result types.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

/** forge/adversarial-scenario@1 — one replayable attack fixture. */
export const adversarialScenarioSchema = z.object({
  schema: z.literal("forge/adversarial-scenario@1"),
  name: z.string().min(1),
  /** RFC ids / features the scenario targets — informational for --list coverage */
  requires: z.array(z.string()).optional(),
  /** commit descriptions applied to the scratch clone before the attack */
  setup: z.array(z.string()).default([]),
  attack: z.object({
    /** repo-relative path → full file content written by the attack */
    files: z.record(z.string(), z.string()),
    commitMessage: z.string().min(1),
  }),
  /** gate invocation template — e.g. "correctness.gate --base {base} --json" */
  invoke: z.string().min(1),
  expect: z.object({
    status: z.literal("refused"),
    /** expected refusal rule id, e.g. CORR-GATE-02, FLOW-INT-18 */
    rule: z.string().min(1),
  }),
});
export type AdversarialScenario = z.infer<typeof adversarialScenarioSchema>;

export interface AdversarialScenarioResult {
  name: string;
  expected: string;
  /** observed refusal rule, "none" when the attack was not refused, or "error:<why>" */
  observed: string;
  ok: boolean;
}

export interface AdversarialResult {
  command: "adversarial.run";
  scenarios: AdversarialScenarioResult[];
  status: "pass" | "fail";
}
