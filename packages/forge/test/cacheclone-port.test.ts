/* cacheClone spaces port — read-only access to the systems-cache sibling tree
   (<workspaceRoot>/../systems-cache). Decisive cases: reads resolve across the
   sibling boundary; writes always deny (the cache is sync-owned); escape and
   undeclared-grant refusal match the other spaces. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(grant: "none" | "read" | undefined, root: string) {
  const manifest: PluginManifest = {
    id: "cache-clone-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: {
      filesystem: "read",
      processSpawn: false,
      network: false,
      gitMutation: false,
      ...(grant ? { cacheClone: grant } : {}),
    },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: root });
}

/* Layout: <parent>/werkstatt (workspace root) + <parent>/systems-cache/<sys>. */
function seedSiblingLayout() {
  const parent = mkTmp("cc-parent-");
  const wt = join(parent, "werkstatt");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(parent, "systems-cache", "dp7"), { recursive: true });
  writeFileSync(join(parent, "systems-cache", "dp7", "system-state.yaml"), "lastRelease: dp7-r000123\n");
  return { parent, wt };
}

describe("cacheClone port", () => {
  it("reads system state across the sibling boundary", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx("read", wt);
    expect(await c.cacheClone.exists("dp7/system-state.yaml")).toBe(true);
    expect(await c.cacheClone.readFile("dp7/system-state.yaml")).toBe("lastRelease: dp7-r000123\n");
    // workspace port cannot see it — boundary intact
    expect(await c.workspace.exists("dp7/system-state.yaml")).toBe(false);
  });
  it("readdir returns typed entries", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx("read", wt);
    const entries = await c.cacheClone.readdir("dp7");
    const f = entries.find((e) => e.name === "system-state.yaml");
    expect(f!.isFile).toBe(true);
    expect(f!.isDirectory).toBe(false);
  });
  it("writes always deny — the cache is sync-owned", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx("read", wt);
    await expect(c.cacheClone.writeFile("dp7/x", "y")).rejects.toBeInstanceOf(CapabilityViolation);
    await expect(c.cacheClone.mkdir("dp7/y")).rejects.toBeInstanceOf(CapabilityViolation);
    await expect(c.cacheClone.rm("dp7/system-state.yaml")).rejects.toBeInstanceOf(CapabilityViolation);
  });
  it("undeclared grant denies reads", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx(undefined, wt);
    await expect(c.cacheClone.readFile("dp7/system-state.yaml")).rejects.toBeInstanceOf(
      CapabilityViolation,
    );
  });
  it("missing cache tree degrades exists to false", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx("read", wt);
    expect(await c.cacheClone.exists("nonexistent/system-state.yaml")).toBe(false);
  });
  it("path escape outside the cache root is refused", async () => {
    const { wt } = seedSiblingLayout();
    const c = ctx("read", wt);
    await expect(c.cacheClone.readFile("../../werkstatt/package.json")).rejects.toBeInstanceOf( // pkg-health-10: deliberate escape probe — the test asserts the port refuses it
      CapabilityViolation,
    );
  });
});
