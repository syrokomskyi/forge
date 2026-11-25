/*
CLI-plugin bridge proof — consumer plugins discovered from forge.yaml register
as first-class CLI commands through the standard SDK loader path (RFC-1648).
*/
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adaptCommand, discoverPluginEntries, loadConsumerPlugins } from "../src/sdk/cli-bridge.ts";

function makeConsumerWithPlugin(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-bridge-test-"));
  const pluginDir = join(root, "tools", "my-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "forge.plugin.yaml"),
    [
      "schema: forge:plugin-manifest/v1",
      "id: test-plugin",
      "version: 1.0.0",
      "forgeRange: \">=10.0.0\"",
      "capabilities:",
      "  filesystem: read",
      "registers:",
      "  commands:",
      "    - hello.mjs",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(pluginDir, "hello.mjs"),
    `export default {
      id: "test.hello",
      description: "say hello",
      scope: "workspace",
      async run() {
        return { status: "pass", message: "hello from plugin" };
      },
    };
    `,
  );
  writeFileSync(join(root, "forge.yaml"), "plugins:\n  - ./tools/my-plugin\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("cli-plugin bridge", () => {
  it("discovers plugin entries from forge.yaml", () => {
    const { root, cleanup } = makeConsumerWithPlugin();
    try {
      expect(discoverPluginEntries(root)).toEqual(["./tools/my-plugin"]);
      expect(discoverPluginEntries(join(root, "nonexistent"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("loads plugins and adapts commands into CLI shape", async () => {
    const { root, cleanup } = makeConsumerWithPlugin();
    try {
      const { plugins, report } = await loadConsumerPlugins(root);
      expect(report.failed).toEqual([]);
      expect(report.loaded).toHaveLength(1);
      expect(report.loaded[0].pluginId).toBe("test-plugin");
      expect(report.loaded[0].commands).toEqual(["test.hello"]);

      const adapted = adaptCommand(plugins[0].commands[0], plugins[0].ctx, plugins[0].manifest.id);
      expect(adapted.name).toBe("test.hello");
      expect(adapted.scope).toBe("workspace");
      expect(adapted.description).toContain("[test-plugin]");

      const result = await adapted.execute(
        { argv: [], flags: {} },
        {} as never,
      );
      expect(result?.exitCode).toBe(0);
      expect(result?.summary).toBe("hello from plugin");
    } finally {
      cleanup();
    }
  });

  it("reports failures loudly without blocking other plugins", async () => {
    const { root, cleanup } = makeConsumerWithPlugin();
    try {
      writeFileSync(join(root, "forge.yaml"), "plugins:\n  - ./tools/my-plugin\n  - ./tools/missing-plugin\n");
      const { plugins, report } = await loadConsumerPlugins(root);
      expect(plugins).toHaveLength(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].entry).toBe("./tools/missing-plugin");
      expect(report.failed[0].error).toContain("unresolvable");
    } finally {
      cleanup();
    }
  });
});
