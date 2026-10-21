/*
<MODULE_CONTRACT>
<purpose>
Unit tests for the RFC-1365 golden-conformance surface: runProducerConformance
leg order + attribution + skip/require semantics (AC-2..AC-5),
forge.conformance.run selection/aggregate exits, and forge.conformance.validate
CONF-01..06 lint rules (AC-6). Node -e argv stubs keep fixtures domain-free;
consumer checkouts are sibling dirs inside the fixture workspace.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 3 — conformance handler + lint test suite.</item>
  <item>RFC-1365: step 3 — conformance handler + lint test suite (33 cases)</item>
  <item>RFC-1365: review round 1 — CONF-03 rescoped producer-side (Q-9), producers[] json shape, crash guard + leg output, transport attribution, env semantics, writes declared, regen sweep</item>
</CHANGE_SUMMARY>
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  consumerAvailable,
  runProducerConformance,
  type ContractProducerDecl,
} from "../../../../src/conformance/index.ts";
import { runConformanceRun } from "../conformance-run.ts";
import { runConformanceValidate } from "../conformance-validate.ts";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "conformance-test-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  vi.unstubAllEnvs();
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

/** Emit stub — writes a bundle file into FORGE_CONFORMANCE_BUNDLE_DIR. */
const EMIT_ENV = `require("node:fs").writeFileSync(require("node:path").join(process.env.FORGE_CONFORMANCE_BUNDLE_DIR,"bundle.txt"),"x")`;
/** Emit stub — writes via the {bundle} argv placeholder instead of env. */
const EMIT_ARGV = `require("node:fs").writeFileSync(require("node:path").join(process.argv[1],"bundle.txt"),"x")`;
/** Mirror stub — pass when bundle.txt exists. */
const MIRROR_CHECK = `process.exit(require("node:fs").existsSync(require("node:path").join(process.argv[1],"bundle.txt"))?0:1)`;
/** Consumer stub — pass when bundle.txt exists in {bundle}. */
const CONSUMER_CHECK = `process.exit(require("node:fs").existsSync(require("node:path").join(process.argv[1],"bundle.txt"))?0:1)`;

function decl(overrides: Partial<ContractProducerDecl> = {}): ContractProducerDecl {
  return {
    id: "intake",
    emit: { argv: [NODE, "-e", EMIT_ENV, "{bundle}"] },
    mirror: { argv: [NODE, "-e", MIRROR_CHECK, "{bundle}"] },
    consumer: {
      root: "./consumer",
      validator: { argv: [NODE, "-e", CONSUMER_CHECK, "{bundle}"] },
    },
    test: "conformance.test.ts",
    ...overrides,
  };
}

function withConsumerRoot(d: ContractProducerDecl): ContractProducerDecl {
  mkdirSync(join(ws, "consumer"), { recursive: true });
  return d;
}

