/*
<MODULE_CONTRACT>
<purpose>RFC-1573 review C-1 — loadForgeCommandModules() is the single forge command-module list: non-empty, every command name unique, and it carries the RFC-1568/RFC-1573 detachable set.</purpose>
<non-goals>
  <item>No CLI dispatch — bin-entry tests own the executable surface.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: regression single-list drift between bin/cli.ts and agents-generate (RFC-1573 review C-1)
import { describe, expect, it } from "vitest";
import { loadForgeCommandModules } from "../command-modules.ts";

describe("loadForgeCommandModules (RFC-1573)", () => {
  it("returns modules with unique command names", async () => {
    const names = (await loadForgeCommandModules()).flatMap((m) => m.commands.map((c) => c.name));
    expect(names.length).toBeGreaterThan(0);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, "duplicate forge command names would collide in buildRegistry()").toEqual([]);
  });

  it("carries the forge detachable set", async () => {
    const detachable = (await loadForgeCommandModules())
      .flatMap((m) => m.commands)
      .filter((c) => c.detachable === true)
      .map((c) => c.name)
      .sort();
    expect(detachable).toEqual([
      "flow.backmerge",
      "flow.cut",
      "flow.integrate",
      "rfc.implement.stamp",
    ]);
  });
});
