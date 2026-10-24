/*
<MODULE_CONTRACT>
<purpose>proof-runner unit tests (RFC-1391) — runner-level verdict paths not
reachable through the command handler: stale-report freshness, path
confinement, forge.yaml classification, {entry} enforcement, package-manager
exec selection, regex guards, and the log/counterexample evidence split.
spawnFn injection virtualizes the checker so no real subprocess runs.</purpose>
<non-goals>
  <item>Do not test the proof.check command surface — os/formal/handlers/proof-check.test.ts covers it.</item>
  <item>Do not test the proof-spec schema — proof-spec.test.ts covers it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 review r1: runner-level tests for freshness, confinement, config classification, and evidence fields.</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXHAUSTIVE_TOOL_VERSION, FORGE_PROOF_REPORT_ENV } from "./exhaustive.ts";
import { runProofCheck, type SpawnFn } from "./proof-runner.ts";

let ws: string;
afterEach(() => rmSync(ws, { recursive: true, force: true }));

function setup(): void {
  ws = mkdtempSync(join(tmpdir(), "proof-runner-"));
  mkdirSync(join(ws, "specs"), { recursive: true });
}

function writeSpec(overrides: Record<string, unknown> = {}): string {
  const body = {
    schema: "forge/proof-spec@1",
    id: "unit-proof",
    invariantRefs: ["INV-unit-01"],
    statement: "the checker accepts the entry",
    tool: "exhaustive",
    toolVersion: EXHAUSTIVE_TOOL_VERSION,
    entry: "specs/entry.ts",
    target: "unit-target",
    assumptions: ["a1"],
    trustedBase: ["t1"],
    unverifiedBoundaries: ["b1"],
    domain: { description: "three inputs", cardinality: 3 },
    ...overrides,
  };
  const yaml = Object.entries(body)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${JSON.stringify(i)}`).join("\n")}`;
      if (typeof v === "object" && v !== null)
        return `${k}:\n${Object.entries(v)
          .map(([dk, dv]) => `  ${dk}: ${JSON.stringify(dv)}`)
          .join("\n")}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  writeFileSync(join(ws, "specs", "proof.yaml"), `${yaml}\n`);
  return "specs/proof.yaml";
}

function writeEntry(): void {
  writeFileSync(join(ws, "specs", "entry.ts"), "// proof entry\n");
}

const okSpawn: SpawnFn = async () => ({
  exitCode: 0,
  timedOut: false,
  spawnError: null,
  stdout: "",
  stderr: "",
});

function spawnRecording(calls: string[][], envs: (NodeJS.ProcessEnv | undefined)[]): SpawnFn {
  return async (argv, opts) => {
    calls.push(argv);
    envs.push(opts.env);
    return { exitCode: 0, timedOut: false, spawnError: null, stdout: "", stderr: "" };
  };
}

describe("runProofCheck — freshness (A-1)", () => {
  it("purges a stale report before spawning — a leftover proved report cannot fabricate proved", async () => {
    setup();
    writeEntry();
    const spec = writeSpec();
    // Forge a stale report that would evaluate to `proved` if consumed.
    mkdirSync(join(ws, ".cache", "proofs"), { recursive: true });
    writeFileSync(
      join(ws, ".cache", "proofs", "unit-proof.report.json"),
      JSON.stringify({ enumerated: 3, failures: [] }),
    );
    // This spawn writes no report — mimics a broken entry.
    const res = await runProofCheck({ workspaceRoot: ws, specRelPath: spec, spawnFn: okSpawn });
    expect(res.verdict).toBe("error");
    expect(res.enumerated).toBeUndefined();
  });

  it("a fresh report written by the current spawn still proves", async () => {
    setup();
    writeEntry();
    const spec = writeSpec();
    const writingSpawn: SpawnFn = async (_argv, opts) => {
      mkdirSync(join(opts.env![FORGE_PROOF_REPORT_ENV]!, ".."), { recursive: true });
      writeFileSync(
        opts.env![FORGE_PROOF_REPORT_ENV]!,
        JSON.stringify({ enumerated: 3, failures: [] }),
      );
      return { exitCode: 0, timedOut: false, spawnError: null, stdout: "", stderr: "" };
    };
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      spawnFn: writingSpawn,
    });
    expect(res.verdict).toBe("proved");
    expect(res.enumerated).toBe(3);
  });
});

describe("runProofCheck — path confinement (G-3)", () => {
  it("rejects a spec path escaping workspaceRoot", async () => {
    setup();
    const res = await runProofCheck({ workspaceRoot: ws, specRelPath: "../outside.yaml" });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("escapes workspaceRoot");
  });

  it("rejects an entry path escaping workspaceRoot", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ entry: "../outside.ts" });
    const res = await runProofCheck({ workspaceRoot: ws, specRelPath: spec });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("escapes workspaceRoot");
    expect(res.specSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runProofCheck — forge.yaml classification (G-2)", () => {
  it("malformed forge.yaml yields error, not unavailable", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc" });
    writeFileSync(join(ws, "forge.yaml"), "schema: forge/config@1\nformal: [broken\n");
    const res = await runProofCheck({ workspaceRoot: ws, specRelPath: spec, spawnFn: okSpawn });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("forge.yaml unresolvable");
  });

  it("absent forge.yaml yields tools {} — external tool reports unavailable", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc" });
    const res = await runProofCheck({ workspaceRoot: ws, specRelPath: spec });
    expect(res.verdict).toBe("unavailable");
    expect(res.message).toContain("not declared in forge.yaml formal.tools");
  });
});

describe("runProofCheck — tool contract (G-1, A-2)", () => {
  it("external tool without {entry} in command yields error", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc", toolVersion: "1.0" });
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: {
        tlc: {
          command: ["true"],
          versionCommand: ["true"],
          versionPattern: "(.*)",
        },
      },
      spawnFn: okSpawn,
    });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("{entry}");
  });

  it("malformed versionPattern yields error instead of throwing", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc", toolVersion: "1.0" });
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: {
        tlc: {
          command: ["node", "{entry}"],
          versionCommand: ["node", "-v"],
          versionPattern: "([unclosed",
        },
      },
      spawnFn: async () => ({
        exitCode: 0,
        timedOut: false,
        spawnError: null,
        stdout: "v1.0",
        stderr: "",
      }),
    });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("not a valid regex");
  });
});

describe("runProofCheck — package-manager exec selection (C-2)", () => {
  it('packageManager "none" yields error for exhaustive', async () => {
    setup();
    writeEntry();
    const spec = writeSpec();
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: {},
      packageManager: "none",
      spawnFn: okSpawn,
    });
    expect(res.verdict).toBe("error");
    expect(res.message).toContain("cannot exec vitest");
  });

  it.each([
    ["pnpm", ["pnpm", "exec", "vitest", "run"]],
    ["npm", ["npm", "exec", "--", "vitest", "run"]],
    ["yarn", ["yarn", "vitest", "run"]],
    ["bun", ["bun", "x", "vitest", "run"]],
  ] as const)("packageManager %s maps to the right vitest invocation", async (pm, expected) => {
    setup();
    writeEntry();
    const spec = writeSpec();
    const calls: string[][] = [];
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: {},
      packageManager: pm,
      spawnFn: spawnRecording(calls, envs),
    });
    expect(res.verdict).toBe("error"); // spawn produced no report — but argv is what we assert
    expect(calls[0]!.slice(0, expected.length)).toEqual(expected);
    expect(calls[0]![expected.length]).toBe(join(ws, "specs", "entry.ts"));
    expect(envs[0]![FORGE_PROOF_REPORT_ENV]).toBe(
      join(ws, ".cache", "proofs", "unit-proof.report.json"),
    );
  });
});

describe("runProofCheck — evidence fields (E-5)", () => {
  const tlc = {
    command: ["node", "{entry}"],
    versionCommand: ["node", "-e", "console.log('v9.9.9')"],
    versionPattern: "v(\\S+)",
  };

  it("proved external run carries log, never counterexample", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc", toolVersion: "9.9.9" });
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: { tlc },
      spawnFn: async (argv) => ({
        exitCode: argv[0] === "node" && argv.includes("-v") ? 0 : 0,
        timedOut: false,
        spawnError: null,
        stdout: argv.includes("-e") ? "v9.9.9" : "proof accepted",
        stderr: "",
      }),
    });
    expect(res.verdict).toBe("proved");
    expect(res.counterexample).toBeUndefined();
    expect(res.log).toBeDefined();
    expect(readFileSync(join(ws, res.log!), "utf8")).toContain("proof accepted");
  });

  it("refuted external run carries counterexample", async () => {
    setup();
    writeEntry();
    const spec = writeSpec({ tool: "tlc", toolVersion: "9.9.9" });
    const res = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      tools: { tlc },
      spawnFn: async (argv) => ({
        exitCode: argv.includes("-e") ? 0 : 1,
        timedOut: false,
        spawnError: null,
        stdout: argv.includes("-e") ? "v9.9.9" : "counterexample trace",
        stderr: "",
      }),
    });
    expect(res.verdict).toBe("refuted");
    expect(res.counterexample).toBeDefined();
    expect(readFileSync(join(ws, res.counterexample!), "utf8")).toContain("counterexample trace");
  });
});
