/*
<MODULE_CONTRACT>
<purpose>Unit tests for CLI output rendering helpers (RFC-0542) —
renderNextSteps, renderIdeRecommendation, generateHelp.</purpose>
<non-goals>
  <item>Do not test bin/cli.ts dispatch — these tests cover pure functions only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0542: initial CLI output rendering tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { renderNextSteps, renderIdeRecommendation, generateHelp } from "../cli-output.ts";
import type {
  CommandRegistry,
  ForgeRegisteredCommandInfo,
  ForgeCommandDefinition,
} from "../types.ts";
import type { ForgeModuleRegistry, ForgePipelineStep } from "../forge-module.ts";

class MockRegistry implements CommandRegistry, ForgeModuleRegistry {
  private commands = new Map<string, ForgeCommandDefinition>();

  registerCommand(command: ForgeCommandDefinition): void {
    this.commands.set(command.name, command);
  }

  registerPipeline(_name: string, _steps: ForgePipelineStep[]): void {}

  listCommandNames(): string[] {
    return [...this.commands.keys()].sort();
  }

  listCommands(): ForgeRegisteredCommandInfo[] {
    return [...this.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
      scope: c.scope,
      provider: "workspace" as const,
      mutatesState: c.mutatesState,
      requiresNetwork: c.requiresNetwork,
      supportsAllSites: c.supportsAllSites,
      timeoutMs: c.timeoutMs,
      expectedDurationMs: c.expectedDurationMs,
      longRunning: c.longRunning,
      flags: c.flags,
      reads: c.reads,
      writes: c.writes,
    }));
  }

  getCommand(name: string): ForgeCommandDefinition | undefined {
    return this.commands.get(name);
  }
}

describe("renderNextSteps", () => {
  test("returns empty string for undefined input", () => {
    expect(renderNextSteps(undefined)).toBe("");
  });

  test("returns empty string for empty array", () => {
    expect(renderNextSteps([])).toBe("");
  });

  test("renders a single required step with [must do] label", () => {
    const output = renderNextSteps([{ action: "Open the project in Windsurf", kind: "required" }]);
    expect(output).toContain("Next steps:");
    expect(output).toContain("Open the project in Windsurf");
    expect(output).toContain("[must do]");
  });

  test("renders a single optional step with [can do] label", () => {
    const output = renderNextSteps([{ action: "Run /forge-bootstrap", kind: "optional" }]);
    expect(output).toContain("Next steps:");
    expect(output).toContain("Run /forge-bootstrap");
    expect(output).toContain("[can do]");
  });

  test("renders mixed steps with correct labels", () => {
    const output = renderNextSteps([
      { action: "Open the project in Windsurf", kind: "required" },
      { action: "Run /forge-bootstrap to configure the project", kind: "optional" },
    ]);
    expect(output).toContain("[must do]");
    expect(output).toContain("[can do]");
    expect(output).toContain("Open the project in Windsurf");
    expect(output).toContain("Run /forge-bootstrap to configure the project");
  });
});

describe("renderIdeRecommendation", () => {
  test("returns string containing Windsurf and tested", () => {
    const output = renderIdeRecommendation();
    expect(output).toContain("Windsurf");
    expect(output).toContain("tested");
  });

  test("returns string containing VS Code and not tested", () => {
    const output = renderIdeRecommendation();
    expect(output).toContain("VS Code");
    expect(output).toContain("not tested");
  });
});

describe("generateHelp", () => {
  test("returns string containing all registered command names", () => {
    const registry = new MockRegistry();
    registry.registerCommand({
      name: "forge.init",
      description: "Deploy forge into a project.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });
    registry.registerCommand({
      name: "forge.doctor",
      description: "Diagnose forge state in an existing project.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });

    const help = generateHelp(registry);
    expect(help).toContain("forge.init");
    expect(help).toContain("forge.doctor");
  });

  test("groups commands by listing them sorted alphabetically", () => {
    const registry = new MockRegistry();
    registry.registerCommand({
      name: "forge.doctor",
      description: "Diagnose forge state.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });
    registry.registerCommand({
      name: "forge.init",
      description: "Deploy forge.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });

    const help = generateHelp(registry);
    const doctorIdx = help.indexOf("forge.doctor");
    const initIdx = help.indexOf("forge.init");
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(doctorIdx).toBeLessThan(initIdx);
  });

  test("does not contain the old hand-maintained command list text", () => {
    const registry = new MockRegistry();
    registry.registerCommand({
      name: "forge.init",
      description: "Deploy forge.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });

    const help = generateHelp(registry);
    expect(help).not.toContain("skill.validate      Validate all forge skills");
    expect(help).not.toContain("workflow-amend.list");
  });

  test("includes command count in header", () => {
    const registry = new MockRegistry();
    registry.registerCommand({
      name: "forge.init",
      description: "Deploy forge.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: async () => ({ exitCode: 0 }),
    });

    const help = generateHelp(registry);
    expect(help).toContain("Registered commands (1):");
  });
});
