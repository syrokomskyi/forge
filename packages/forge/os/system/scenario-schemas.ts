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
  <item>RFC-1541: version-set@2 contracts with validator and pin-drift scenario checks</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export const SYSTEM_SCENARIOS_DIR = "system/scenarios";
export const SYSTEM_VERSION_SETS_DIR = "system/version-sets";

/**
 * RFC-1541: a scenario check is an argv run (default — a check without `kind`
 * is `argv`, so RFC-1511 scenarios parse unchanged), a published-validator
 * conformance run (`validator`), or a contract pin-drift comparison
 * (`pin-drift`, warning-only).
 */
export const argvCheckSchema = z
  .object({
    kind: z.literal("argv"),
    product: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    timeoutSec: z.number().int().positive().default(600),
  })
  .strict();

export const validatorCheckSchema = z
  .object({
    kind: z.literal("validator"),
    product: z.string().min(1),
    producer: z.string().min(1),
    timeoutSec: z.number().int().positive().default(900),
  })
  .strict();

export const pinDriftCheckSchema = z
  .object({
    kind: z.literal("pin-drift"),
    /** Contract id the authority offers (products.yaml offers). */
    contract: z.string().min(1),
    /** npm package name the contract is published as. */
    package: z.string().min(1),
    authority: z.string().min(1),
    maxLag: z.number().int().positive(),
  })
  .strict();

export const scenarioCheckSchema = z.preprocess(
  (raw) =>
    raw !== null && typeof raw === "object" && !("kind" in raw) ? { kind: "argv", ...raw } : raw,
  z.discriminatedUnion("kind", [argvCheckSchema, validatorCheckSchema, pinDriftCheckSchema]),
);

export type ScenarioCheck = z.infer<typeof scenarioCheckSchema>;
export type ArgvCheck = z.infer<typeof argvCheckSchema>;
export type ValidatorCheck = z.infer<typeof validatorCheckSchema>;
export type PinDriftCheck = z.infer<typeof pinDriftCheckSchema>;

export const systemScenarioSchema = z
  .object({
    schema: z.literal("forge/system-scenario@1"),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().min(1),
    products: z.array(z.string().min(1)).min(1),
    contracts: z.array(z.string().min(1)).default([]),
    checks: z.array(scenarioCheckSchema).min(1),
  })
  .strict();

export type SystemScenario = z.infer<typeof systemScenarioSchema>;

export const versionSetV1Schema = z
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

/**
 * RFC-1541: @2 adds `contracts` (product → package → exact version, resolved
 * from each tag's root lockfile importer) and warning-only `warnings[]`
 * (pin drift). Recorded @1 files are immutable evidence and stay readable.
 */
export const versionSetV2Schema = z
  .object({
    schema: z.literal("forge/version-set@2"),
    id: z.string().regex(/^VS-\d{4}$/),
    products: z.record(z.string(), z.string().min(1)),
    contracts: z.record(
      z.string(),
      z.record(
        z.string(),
        z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/),
      ),
    ),
    scenarios: z.array(z.string().min(1)).min(1),
    evidence: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1),
            product: z.string().min(1).optional(),
            package: z.string().min(1).optional(),
            from: z.string().min(1).optional(),
            to: z.string().min(1).optional(),
            message: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    verifiedAt: z.string().min(1),
  })
  .strict();

export const versionSetSchema = z.union([versionSetV1Schema, versionSetV2Schema]);

export type VersionSetV1 = z.infer<typeof versionSetV1Schema>;
export type VersionSetV2 = z.infer<typeof versionSetV2Schema>;
export type VersionSet = z.infer<typeof versionSetSchema>;
