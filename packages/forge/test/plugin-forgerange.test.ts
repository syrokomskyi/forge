/* RFC-1648 AC-1: forgeRange violation refuses load with a typed incompatibility error. */
import { describe, expect, it } from "vitest";

import { loadPlugin } from "../src/sdk/loader.ts";
import { PluginLoadError } from "../src/sdk/types.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("plugin forgeRange (AC-1)", () => {
  it("incompatible range refuses load with typed error", async () => {
    const root = mkTmp("forge-plug-range-");
    scaffoldPlugin(root, { forgeRange: "^9.0.0" });
    await expect(loadPlugin(root, root, { workspaceRoot: root })).rejects.toSatisfy(
      (e) => e instanceof PluginLoadError && e.kind === "forgerange-violation",
    );
  });

  it("compatible range loads cleanly", async () => {
    const root = mkTmp("forge-plug-ok-");
    scaffoldPlugin(root, { forgeRange: "^10.0.0" });
    const loaded = await loadPlugin(root, root, { workspaceRoot: root });
    expect(loaded.manifest.id).toBe("test-plugin");
    expect(loaded.commands).toHaveLength(1);
  });

  it("missing forgeRange refuses as invalid manifest", async () => {
    const root = mkTmp("forge-plug-norange-");
    scaffoldPlugin(root, { forgeRange: "" });
    // Empty range string — manifest invalid (required field).
    await expect(loadPlugin(root, root, { workspaceRoot: root })).rejects.toThrow(PluginLoadError);
  });
});
