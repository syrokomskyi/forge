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
          "FRICTION-01 fails on unreadable/unparseable/schema-broken files, " +
          "FRICTION-02 on malformed or duplicate ids, FRICTION-03 on " +
          "out-of-enum category/status values; FRICTION-04/05 warn on " +
          "hygiene issues (open entry without a measure, addressed entry " +
          "without artifacts, lastSeen before created). An absent registry " +
          "passes with entries: 0 — the file is created lazily by the " +
          "session-retro autopsy step (RFC-1433). Read-only.",
        scope: "workspace",
        contract: "frictions",
        rules: [
          "FRICTION-01",
          "FRICTION-02",
          "FRICTION-03",
          "FRICTION-04",
          "FRICTION-05",
        ],
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
