/* RFC-1648 AC-5: the same plugin loads identically as npm dependency and project-local entry. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPlugin } from "../src/sdk/loader.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("plugin locality equivalence (AC-5)", () => {
  it("npm species and project-local species load through one path with identical capability", async () => {
    const consumer = mkTmp("forge-consumer-");
    // npm species: node_modules/@warpgogol/test-plugin
    const npmDir = join(consumer, "node_modules", "@warpgogol", "test-plugin");
    scaffoldPlugin(npmDir);
    // project-local species: packages/test-plugin — byte-identical content
    const localDir = join(consumer, "packages", "test-plugin");
    scaffoldPlugin(localDir);

    const npmLoaded = await loadPlugin("@warpgogol/test-plugin", consumer, { workspaceRoot: consumer });
    const localLoaded = await loadPlugin("packages/test-plugin", consumer, { workspaceRoot: consumer });

    // Same species: identical manifest, identical command surface, identical capability enforcement.
    expect(npmLoaded.manifest.id).toBe(localLoaded.manifest.id);
    expect(npmLoaded.manifest.capabilities).toEqual(localLoaded.manifest.capabilities);
    expect(npmLoaded.commands.map((c) => c.id)).toEqual(localLoaded.commands.map((c) => c.id));

    // Capability enforcement identical: spawn refused on both.
    await expect(npmLoaded.ctx.process.spawn("echo", [])).rejects.toThrow(/capability violation/);
    await expect(localLoaded.ctx.process.spawn("echo", [])).rejects.toThrow(/capability violation/);
  });
});
