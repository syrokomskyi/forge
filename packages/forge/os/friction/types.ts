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
  <item>RFC-1433: os/friction module, friction.validate, retro autopsy + RFC fast-path

Add friction.validate (FRICTION-01..05, contract frictions) over the
append-only docs/frictions.yaml registry; absent file passes with
entries: 0 per lazy-creation contract. fo-session-retro gains the
autopsy step (signal checklist, signature matching, harvest mode +
triggerPhrases) and fo-idea-create-rfc the friction fast-path. Module
registered in bin/cli.ts, WORKSHOP_MODULE_MAP.forge, package.json
exports; AGENTS.md module row; 13 vitest cases.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

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
  signature: z.string().min(1),
  // measure is deliberately not min(1) — an empty measure on an open entry
  // is a FRICTION-04 warning, not a schema failure.
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

export interface FrictionValidateResult {
  command: "friction.validate";
  status: "pass" | "fail";
  file: string;
  entries: number;
  errors: import("../../src/types.ts").Diagnostic[];
  warnings: import("../../src/types.ts").Diagnostic[];
}
