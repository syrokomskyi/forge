/*
<MODULE_CONTRACT>
<purpose>Schema contracts for business scenarios and verified version sets
(RFC-1511): forge/system-scenario@1 names products, contracts and argv checks;
forge/version-set@1 records the release-tag combination that passed every
named scenario with sha256 evidence per scenario.</purpose>
<non-goals>
  <item>No command behavior — handlers live in os/system/handlers/.</item>
  <item>No scheduling of scenario runs and no published-package pins (stage 3).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A check is { product, argv, timeoutSec } run with no shell — argv vectors only (DNA-89).</item>
  <item>evidence maps scenario id to sha256 of that scenario's concatenated check logs — a set exists only for a run that passed (DNA-106).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1511: step 2 — scenario and version-set schemas</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export const SYSTEM_SCENARIOS_DIR = "system/scenarios";
export const SYSTEM_VERSION_SETS_DIR = "system/version-sets";

export const systemScenarioSchema = z
  .object({
    schema: z.literal("forge/system-scenario@1"),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().min(1),
    products: z.array(z.string().min(1)).min(1),
    contracts: z.array(z.string().min(1)).default([]),
    checks: z
      .array(
        z
          .object({
            product: z.string().min(1),
            argv: z.array(z.string().min(1)).min(1),
            timeoutSec: z.number().int().positive().default(600),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type SystemScenario = z.infer<typeof systemScenarioSchema>;

export const versionSetSchema = z
  .object({
    schema: z.literal("forge/version-set@1"),
    id: z.string().regex(/^VS-\d{4}$/),
    /** product id -> release tag */
    products: z.record(z.string(), z.string().min(1)),
    scenarios: z.array(z.string().min(1)).min(1),
    evidence: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
    verifiedAt: z.string().min(1),
  })
  .strict();

export type VersionSet = z.infer<typeof versionSetSchema>;