describe("runProducerConformance — legs + verdicts (RFC-1365)", () => {
  it("AC-2: emit → mirror → consumer legs run in declaration order, all pass", async () => {
    const verdict = await runProducerConformance(withConsumerRoot(decl()), {
      repoRoot: ws,
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.legs.map((l) => l.leg)).toEqual(["emit", "mirror", "consumer"]);
    expect(verdict.legs.every((l) => l.status === "pass")).toBe(true);
  });

  it("AC-3: consumer validator non-zero → fail with failedLeg consumer", async () => {
    const d = withConsumerRoot(
      decl({
        consumer: { root: "./consumer", validator: { argv: [NODE, "-e", "process.exit(3)"] } },
      }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("consumer");
    expect(verdict.legs.at(-1)?.exitCode).toBe(3);
  });

  it("AC-4: absent consumer.root → skip verdict naming the consumer leg", async () => {
    const verdict = await runProducerConformance(decl(), { repoRoot: ws });
    expect(verdict.status).toBe("skip");
    expect(verdict.legs.at(-1)).toMatchObject({ leg: "consumer", status: "skip" });
    expect(verdict.diagnostics.join(" ")).toContain("skipped");
  });

  it("AC-5: requireConsumer turns absent consumer.root into fail consumer-missing", async () => {
    const verdict = await runProducerConformance(decl(), {
      repoRoot: ws,
      requireConsumer: true,
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("consumer");
    expect(verdict.diagnostics.join(" ")).toContain("consumer-missing");
  });

  it("emit leg failure stops before mirror + consumer, failedLeg emit", async () => {
    const d = withConsumerRoot(
      decl({ emit: { argv: [NODE, "-e", "process.exit(2)", "{bundle}"] } }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("emit");
    expect(verdict.legs.map((l) => l.leg)).toEqual(["emit"]);
  });

  it("emit leaving an empty bundle dir fails the emit leg", async () => {
    const d = withConsumerRoot(decl({ emit: { argv: [NODE, "-e", "", "{bundle}"] } }));
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("emit");
    expect(verdict.diagnostics.join(" ")).toContain("empty");
  });

  it("mirror failure stops before consumer, failedLeg mirror", async () => {
    const d = withConsumerRoot(
      decl({ mirror: { argv: [NODE, "-e", "process.exit(1)", "{bundle}"] } }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("mirror");
    expect(verdict.legs.map((l) => l.leg)).toEqual(["emit", "mirror"]);
  });

  it("{bundle} argv substitution reaches the emit process", async () => {
    const d = withConsumerRoot(decl({ emit: { argv: [NODE, "-e", EMIT_ARGV, "{bundle}"] } }));
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("pass");
  });

  it("consumer leg runs with cwd = consumer.root", async () => {
    const consumerRoot = join(ws, "consumer");
    mkdirSync(consumerRoot, { recursive: true });
    const d = decl({
      consumer: {
        root: "./consumer",
        validator: {
          argv: [
            NODE,
            "-e",
            `process.exit(process.cwd()===${JSON.stringify(consumerRoot)}?0:5)`,
            "{bundle}",
          ],
        },
      },
    });
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("pass");
  });

  it("leg output is tail-truncated past 64 KiB with the truncated marker", async () => {
    const d = withConsumerRoot(
      decl({
        emit: {
          argv: [NODE, "-e", `console.log("x".repeat(200*1024));${EMIT_ENV}`, "{bundle}"],
        },
      }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    const emitLeg = verdict.legs.find((l) => l.leg === "emit");
    expect(emitLeg?.truncated).toBe(true);
    expect(emitLeg?.output?.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("missing mirror declaration skips the mirror leg slot entirely", async () => {
    const d = withConsumerRoot(decl({ mirror: undefined }));
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("pass");
    expect(verdict.legs.map((l) => l.leg)).toEqual(["emit", "consumer"]);
  });

  it("consumer transport failure (unresolvable binary) fails the consumer leg", async () => {
    const d = withConsumerRoot(
      decl({
        consumer: {
          root: "./consumer",
          validator: { argv: ["definitely-not-a-binary-xyz", "{bundle}"] },
        },
      }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("consumer");
    expect(verdict.diagnostics.join(" ")).toContain("transport");
  });
});

describe("consumerAvailable — test-side skip guard", () => {
  it("true when the declared root exists, false when absent", () => {
    expect(consumerAvailable(join(ws, "nope"))).toBe(false);
    mkdirSync(join(ws, "consumer"), { recursive: true });
    expect(consumerAvailable("consumer", ws)).toBe(true);
  });

  it("AC-7: @warpgogol/forge/conformance subpath resolves for vitest guards", async () => {
    const helper = await import("@warpgogol/forge/conformance");
    expect(typeof helper.consumerAvailable).toBe("function");
    expect(typeof helper.runProducerConformance).toBe("function");
  });
});

function writeForgeYaml(body: string): void {
  writeFileSync(
    join(ws, "forge.yaml"),
    `schema: forge/config@1
project:
  name: test-ws
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
${body}`,
  );
}

const VALID_PRODUCER_YAML = `contractProducers:
  - id: intake
    emit:
      argv: ["node", "scripts/emit.ts", "--out", "{bundle}"]
    mirror:
      argv: ["node", "scripts/mirror.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "validate.ts", "--bundle", "{bundle}"]
    test: "tests/intake-conformance.test.ts"
`;

function seedValidProducerFixture(): void {
  mkdirSync(join(ws, "scripts"), { recursive: true });
  writeFileSync(join(ws, "scripts/emit.ts"), "// emit\n");
  writeFileSync(join(ws, "scripts/mirror.ts"), "// mirror\n");
  mkdirSync(join(ws, "consumer"), { recursive: true });
  writeFileSync(join(ws, "consumer/validate.ts"), "// consumer validator\n");
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(
    join(ws, "tests/intake-conformance.test.ts"),
    `import { consumerAvailable } from "@warpgogol/forge/conformance";\n`,
  );
  writeForgeYaml(VALID_PRODUCER_YAML);
}

function ruleIds(diagnostics: { ruleId: string }[]): string[] {
  return diagnostics.map((d) => d.ruleId);
}

describe("forge.conformance.validate — CONF rules (AC-6)", () => {
  it("no forge.yaml → pass, zero producers", async () => {
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data?.producers).toBe(0);
  });

  it("no contractProducers → pass, zero diagnostics", async () => {
    writeForgeYaml("");
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics).toEqual([]);
  });

  it("fully wired producer → pass", async () => {
    seedValidProducerFixture();
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data?.status).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  it("CONF-01: malformed entry (missing consumer.validator.argv) → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator: {}
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data?.status).toBe("fail");
    expect(ruleIds(result.data!.diagnostics)).toContain("CONF-01");
  });

  it("CONF-01: emit.argv without {bundle} placeholder → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data?.status).toBe("fail");
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "CONF-01" && d.message.includes("{bundle}"),
      ),
    ).toBe(true);
  });

  it("CONF-02: absent test field → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "CONF-02" && d.message.includes("no test field"),
      ),
    ).toBe(true);
  });

  it("CONF-02: declared test file missing → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
    test: "tests/nope.test.ts"
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(
      result.data!.diagnostics.some((d) => d.ruleId === "CONF-02" && d.message.includes("missing")),
    ).toBe(true);
  });

  it("CONF-02: test file with no sanctioned wiring → error; helper or command path → pass", async () => {
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
    test: "tests/c.test.ts"
`);
    writeFileSync(join(ws, "tests/c.test.ts"), `// mentions producer "intake" only\n`);
    let result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data!.diagnostics.some((d) => d.ruleId === "CONF-02")).toBe(true);

    writeFileSync(join(ws, "tests/c.test.ts"), `// shells forge.conformance.run\n`);
    result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data!.diagnostics.some((d) => d.ruleId === "CONF-02")).toBe(false);
  });

  it("CONF-03: emit argv script path missing → error; resolvable → clean", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "scripts/missing.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data!.diagnostics.some((d) => d.ruleId === "CONF-03")).toBe(true);
  });

  it("CONF-03: producer-side only — consumer.validator.argv never linted (Q-9)", async () => {
    mkdirSync(join(ws, "consumer"), { recursive: true });
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["pnpm", "exec", "tsx", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "validators/does-not-exist.ts", "--bundle", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data!.diagnostics.some((d) => d.ruleId === "CONF-03")).toBe(false);
  });

  it("CONF-03: mirror argv script path missing → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["pnpm", "exec", "tsx", "{bundle}"]
    mirror:
      argv: ["node", "scripts/missing-mirror.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["pnpm", "exec", "x", "run", "v", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "CONF-03" && d.message.includes("mirror.argv"),
      ),
    ).toBe(true);
  });

  it("CONF-04: absent consumer.root → warning, not error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["pnpm", "exec", "werkstatt", "run", "emit.golden", "{bundle}"]
    mirror:
      argv: ["pnpm", "exec", "werkstatt", "run", "check.golden", "{bundle}"]
    consumer:
      root: "./no-such-checkout"
      validator:
        argv: ["pnpm", "exec", "werkstatt", "run", "x.validate", "--bundle", "{bundle}"]
    test: "tests/c.test.ts"
`);
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests/c.test.ts"), `// shells forge.conformance.run\n`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    const d = result.data!.diagnostics.find((x) => x.ruleId === "CONF-04");
    expect(d?.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("CONF-05: duplicate producer ids → error", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit: { argv: ["node", "a.ts", "{bundle}"] }
    consumer:
      root: "./consumer"
      validator: { argv: ["node", "v.ts", "{bundle}"] }
  - id: intake
    emit: { argv: ["node", "b.ts", "{bundle}"] }
    consumer:
      root: "./consumer"
      validator: { argv: ["node", "v.ts", "{bundle}"] }
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    expect(result.data!.diagnostics.some((d) => d.ruleId === "CONF-05")).toBe(true);
  });

  it("CONF-06: no mirror → warning", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: ["node", "x.ts", "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: ["node", "v.ts", "{bundle}"]
`);
    const result = await runConformanceValidate({ argv: [], flags: {} }, ctx());
    const d = result.data!.diagnostics.find((x) => x.ruleId === "CONF-06");
    expect(d?.severity).toBe("warning");
  });
});

describe("forge.conformance.run — selection + aggregate exit", () => {
  it("--all + --producer → usage error exit 2", async () => {
    writeForgeYaml(VALID_PRODUCER_YAML);
    const result = await runConformanceRun(
      { argv: [], flags: { all: true, producer: ["intake"] } },
      ctx(),
    );
    expect(result.exitCode).toBe(2);
  });

  it("unknown --producer id → usage error exit 2", async () => {
    writeForgeYaml(VALID_PRODUCER_YAML);
    const result = await runConformanceRun({ argv: [], flags: { producer: ["ghost"] } }, ctx());
    expect(result.exitCode).toBe(2);
  });

  it("no producers declared → exit 0, no verdicts", async () => {
    writeForgeYaml("");
    const result = await runConformanceRun({ argv: [], flags: { all: true } }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data?.producers).toEqual([]);
  });

  it("AC-2/AC-4: declared producer, consumer checkout absent → skip, aggregate exit 0", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./absent-consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", "process.exit(1)", "{bundle}"]
`);
    const result = await runConformanceRun({ argv: [], flags: { producer: ["intake"] } }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data?.producers[0]?.status).toBe("skip");
  });

  it("AC-5: --require-consumer → exit 1 on absent consumer; FORGE_CONFORMANCE_REQUIRE env equivalent", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./absent-consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", "process.exit(1)", "{bundle}"]
`);
    let result = await runConformanceRun({ argv: [], flags: { "require-consumer": true } }, ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data?.producers[0]?.status).toBe("fail");
    expect(result.data?.producers[0]?.diagnostics.join(" ")).toContain("consumer-missing");

    vi.stubEnv("FORGE_CONFORMANCE_REQUIRE", "1");
    result = await runConformanceRun({ argv: [], flags: {} }, ctx());
    expect(result.exitCode).toBe(1);
  });

  it("FORGE_CONFORMANCE_REQUIRE disables on 0/false/absent — skip stays exit 0", async () => {
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./absent-consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", "process.exit(1)", "{bundle}"]
`);
    for (const value of ["0", "false", "no", ""]) {
      vi.stubEnv("FORGE_CONFORMANCE_REQUIRE", value);
      const result = await runConformanceRun({ argv: [], flags: {} }, ctx());
      expect(result.exitCode, `env=${value}`).toBe(0);
      expect(result.data?.producers[0]?.status).toBe("skip");
    }
  });

  it("--json result shape pins producers[] entries (producer/status/failedLeg/legs/diagnostics)", async () => {
    mkdirSync(join(ws, "consumer"), { recursive: true });
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(CONSUMER_CHECK)}, "{bundle}"]
`);
    const result = await runConformanceRun({ argv: [], flags: { all: true } }, ctx());
    expect(result.data?.producers).toHaveLength(1);
    const entry = result.data!.producers[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      ["diagnostics", "failedLeg", "legs", "producer", "status"].sort(),
    );
    expect(entry.producer).toBe("intake");
    expect(entry.status).toBe("pass");
    expect(entry.legs.map((l) => l.leg)).toEqual(["emit", "consumer"]);
  });

  it("consumer validator non-zero → handler exit 1 with fail verdict", async () => {
    mkdirSync(join(ws, "consumer"), { recursive: true });
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", "process.exit(7)", "{bundle}"]
`);
    const result = await runConformanceRun({ argv: [], flags: { all: true } }, ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data?.producers[0]?.failedLeg).toBe("consumer");
  });

  it("emit argv deleting the bundle dir → fail emit, not a crash", async () => {
    const d = withConsumerRoot(
      decl({
        emit: {
          argv: [
            NODE,
            "-e",
            `require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})`,
            "{bundle}",
          ],
        },
      }),
    );
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("emit");
    expect(verdict.diagnostics.join(" ")).toContain("unreadable");
  });

  it("bundle tmpdir is removed after the run", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("conformance-")));
    const verdict = await runProducerConformance(withConsumerRoot(decl()), {
      repoRoot: ws,
    });
    expect(verdict.status).toBe("pass");
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("conformance-"));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });

  it("full pass against a stubbed consumer checkout → aggregate exit 0", async () => {
    mkdirSync(join(ws, "consumer"), { recursive: true });
    writeForgeYaml(`contractProducers:
  - id: intake
    emit:
      argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(EMIT_ENV)}, "{bundle}"]
    consumer:
      root: "./consumer"
      validator:
        argv: [${JSON.stringify(NODE)}, "-e", ${JSON.stringify(CONSUMER_CHECK)}, "{bundle}"]
`);
    const result = await runConformanceRun({ argv: [], flags: { producer: ["intake"] } }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data?.producers[0]?.status).toBe("pass");
  });
});
