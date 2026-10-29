/*
<MODULE_CONTRACT>
<purpose>Friction registry schema (RFC-1433) — docs/frictions.yaml entry and
registry shapes, closed category/status enums, FRICTION-* rule ids, and the
result type for friction.validate.</purpose>
<non-goals>
  <item>Do not implement validation logic — that lives in handlers/friction-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial registry schema — append-only frictions with
  signature-based recurrence matching (open | addressed), five closed
  categories, FRICTION-01..05 rule ids.</item>
  <item>RFC-1433: review realignment — signature demoted to optional
  (empty is a FRICTION-05 warn, not a schema failure); result shape moved
  to the spec's violations[] contract.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

import type { Diagnostic } from "../../src/types.ts";

export const FRICTION_CATEGORIES = [
  "tooling",
  "docs",
  "process",
  "environment",
  "self",
] as const;
export type FrictionCategory = (typeof FRICTION_CATEGORIES)[number];

export const FRICTION_STATUSES = ["open", "addressed"] as const;
export type FrictionStatus = (typeof FRICTION_STATUSES)[number];

export const FRICTION_ID_PATTERN = /^F-\d{4}$/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const frictionEntrySchema = z.object({
  id: z.string().regex(FRICTION_ID_PATTERN),
  created: z.string().regex(DATE_PATTERN),
  session: z.string().min(1),
  category: z.enum(FRICTION_CATEGORIES),
  friction: z.string().min(1),
  // signature is deliberately not min(1) — empty or non-normalized values
  // are FRICTION-05 warnings, not schema failures.
  signature: z.string().default(""),
  measure: z.string().default(""),
  artifacts: z.array(z.string().min(1)).default([]),
  status: z.enum(FRICTION_STATUSES),
  recurrences: z.number().int().min(0),
  lastSeen: z.string().regex(DATE_PATTERN),
});
export type FrictionEntry = z.infer<typeof frictionEntrySchema>;

export const frictionsRegistrySchema = z.array(frictionEntrySchema);
export type FrictionsRegistry = z.infer<typeof frictionsRegistrySchema>;

export const FRICTION_RULE_IDS = [
  "FRICTION-01",
  "FRICTION-02",
  "FRICTION-03",
  "FRICTION-04",
  "FRICTION-05",
] as const;
export type FrictionRuleId = (typeof FRICTION_RULE_IDS)[number];

/** A violation in the spec's documented shape — rule + optional entry id + severity. */
export interface FrictionViolation {
  rule: string;
  entry?: string;
  severity: "error" | "warning";
  message: string;
}

export interface FrictionValidateResult {
  command: "friction.validate";
  status: "pass" | "fail";
  registry: string;
  entries: number;
  violations: FrictionViolation[];
  /** Same violations split by severity — Diagnostic-shaped for house tooling. */
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
