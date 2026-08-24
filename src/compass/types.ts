/*
<MODULE_CONTRACT>
<purpose>Compass contract block spec types for plugin-extensible Compass validation (RFC-0943). Declarative data contracts only — no executable hooks.</purpose>
<non-goals>
  <item>Do not define validate() functions — block specs are declarative data, interpreted by compass.validate.</item>
  <item>Do not import from os/ or kernel modules — this is a portable contract module.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0943: initial CompassContractBlockSpec and CompassContractExtensionPoint types.</item>
</CHANGE_SUMMARY>
*/

export interface CompassContractRequiredTag {
  name: string;
  minWords?: number;
}

export interface CompassContractBlockSpec {
  blockId: string;
  requiredFor: string[];
  requiredTags?: CompassContractRequiredTag[];
}

export interface CompassContractExtensionPoint {
  blocks: CompassContractBlockSpec[];
}

export interface CompassContractRegistryEntry extends CompassContractBlockSpec {
  packId: string;
}

export interface CompassContractRegistry {
  builtIn: CompassContractBlockSpec[];
  pack: CompassContractRegistryEntry[];
}

export interface CompassContractValidationDiagnostic {
  ruleId: string;
  severity: string;
  file: string;
  message: string;
  fix: string;
  pack?: string;
}
