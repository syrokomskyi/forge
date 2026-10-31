/*
<MODULE_CONTRACT>
<purpose>Register the friction.validate command with the forge kernel registry (RFC-1433).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/friction-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial module — friction.validate over docs/frictions.yaml
  with rules FRICTION-01..05; read-only, invoked by the session-retro autopsy
  step and ad-hoc.</item>
  <item>RFC-1433: os/friction module, friction.validate, retro autopsy + RFC fast-path

Add friction.validate (FRICTION-01..05, contract frictions) over the
append-only docs/frictions.yaml registry; absent file passes with
entries: 0 per lazy-creation contract. fo-session-retro gains the
autopsy step (signal checklist, signature matching, harvest mode +
triggerPhrases) and fo-idea-create-rfc the friction fast-path. Module
registered in bin/cli.ts, WORKSHOP_MODULE_MAP.forge, package.json
exports; AGENTS.md module row; 13 vitest cases.</item>
  <item>RFC-1433: realign friction.validate rules to the accepted spec table

Independent review H1 finding: rule ids/severities were remapped vs the
accepted failure-modes table. FRICTION-01 shape+id, 02 category, 03
status+addressed-artifacts (fail), 04 ordering (fail, unconditional),
05 signature/artifact hygiene (warn). Output emits the documented
violations[] shape; invented open-measure warn dropped; dead
FRICTION_RULE_IDS export consumed by the module; 17 tests.</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeFrictionModule(): Promise<ForgeModule> {
  const { runFrictionValidate } = await import("./handlers/friction-validate.ts");
  return {
    name: "forge-friction",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "friction.validate",
        description:
          "Validate the append-only friction registry (docs/frictions.yaml). " +
          "FRICTION-01 fails on unreadable/unparseable files, entry-shape " +
          "violations, and malformed or duplicate ids; FRICTION-02 on " +
          "categories outside the closed catalog; FRICTION-03 on bad status " +
          "or addressed entries without artifacts; FRICTION-04 on " +
          "lastSeen before created or negative recurrences; FRICTION-05 " +
          "warns on empty/non-normalized signatures and unresolvable " +
          "artifact paths. An absent registry passes with entries: 0 — " +
          "the file is created lazily by the session-retro autopsy step. " +
          "Read-only.",
        scope: "workspace",
        contract: "frictions",
        rules: [{ id: "FRICTION-01", severity: "error" }, { id: "FRICTION-02", severity: "error" }, { id: "FRICTION-03", severity: "error" }, { id: "FRICTION-04", severity: "error" }, { id: "FRICTION-05", severity: "error" }],
        mutatesState: false,
        execOnReadOnly: true,
        reads: ["docs/frictions.yaml"],
        cacheable: false,
        flags: {},
        execute: runFrictionValidate,
      },
    ],
    pipelines: [],
  };
}
