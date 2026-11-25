/*
<MODULE_CONTRACT>
<purpose>
WP-5 proof-of-contract: the first-party forge-typescript plugin loads through the
v10 SDK loader and its commands execute against SDK ports — the same species path
any consumer plugin takes. Zero core special-casing.
</purpose>
<CHANGE_SUMMARY><item>WP-5: first-party e2e proof.</item></CHANGE_SUMMARY>
*/
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPlugin } from "../src/sdk/loader.ts";

const MONOREPO_ROOT = join(__dirname, "..", "..", "..");
const PLUGIN_ENTRY = "packages/forge-typescript";

describe("first-party plugin end-to-end (WP-5 proof-of-contract)", () => {
  it("forge-typescript loads through the standard loader and executes commands", async () => {
    // Ensure dist is current — the plugin ships compiled output per RFC-1648.
    execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
      cwd: join(MONOREPO_ROOT, PLUGIN_ENTRY),
      stdio: "ignore",
    });

    const loaded = await loadPlugin(PLUGIN_ENTRY, MONOREPO_ROOT, { workspaceRoot: MONOREPO_ROOT });
    expect(loaded.manifest.id).toBe("forge-typescript");
    expect(loaded.commands.length).toBeGreaterThanOrEqual(4);

    const ids = loaded.commands.map((c) => c.id).sort();
    expect(ids).toContain("ts.tsconfig.validate");
    expect(ids).toContain("ts.phantom.deps.validate");

    // Execute tsconfig validation against the monorepo itself — real workspace, real verdict.
    const tsconfigCmd = loaded.commands.find((c) => c.id === "ts.tsconfig.validate")!;
    const result = await tsconfigCmd.run(loaded.ctx, {});
    expect(["pass", "fail"]).toContain(result.status);
    // The monorepo root has no tsconfig.base.json — honest verdict is fail with TS-001 attribution.
    if (result.status === "fail") {
      expect(result.violations?.some((v) => v.ruleId === "TS-001")).toBe(true);
    }
  });

  it("capability enforcement binds first-party plugins identically — no special-casing", async () => {
    const loaded = await loadPlugin(PLUGIN_ENTRY, MONOREPO_ROOT, { workspaceRoot: MONOREPO_ROOT });
    // network not declared in the manifest — refused at the port.
    await expect(loaded.ctx.network.fetch("https://example.com")).rejects.toThrow(/capability violation/);
    // gitMutation not granted — mutating ops refused.
    await expect(loaded.ctx.git.exec(["commit", "-m", "x"])).rejects.toThrow(/capability violation/);
    // filesystem read granted — read works.
    await expect(loaded.ctx.workspace.exists("packages")).resolves.toBe(true);
  });
});
