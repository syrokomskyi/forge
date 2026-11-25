/* WP-8 regression: project-local plugin manifests may declare .ts source paths —
   Node strip-types imports them with no build step (erasable syntax only). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPlugin } from "../src/sdk/loader.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("plugin .ts source loading (project-local zero-build contract)", () => {
  it("loads a command module declared as a .ts source path", async () => {
    const consumer = mkTmp("forge-consumer-");
    const pluginDir = join(consumer, "packages", "test-plugin");
    mkdirSync(join(pluginDir, "src", "commands"), { recursive: true });
    writeFileSync(
      join(pluginDir, "forge.plugin.yaml"),
      `schema: forge:plugin-manifest/v1
id: test-plugin
version: 1.0.0
forgeRange: ^10.0.0
capabilities:
  filesystem: read
  processSpawn: false
  network: false
  gitMutation: false
registers:
  commands:
    - src/commands/ping.ts
`,
    );
    // Erasable typescript only — no parameter properties, no enums, no namespaces.
    writeFileSync(
      join(pluginDir, "src", "commands", "ping.ts"),
      `interface PingResult { status: string; marker: string }
export default {
  id: "test.ts-ping",
  scope: "repo",
  description: "ts source command",
  async run(): Promise<PingResult> {
    return { status: "pass", marker: "loaded-from-ts" };
  },
};
`,
    );
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0", dependencies: {} }));

    const loaded = await loadPlugin("packages/test-plugin", consumer, { workspaceRoot: consumer });
    expect(loaded.commands.map((c) => c.id)).toEqual(["test.ts-ping"]);
    const result = (await loaded.commands[0].run(loaded.ctx, {})) as { status: string; marker: string };
    expect(result.status).toBe("pass");
    expect(result.marker).toBe("loaded-from-ts");
  });

  it("production runtime refuses non-erasable typescript syntax (node subprocess)", async () => {
    // Vitest transpiles .ts in-process, masking the production constraint — the
    // strip-only refusal is a property of the Node runtime the CLI ships on, so
    // this polarity is proven through a real node subprocess.
    const consumer = mkTmp("forge-consumer-");
    const pluginDir = join(consumer, "packages", "bad-plugin");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(
      join(pluginDir, "src", "broken.ts"),
      `class Broken {
  constructor(private readonly x: string) {}
}
export default {
  id: "bad.broken",
  scope: "repo",
  description: "non-erasable",
  async run() { return { status: "pass" }; },
};
`,
    );
    const { execFileSync } = await import("node:child_process");
    let stderr = "";
    try {
      execFileSync(process.execPath, ["-e", `await import("${join(pluginDir, "src", "broken.ts").replace(/\\/g, "/")}")`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      expect.unreachable("non-erasable syntax must refuse under strip-only execution");
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|strip|erasable/i);
  });
});
