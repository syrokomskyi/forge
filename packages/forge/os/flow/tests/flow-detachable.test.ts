/*
<MODULE_CONTRACT>
<purpose>RFC-1573 AC-1 — the forge flow commands that run the integration gate declare `detachable: true`, and the short flow commands stay attached-only.</purpose>
<non-goals>
  <item>No --detach mechanics — RFC-1568's gate-run tests own spawning and records.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: requirement AC-1 (RFC-1573)
import { describe, expect, it } from "vitest";

import { createForgeFlowModule } from "../flow.module.ts";

describe("RFC-1573: flow detachable declarations", () => {
  it("declares detachable on each long-gate flow command", async () => {
    const mod = await createForgeFlowModule();
    for (const name of ["flow.cut", "flow.backmerge", "flow.integrate"]) {
      const cmd = mod.commands.find((c) => c.name === name);
      expect(cmd?.detachable, `${name} reaches integrateFlowBranch and must declare detachable: true`).toBe(true);
    }
  });

  it("keeps short flow commands attached-only", async () => {
    const mod = await createForgeFlowModule();
    for (const name of ["flow.open", "flow.fix", "flow.status", "flow.digest"]) {
      const cmd = mod.commands.find((c) => c.name === name);
      expect(cmd, `${name} must stay registered`).toBeDefined();
      expect(cmd?.detachable, `${name} returns quickly and must not be detachable (RFC-1573 non-goal)`).toBeUndefined();
    }
  });
});
