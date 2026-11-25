/* Extended filesystem ports — deploy extraction surface (rm/rename/stat/readFileBytes). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(fs: "none" | "read" | "readwrite", root: string) {
  const manifest: PluginManifest = {
    id: "fs-ext",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: { filesystem: fs, processSpawn: false, network: false, gitMutation: false },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: root });
}

describe("extended filesystem ports", () => {
  it("rename + rm + stat + readFileBytes roundtrip", async () => {
    const root = mkTmp("forge-fsext-");
    writeFileSync(join(root, "a.bin"), Buffer.from([1, 2, 3]));
    const c = ctx("readwrite", root);
    await c.workspace.rename("a.bin", "b.bin");
    expect(await c.workspace.exists("a.bin")).toBe(false);
    expect(await c.workspace.exists("b.bin")).toBe(true);
    expect([...(await c.workspace.readFileBytes("b.bin"))]).toEqual([1, 2, 3]);
    const st = await c.workspace.stat("b.bin");
    expect(st.size).toBe(3);
    expect(st.isDirectory).toBe(false);
    await c.workspace.rm("b.bin");
    expect(await c.workspace.exists("b.bin")).toBe(false);
  });
  it("rm recursive removes trees", async () => {
    const root = mkTmp("forge-fsext-");
    mkdirSync(join(root, "tree", "sub"), { recursive: true });
    writeFileSync(join(root, "tree", "sub", "f.txt"), "x");
    const c = ctx("readwrite", root);
    await c.workspace.rm("tree", { recursive: true });
    expect(await c.workspace.exists("tree")).toBe(false);
  });
  it("read grant reads but cannot mutate", async () => {
    const root = mkTmp("forge-fsext-");
    writeFileSync(join(root, "f.bin"), "xy");
    const c = ctx("read", root);
    expect((await c.workspace.stat("f.bin")).size).toBe(2);
    expect([...(await c.workspace.readFileBytes("f.bin"))].length).toBe(2);
    await expect(c.workspace.rename("f.bin", "g.bin")).rejects.toThrow(CapabilityViolation);
    await expect(c.workspace.rm("f.bin")).rejects.toThrow(CapabilityViolation);
  });
  it("none grant refuses stat and readFileBytes", async () => {
    const root = mkTmp("forge-fsext-");
    const c = ctx("none", root);
    await expect(c.workspace.stat("f")).rejects.toThrow(CapabilityViolation);
    await expect(c.workspace.readFileBytes("f")).rejects.toThrow(CapabilityViolation);
  });
});
