/*
<MODULE_CONTRACT>
<purpose>
RFC-1460 AC-4: the fo-session-retro autopsy routing rule — incrementing
`recurrences` on an `addressed` friction entry must route to
`status: escalated` (never a second docs-rule measure on the same entry).
The autopsy is skill-authored behavior, so the test pins the routing rule's
presence in the canonical SKILL.md and the byte-identical .agents twin.
</purpose>
<non-goals>
  <item>Does not execute the autopsy — it is agent-authored prose, not a handler.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1460: session-retro autopsy routing-rule tests.</item>
  <item>RFC-1460: recurring frictions escalate to mechanical measures — FRICTION-06/07/08, registry flips, session-retro escalation</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FORGE_PKG = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CANONICAL = join(FORGE_PKG, "skills/fo/fo-session-retro/SKILL.md");

describe("fo-session-retro autopsy escalation routing (RFC-1460)", () => {
  const skill = readFileSync(CANONICAL, "utf8");

  test("addressed-entry recurrence routes to status: escalated", () => {
    const matchBlock = skill.match(/Match on `addressed`[\s\S]{0,600}/);
    expect(matchBlock, "autopsy lacks the addressed-match routing rule").not.toBeNull();
    expect(matchBlock![0]).toContain("status: escalated");
    expect(matchBlock![0]).toContain("recurrences");
  });

  test("routing rule forbids a second docs-rule measure on the same entry", () => {
    const matchBlock = skill.match(/Match on `addressed`[\s\S]{0,900}/)!;
    expect(matchBlock[0]).toMatch(/NEVER append a second docs-rule measure/i);
  });

  test("routing rule names the mechanical-obligation contract for measure", () => {
    const matchBlock = skill.match(/Match on `addressed`[\s\S]{0,900}/)!;
    expect(matchBlock[0]).toMatch(/RFC\/ADR id|mechanical obligation/);
  });
});
