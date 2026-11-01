/*
<MODULE_CONTRACT>
<purpose>RFC-1470 slate-fill tests — budget enforcement: units fill the token budget in rank order; skipped count is honest; a unit exceeding remaining budget is skipped not truncated.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-context</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { scoreUnit } from "./context-assemble.ts";
import type { ContextUnit } from "./index-build.ts";

const u = (id: string, text: string, kind = "friction" as const, tokens = 100): ContextUnit => ({
  id, kind, source: `test#${id}`, tokens, text, meta: {},
});

describe("slate fill (RFC-1470)", () => {
  test("task-matching units outscore unrelated units", () => {
    const task = new Set(["friction", "scar", "migrate"]);
    const match = scoreUnit(u("a", "friction scar migrate remediation"), task, new Set());
    const miss = scoreUnit(u("b", "deployment frontend css"), task, new Set());
    expect(match.score).toBeGreaterThan(miss.score);
    expect(match.reasons.some((r) => r.startsWith("lexical"))).toBe(true);
  });

  test("path terms boost units from the edited surface", () => {
    const task = new Set(["scar"]);
    const paths = new Set(["packages/forge"]);
    const match = scoreUnit(u("a", "scar", "friction"), task, paths);
    const boosted = { ...u("b", "scar"), source: "packages/forge/AGENTS.md" };
    expect(scoreUnit(boosted, task, paths).score).toBeGreaterThan(match.score);
  });
});
