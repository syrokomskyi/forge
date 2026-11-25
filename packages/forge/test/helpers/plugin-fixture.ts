/* Shared plugin fixture — scaffold a minimal plugin package in a tmp dir. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function scaffoldPlugin(dir: string, overrides: { forgeRange?: string; manifestExtra?: string; files?: Record<string, string> } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "forge.plugin.yaml"),
    `schema: forge:plugin-manifest/v1
id: test-plugin
version: 1.0.0
forgeRange: ${overrides.forgeRange ?? "^10.0.0"}
capabilities:
  filesystem: read
  processSpawn: false
  network: false
  gitMutation: false
registers:
  commands:
    - command.js
${overrides.manifestExtra ?? ""}`,
  );
  writeFileSync(
    join(dir, "command.js"),
    `export default {
  id: "test.ping",
  scope: "repo",
  description: "test command",
  async run() { return { status: "pass" }; },
};
`,
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0", dependencies: {} }, null, 2));
  for (const [path, content] of Object.entries(overrides.files ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
