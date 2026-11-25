/* RFC-1648 AC-2: capability violations are refused at runtime at the SDK ports. */
import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { verifyManifest } from "../src/sdk/loader.ts";
import { CapabilityViolation } from "../src/sdk/types.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

describe("capability enforcement (AC-2)", () => {
  it("processSpawn:false refuses spawn with a capability violation", async () => {
    const root = mkTmp("forge-cap-");
    scaffoldPlugin(root);
    const manifest = verifyManifest(parseYaml(readFileSync(join(root, "forge.plugin.yaml"), "utf8")), root);
    const ctx = createPluginContext(manifest, { workspaceRoot: root });
    await expect(ctx.process.spawn("echo", ["hi"])).rejects.toThrow(CapabilityViolation);
  });

  it("default-deny: omitted capabilities receive nothing", async () => {
    const root = mkTmp("forge-capdeny-");
    scaffoldPlugin(root);
    const manifest = verifyManifest(parseYaml(readFileSync(join(root, "forge.plugin.yaml"), "utf8")), root);
    const ctx = createPluginContext(manifest, { workspaceRoot: root });
    // network not declared → refused
    await expect(ctx.network.fetch("https://example.com")).rejects.toThrow(CapabilityViolation);
    // gitMutation not granted → mutating op refused
    await expect(ctx.git.exec(["commit", "-m", "x"])).rejects.toThrow(CapabilityViolation);
    // filesystem:read → write refused
    await expect(ctx.workspace.writeFile("x.txt", "y")).rejects.toThrow(CapabilityViolation);
    // read is granted
    await expect(ctx.workspace.readFile("package.json")).resolves.toContain("test-plugin");
  });

  it("read-only git ops pass when mutation is denied", async () => {
    const root = mkTmp("forge-capgit-");
    scaffoldPlugin(root);
    const manifest = verifyManifest(parseYaml(readFileSync(join(root, "forge.plugin.yaml"), "utf8")), root);
    const ctx = createPluginContext(manifest, { workspaceRoot: root });
    // Non-mutating git is fine even without the mutation grant — will error on non-repo but not on capability.
    await expect(ctx.git.exec(["status"])).rejects.toThrow(/not a git repository|fatal/);
  });
});
