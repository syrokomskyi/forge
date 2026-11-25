/*
Plugin-skills generation proof — upgrade syncs active plugins' skillsDirs into
the consumer .agents/skills tree through the standard SDK loader path (RFC-1648).
Conflicts with forge skills skip; prune safety covers plugin-written dirs.
*/
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runUpgrade } from "../src/onboarding/upgrade.ts";
import type { ForgeRuntimeContext } from "../src/types.ts";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: resolve(__dirname, ".."),
  } as ForgeRuntimeContext;
}

describe("upgrade plugin-skills sync", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "upgrade-plugin-skills-"));
    // minimal plugin with a contributed skill
    const pluginDir = join(dir, "tools", "skilled-plugin");
    mkdirSync(join(pluginDir, "skills", "plugin-skill"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "plugin-skill", "SKILL.md"), "---\nname: plugin-skill\n---\n# plugin-skill\n");
    writeFileSync(
      join(pluginDir, "forge.plugin.yaml"),
      [
        "schema: forge:plugin-manifest/v1",
        "id: skilled-plugin",
        "version: 1.0.0",
        'forgeRange: ">=10.0.0"',
        "capabilities:",
        "  filesystem: read",
        "registers:",
        "  skills: skills/",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "forge.yaml"),
      [
        "schema: forge/config@1",
        "project:",
        "  name: consumer",
        "  stack: []",
        "  packageManager: pnpm",
        "paths:",
        "  rfcsDir: docs/rfcs",
        "  adrsDir: docs/adrs",
        "  plansDir: docs/plans",
        "  auditsDir: docs/audits",
        "  specsDir: docs/specs",
        "  skillsDir: .agents/skills",
        "  sessionsDir: docs/sessions",
        "plugins:",
        "  - ./tools/skilled-plugin",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.1.0" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("plugin skills land in the generated tree", async () => {
    const result = await runUpgrade({ argv: [], flags: {} }, makeContext(dir));
    expect(result).toBeDefined();
    const skillPath = join(dir, ".agents", "skills", "plugin-skill", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("plugin-skill");
  });

  it("gitignore covers the generated skills tree", async () => {
    await runUpgrade({ argv: [], flags: {} }, makeContext(dir));
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore.split("\n").map((l) => l.trim())).toContain(".agents/skills/");
  });
});
