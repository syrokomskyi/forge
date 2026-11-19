/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge agent-tools server — covers the tool server suite surface and its observable contract.</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

import { callTool, listTools, type AgentToolsRuntime, type CommandRunner } from "./server.ts";
import type { AgentToolsFile } from "./types.ts";

const TOOLS: AgentToolsFile = {
  schema: "forge/agent-tools@1",
  generatedBy: "command.tools.generate",
  manifestHash: "abc123",
  deny: ["delta.deny"],
  front: [
    {
      name: "alpha_run",
      command: "alpha.run",
      description: "Alpha command.",
      inputSchema: {
        type: "object",
        properties: {
          site: { type: "string" },
          mode: { type: "string", enum: ["fast", "full"] },
        },
        required: ["site"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ],
  commands: {
    "alpha.run": {
      command: "alpha.run",
      description: "Alpha command.",
      inputSchema: {
        type: "object",
        properties: {
          site: { type: "string" },
          mode: { type: "string", enum: ["fast", "full"] },
        },
        required: ["site"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    "beta.mutate": {
      command: "beta.mutate",
      description: "Beta mutating command.",
      inputSchema: {
        type: "object",
        properties: { files: { type: "array", items: { type: "string" } } },
        required: ["files"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      detachable: true,
    },
  },
};

function runtime(runner?: CommandRunner): AgentToolsRuntime {
  return {
    workspaceRoot: "/repo",
    tools: TOOLS,
    runner:
      runner ??
      (async (argv) => ({
        command: argv[0] ?? "",
        exitCode: 0,
        stdout: '{"ok":true}\n',
        stderr: "",
        output: { ok: true },
      })),
  };
}

describe("forge agent-tools server", () => {
  it("lists the three meta tools plus one per front entry (AC-5)", () => {
    const names = listTools(runtime()).map((t) => t.name);
    expect(names).toEqual(["command_search", "command_describe", "command_run", "alpha_run"]);
  });

  it("command_run rejects an undeclared argument with AGENT-TOOL-01 and never spawns (AC-3)", async () => {
    let spawned = false;
    const rt = runtime(async () => {
      spawned = true;
      return { command: "", exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await callTool(rt, "command_run", {
      name: "alpha.run",
      args: { site: "s1", sites: "oops" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.ruleId).toBe("AGENT-TOOL-01");
    expect(result.error.message).toContain('"sites" is not a declared flag');
    expect(result.error.properties).toEqual(["site", "mode"]);
    expect(result.error.suggestion).toBe("site");
    expect(spawned).toBe(false);
  });

  it("command_run rejects a missing required flag with AGENT-TOOL-01", async () => {
    let spawned = false;
    const rt = runtime(async () => {
      spawned = true;
      return { command: "", exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await callTool(rt, "command_run", {
      name: "alpha.run",
      args: { mode: "fast" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.ruleId).toBe("AGENT-TOOL-01");
    expect(result.error.message).toContain("missing required flag(s): site");
    expect(spawned).toBe(false);
  });

  it("command_run refuses a deny-listed command with AGENT-TOOL-02 (AC-4)", async () => {
    let spawned = false;
    const rt = runtime(async () => {
      spawned = true;
      return { command: "", exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await callTool(rt, "command_run", {
      name: "delta.deny",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.ruleId).toBe("AGENT-TOOL-02");
    expect(result.error.message).toContain("deny");
    expect(spawned).toBe(false);

    // A denied name is invisible to search and describe too.
    const search = await callTool(rt, "command_search", { query: "delta" });
    expect(search.ok).toBe(true);
    if (search.ok) {
      expect((search.result as { matches: unknown[] }).matches).toHaveLength(0);
    }
    const describe = await callTool(rt, "command_describe", { name: "delta.deny" });
    expect(describe.ok).toBe(false);
    if (!describe.ok) expect(describe.error.ruleId).toBe("AGENT-TOOL-02");
  });

  it("command_run serializes args to kernel argv and returns the --json envelope", async () => {
    const seen: string[][] = [];
    const rt = runtime(async (argv) => {
      seen.push(argv);
      return {
        command: argv[0] ?? "",
        exitCode: 0,
        stdout: '{"data":{"wrote":2}}\n',
        stderr: "",
        output: { data: { wrote: 2 } },
      };
    });
    const result = await callTool(rt, "command_run", {
      name: "alpha.run",
      args: { site: "s1", mode: "fast" },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual(["alpha.run", "--json", "--site=s1", "--mode=fast"]);
    if (result.ok) {
      expect(result.result).toMatchObject({
        command: "alpha.run",
        exitCode: 0,
        output: { data: { wrote: 2 } },
      });
    }
  });

  it("a front tool call is an alias for command_run on its command", async () => {
    const seen: string[][] = [];
    const rt = runtime(async (argv) => {
      seen.push(argv);
      return { command: "", exitCode: 0, stdout: "{}", stderr: "" };
    });
    const result = await callTool(rt, "alpha_run", { site: "s1" });
    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual(["alpha.run", "--json", "--site=s1"]);
  });

  it("detachable commands spawn with --detach and return the run id", async () => {
    const seen: string[][] = [];
    const rt = runtime(async (argv) => {
      seen.push(argv);
      return {
        command: argv[0] ?? "",
        exitCode: 0,
        stdout: '{"data":{"status":"running","runId":"gr-1"}}\n',
        stderr: "",
        output: { data: { status: "running", runId: "gr-1", pid: 42 } },
      };
    });
    const result = await callTool(rt, "command_run", {
      name: "beta.mutate",
      args: { files: ["a.ts", "b.ts"] },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual(["beta.mutate", "--json", "--files=a.ts", "--files=b.ts", "--detach"]);
    if (result.ok) {
      expect(result.result).toMatchObject({ detached: true, runId: "gr-1" });
    }
  });

  it("command_describe returns the manifest schema for a known command", async () => {
    const result = await callTool(runtime(), "command_describe", { name: "alpha.run" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        name: "alpha_run",
        command: "alpha.run",
        inputSchema: { required: ["site"] },
      });
    }
  });
});
