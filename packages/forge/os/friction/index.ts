/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge friction module — re-exports friction.validate and its schema (RFC-1433).</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial barrel export.</item>
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

export { createForgeFrictionModule } from "./friction.module.ts";
export {
  frictionEntrySchema,
  frictionsRegistrySchema,
  FRICTION_CATEGORIES,
  FRICTION_ID_PATTERN,
  FRICTION_STATUSES,
} from "./types.ts";
export type { FrictionEntry, FrictionsRegistry, FrictionValidateResult } from "./types.ts";
