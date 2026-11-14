import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runCommandToolsGenerate } from "./handlers/tools-generate.ts";
import { AGENT_TOOLS_FILE_RELATIVE, type AgentToolsFile } from "./types.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "tools-generate-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function ctx(root: string): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    dryRun: false,
    outputFormat: "json",
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
  };
}

const MANIFEST = {
  meta: { schemaVersion: 1, deterministic: true, generatedAt: null, contentHash: "abc123" },
  commands: [
    {
      name: "alpha.run",
      description: "Alpha command.",
      mutatesState: false,
      flags: {
        site: { kind: "string", required: true, description: "Site id." },
        mode: {
          kind: "string",
          required: true,
          enum: ["fast", "full"],
          description: "Mode.",
        },
        verbose: { kind: "boolean", required: false, description: "Verbose." },
      },
    },
    {
      name: "beta.mutate",
      description: "Beta mutating command.",
      mutatesState: true,
      detachable: true,
      flags: {
        files: { kind: "string[]", required: true, description: "Files." },
      },
    },
    {
      name: "gamma.open",
      description: "Passthrough command.",
      mutatesState: false,
      flagsOpen: true,
      flags: {
        target: { kind: "string", required: false, description: "Target." },
      },
    },
    {
      name: "delta.deny",
      description: "Denied command.",
      mutatesState: true,
      flags: {},
    },
  ],
};

const FORGE_YAML = `schema: forge/config@1
project:
  name: test
  stack: [typescript]
  packageManager: pnpm
paths: {}
agentTools:
  front:
    - alpha.run
  deny:
    - delta.deny
`;

async function seed(root: string, forgeYaml = FORGE_YAML): Promise<void> {
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "command-manifest.generated.yaml"),
    `${JSON.stringify(MANIFEST, null, 2)}\n`,
  );
  await writeFile(path.join(root, "forge.yaml"), forgeYaml);
}

function generated(root: string): Promise<AgentToolsFile> {
  return readFile(path.join(root, AGENT_TOOLS_FILE_RELATIVE), "utf8").then(
    (raw) => JSON.parse(raw) as AgentToolsFile,
  );
}

describe("command.tools.generate", () => {
  it("writes one commands entry per non-denied manifest command (AC-2)", async () => {
    const root = path.join(tmpDir, "happy");
    await seed(root);
    const result = await runCommandToolsGenerate({ argv: [], flags: {} }, ctx(root));
    expect(result.exitCode).toBe(0);

    const file = await generated(root);
    expect(file.schema).toBe("forge/agent-tools@1");
    expect(file.generatedBy).toBe("command.tools.generate");
    expect(file.manifestHash).toBe("abc123");
    expect(file.deny).toEqual(["delta.deny"]);

    // One entry per manifest command, minus the denied one.
    expect(Object.keys(file.commands).sort()).toEqual(["alpha.run", "beta.mutate", "gamma.open"]);

    // AC-2: required list equals the command's required flags.
    const alpha = file.commands["alpha.run"]!;
    expect(alpha.inputSchema.required.sort()).toEqual(["mode", "site"]);
    expect(alpha.inputSchema.additionalProperties).toBe(false);
    expect(alpha.inputSchema.properties["site"]).toMatchObject({ type: "string" });
    expect(alpha.inputSchema.properties["mode"]).toMatchObject({
      type: "string",
      enum: ["fast", "full"],
    });
    expect(alpha.inputSchema.properties["verbose"]).toMatchObject({ type: "boolean" });
    expect(alpha.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

    const beta = file.commands["beta.mutate"]!;
    expect(beta.inputSchema.required).toEqual(["files"]);
    expect(beta.inputSchema.properties["files"]).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(beta.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(beta.detachable).toBe(true);

    // flagsOpen keeps additionalProperties: true.
    const gamma = file.commands["gamma.open"]!;
    expect(gamma.inputSchema.additionalProperties).toBe(true);
    expect(gamma.inputSchema.required).toEqual([]);

    // Front set projects one tool per entry with the underscored name.
    expect(file.front).toHaveLength(1);
    expect(file.front[0]!.name).toBe("alpha_run");
    expect(file.front[0]!.command).toBe("alpha.run");
  });

  it("--check passes on a current file and fails on drift without writing", async () => {
    const root = path.join(tmpDir, "check");
    await seed(root);
    const gen = await runCommandToolsGenerate({ argv: [], flags: {} }, ctx(root));
    expect(gen.exitCode).toBe(0);

    const ok = await runCommandToolsGenerate({ argv: [], flags: { check: true } }, ctx(root));
    expect(ok.exitCode).toBe(0);
    expect(ok.data?.drift).toBe(false);

    // Corrupt the file — --check must fail and must not heal it.
    const filePath = path.join(root, AGENT_TOOLS_FILE_RELATIVE);
    await writeFile(filePath, '{"corrupted": true}\n');
    const stale = await runCommandToolsGenerate({ argv: [], flags: { check: true } }, ctx(root));
    expect(stale.exitCode).toBe(1);
    expect(stale.data?.drift).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe('{"corrupted": true}\n');
  });

  it("refuses AGENT-TOOL-04 when a front entry is absent from the manifest", async () => {
    const root = path.join(tmpDir, "bad-front");
    await seed(root, FORGE_YAML.replace("- alpha.run", "- nosuch.command\n    - alpha.run"));
    const result = await runCommandToolsGenerate({ argv: [], flags: {} }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(result.data?.issues?.[0]?.ruleId).toBe("AGENT-TOOL-04");
  });

  it("refuses AGENT-TOOL-03 when the front set exceeds 40", async () => {
    const root = path.join(tmpDir, "big-front");
    const many = Array.from({ length: 41 }, (_, i) => `    - alpha.run${i === 0 ? "" : `.v${i}`}`);
    const yaml = FORGE_YAML.replace("    - alpha.run", many.join("\n"));
    await seed(root, yaml);
    const result = await runCommandToolsGenerate({ argv: [], flags: {} }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(result.data?.issues?.some((i) => i.ruleId === "AGENT-TOOL-03")).toBe(true);
  });
});
