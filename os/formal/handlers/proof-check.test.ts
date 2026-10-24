/*
<MODULE_CONTRACT>
<purpose>
Unit tests for the RFC-1391 proof-check surface: proof.check verdict → exit-code
mapping (AC-1 proved/0), unavailable for missing tools (AC-2), error on version
mismatch (AC-3), the exhaustive report path incl. the cardinality count gate
(AC-4's runner side), and spec/entry failure modes. External checkers are
node -e argv stubs — no real proof assistant is installed.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the runner/schema own authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: proof.check handler + runProofCheck runner tests.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FormalToolEntry } from "../../../src/config/forge-config.ts";
import { EXHAUSTIVE_TOOL_VERSION, runProofCheck, type SpawnFn } from "../../../src/formal/index.ts";
import { runProofCheckCommand } from "./proof-check.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "proof-check-test-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function ctx(outputFormat: "pretty" | "json" = "json"): ForgeRuntimeContext {
  const logs: string[] = [];
  return {
    workspaceRoot: ws,
    dryRun: false,
    outputFormat,
    logger: {
      section: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      success: (m: string) => logs.push(m),
    },
  };
}

const NODE = process.execPath;
const NODE_VERSION = process.version.replace(/^v/, "");

function forgeYaml(tools: Record<string, FormalToolEntry>): void {
  const lines = ["formal:", "  tools: {}"];
  if (Object.keys(tools).length > 0) lines[1] = "  tools:";
  for (const [name, t] of Object.entries(tools)) {
    lines.push(`    ${name}:`);
    lines.push(
      `      command: [${t.command.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(", ")}]`,
    );
    lines.push(
      `      versionCommand: [${t.versionCommand.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(", ")}]`,
    );
    lines.push(`      versionPattern: '${t.versionPattern.replaceAll("'", "''")}'`);
    if (t.installHint) lines.push(`      installHint: "${t.installHint}"`);
  }
  writeFileSync(
    join(ws, "forge.yaml"),
    [
      "schema: forge/config@1",
      "project:",
      "  name: test-ws",
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
      ...lines,
    ].join("\n") + "\n",
  );
}

function writeSpec(body: Record<string, unknown>, rel = "specs/proof.yaml"): string {
  const abs = join(ws, rel);
  mkdirSync(join(ws, "specs"), { recursive: true });
  const yaml = Object.entries(body)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - "${i}"`).join("\n")}`;
      if (typeof v === "object" && v !== null) {
        return `${k}:\n${Object.entries(v)
          .map(([dk, dv]) => `  ${dk}: ${JSON.stringify(dv)}`)
          .join("\n")}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  writeFileSync(abs, yaml + "\n");
  return rel;
}

function specBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "forge/proof-spec@1",
    id: "unit-proof",
    invariantRefs: ["INV-unit-01"],
    statement: "stub proves the entry",
    tool: "tlc",
    toolVersion: NODE_VERSION,
    entry: "entry.txt",
    target: "stub-target",
    assumptions: ["test assumption"],
    trustedBase: ["the stub binary"],
    unverifiedBoundaries: ["stub boundary"],
    ...overrides,
  };
}

const stubTool = (exitCode: number): FormalToolEntry => ({
  command: [NODE, "-e", `process.exit(${exitCode})`, "{entry}"],
  versionCommand: [NODE, "--version"],
  versionPattern: "v(\\d+\\.\\d+\\.\\d+)",
  installHint: "install the stub",
});

describe("proof.check (RFC-1391)", () => {
  it("returns proved and exit 0 when the checker accepts the spec at the pinned version", async () => {
    forgeYaml({ tlc: stubTool(0) });
    writeFileSync(join(ws, "entry.txt"), "proof target\n");
    const spec = writeSpec(specBody());
    const res = await runProofCheckCommand({ argv: [], flags: { spec } }, ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.verdict?.verdict).toBe("proved");
    expect(res.data?.verdict?.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.data?.verdict?.entrySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns refuted with exit 1 and a persisted log when the checker rejects", async () => {
    forgeYaml({ tlc: stubTool(3) });
    writeFileSync(join(ws, "entry.txt"), "proof target\n");
    const spec = writeSpec(specBody());
    const res = await runProofCheckCommand({ argv: [], flags: { spec } }, ctx());
    expect(res.exitCode).toBe(1);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("refuted");
    expect(v?.counterexample).toMatch(/^\.cache[/\\]proofs[/\\]unit-proof\.log$/);
    expect(readFileSync(join(ws, v!.counterexample!), "utf8")).toContain("exit");
  });

  it("returns unavailable and a non-zero exit when the configured tool is not installed", async () => {
    forgeYaml({});
    writeFileSync(join(ws, "entry.txt"), "proof target\n");
    const spec = writeSpec(specBody());
    const res = await runProofCheckCommand({ argv: [], flags: { spec } }, ctx());
    expect(res.exitCode).toBe(1);
    expect(res.data?.verdict?.verdict).toBe("unavailable");
    expect(res.data?.verdict?.message).toContain("tlc");
  });

  it("returns unavailable when the versionCommand binary is missing", async () => {
    forgeYaml({
      tlc: { ...stubTool(0), versionCommand: ["definitely-missing-bin-xyz", "--version"] },
    });
    writeFileSync(join(ws, "entry.txt"), "proof target\n");
    const spec = writeSpec(specBody());
    const res = await runProofCheckCommand({ argv: [], flags: { spec } }, ctx());
    expect(res.data?.verdict?.verdict).toBe("unavailable");
    expect(res.data?.verdict?.message).toContain("install the stub");
  });

  it("returns error when the installed tool version differs from toolVersion", async () => {
    forgeYaml({ tlc: stubTool(0) });
    writeFileSync(join(ws, "entry.txt"), "proof target\n");
    const spec = writeSpec(specBody({ toolVersion: "0.0.0-pin" }));
    const res = await runProofCheckCommand({ argv: [], flags: { spec } }, ctx());
    expect(res.exitCode).toBe(1);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("error");
    expect(v?.message).toContain("0.0.0-pin");
    expect(v?.toolVersion).toBe(NODE_VERSION);
  });

  it("returns error on a spec that fails forge/proof-spec@1 and on a missing entry", async () => {
    forgeYaml({ tlc: stubTool(0) });
    const bad = writeSpec(specBody({ assumptions: [] }), "specs/bad.yaml");
    const res1 = await runProofCheckCommand({ argv: [], flags: { spec: bad } }, ctx());
    expect(res1.data?.verdict?.verdict).toBe("error");
    expect(res1.data?.verdict?.message).toContain("forge/proof-spec@1");

    const missingEntry = writeSpec(specBody({ entry: "no/such/entry.txt" }), "specs/miss.yaml");
    const res2 = await runProofCheckCommand({ argv: [], flags: { spec: missingEntry } }, ctx());
    expect(res2.data?.verdict?.verdict).toBe("error");
    expect(res2.data?.verdict?.message).toContain("entry file not found");
  });

  it("usage error when --spec is absent", async () => {
    const res = await runProofCheckCommand({ argv: [], flags: {} }, ctx());
    expect(res.exitCode).toBe(2);
    expect(res.summary).toContain("--spec");
  });
});

describe("runProofCheck — exhaustive tool (RFC-1391)", () => {
  function exhaustiveSpec(overrides: Record<string, unknown> = {}): string {
    writeFileSync(join(ws, "entry.proof.test.ts"), "// entry\n");
    return writeSpec(
      specBody({
        tool: "exhaustive",
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
        entry: "entry.proof.test.ts",
        domain: { description: "4 test inputs", cardinality: 4 },
        ...overrides,
      }),
      "specs/exhaustive.yaml",
    );
  }

  const reportWriter =
    (
      report: { enumerated: number; failures: { input: unknown; reason: string }[] } | null,
    ): SpawnFn =>
    async (argv, opts) => {
      const reportPath = opts.env?.["FORGE_PROOF_REPORT"];
      if (report && reportPath) {
        mkdirSync(join(reportPath, ".."), { recursive: true });
        writeFileSync(reportPath, JSON.stringify(report));
      }
      return {
        exitCode: report ? 0 : 1,
        timedOut: false,
        spawnError: null,
        stdout: "",
        stderr: "",
      };
    };

  it("proved when the report enumerates exactly the declared cardinality", async () => {
    const spec = exhaustiveSpec();
    const v = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      spawnFn: reportWriter({ enumerated: 4, failures: [] }),
    });
    expect(v.verdict).toBe("proved");
    expect(v.enumerated).toBe(4);
  });

  it("error when the report's enumerated count differs from cardinality", async () => {
    const spec = exhaustiveSpec();
    const v = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      spawnFn: reportWriter({ enumerated: 3, failures: [] }),
    });
    expect(v.verdict).toBe("error");
    expect(v.message).toContain("cardinality 4");
  });

  it("refuted + counterexample artifact when the report carries failures", async () => {
    const spec = exhaustiveSpec();
    const v = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      spawnFn: reportWriter({ enumerated: 4, failures: [{ input: 2, reason: "two fails" }] }),
    });
    expect(v.verdict).toBe("refuted");
    expect(v.counterexample).toMatch(/counterexample\.json$/);
    const cx = JSON.parse(readFileSync(join(ws, v!.counterexample!), "utf8"));
    expect(cx).toEqual([{ input: 2, reason: "two fails" }]);
  });

  it("error when the entry writes no report (crashed or threw)", async () => {
    const spec = exhaustiveSpec();
    const v = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: spec,
      spawnFn: reportWriter(null),
    });
    expect(v.verdict).toBe("error");
    expect(v.message).toContain("no readable report");
  });

  it("error when the spec pins a different exhaustive version or lacks cardinality", async () => {
    const badVersion = exhaustiveSpec({ toolVersion: "999" });
    const v1 = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: badVersion,
      spawnFn: reportWriter({ enumerated: 4, failures: [] }),
    });
    expect(v1.verdict).toBe("error");
    expect(v1.message).toContain("version");

    writeFileSync(join(ws, "entry.proof.test.ts"), "// entry\n");
    const noCard = writeSpec(
      specBody({
        tool: "exhaustive",
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
        entry: "entry.proof.test.ts",
      }),
      "specs/nocard.yaml",
    );
    const v2 = await runProofCheck({
      workspaceRoot: ws,
      specRelPath: noCard,
      spawnFn: reportWriter({ enumerated: 4, failures: [] }),
    });
    expect(v2.verdict).toBe("error");
    expect(v2.message).toContain("domain.cardinality");
  });
});
