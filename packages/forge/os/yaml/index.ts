/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge yaml module — re-exports yaml.scalars.validate and the shared collector (RFC-1478).</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1478: initial barrel export — collectScalarTraps is shared with the ecosystem.commit staged-YAML gate (werkstatt-site).</item>
  <item>RFC-1478: yaml.scalars.validate + EC-25 colon-space staged lint (F-0006)</item>
</CHANGE_SUMMARY>
*/

export { createForgeYamlModule } from "./yaml.module.ts";
export {
  collectScalarTraps,
  runYamlScalarsValidate,
  yamlScalarCandidateSkipped,
} from "./handlers/scalars-validate.ts";
export type {
  ScalarTrap,
  YamlScalarsValidateResult,
} from "./handlers/scalars-validate.ts";
