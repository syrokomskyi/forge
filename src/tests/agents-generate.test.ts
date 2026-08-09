/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.agents.generate — behavioral layer generation,
routing table, conditional extended layer, markers, and idempotency (RFC-0548, RFC-0549).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0548: initial agents-generate tests for behavioral layer.</item>
  <item>RFC-0549: added tests for nine extended sections and key policy phrases.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentsGenerate } from "../onboarding/agents-generate.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const _WORKSPACE_ROOT = join(FORGE_ROOT, "..", "..");

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agents-gen-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function makeForgeYaml(dir: string): Promise<void> {
  const forgeYaml = [
    "schema: forge/config@1",
    "project:",
    "  name: test-project",
    "  stack: [typescript]",
    "  packageManager: pnpm",
    "paths:",
    "  rfcsDir: docs/rfcs",
    "  adrsDir: docs/adrs",
    "  plansDir: docs/plans",
    "  auditsDir: docs/audits",
    "  specsDir: docs/specs",
    "  skillsDir: .agents/skills",
    "bindings:",
    "  schema: forge/bindings@1",
    "  commands:",
    "    validateRfc: pnpm exec forge rfc.validate",
    "    validateAdr: pnpm exec forge adr.validate",
    "    typecheck: null",
    "    test: null",
    "    scopedBuild: null",
    "    implementStamp: pnpm exec forge rfc.implement.stamp",
    "    specValidate: pnpm exec forge spec.validate",
    "    sessionSave: pnpm exec forge session.save",
    "  paths:",
    "    invariantsFile: docs/architecture-dna.md",
    "    reviewsDir: docs/reviews",
    "    handoffsDir: docs/handoffs",
    "    sessionsDir: docs/sessions",
    "    compassDocs: [docs/requirements.xml]",
    "forge:",
    "  syncedVersion: 0.1.2",
  ].join("\n");
  await writeFile(join(dir, "forge.yaml"), forgeYaml, "utf8");
}

test("agents-generate produces AGENTS.md with behavioral layer markers", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("<!-- forge:begin behavioral-layer -->");
  expect(agentsMd).toContain("<!-- forge:end behavioral-layer -->");
});

test("agents-generate includes intent-to-skill routing table", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("### Intent-to-skill routing");
  expect(agentsMd).toContain("| Operator says something like | Skill |");
  // Should contain at least one skill name from the registry
  expect(agentsMd).toContain("fo-");
});

test("agents-generate includes fixed policy text sections", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("### Auto-grilling");
  expect(agentsMd).toContain("### Creator-facing communication");
  expect(agentsMd).toContain("### Safety net and graceful failure");
  expect(agentsMd).toContain("### Adaptive learning");
  expect(agentsMd).toContain("### Pushback policy");
});

test("agents-generate defaults to business register (no extended layer)", async () => {
  await makeForgeYaml(tempDir);
  // No PREFERENCES.md → defaults to business
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("The current register is **business**");
  expect(agentsMd).not.toContain("Extended behavioral layer (RFC-0549)");
});

test("agents-generate includes extended layer when register is creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("The current register is **creative**");
  expect(agentsMd).toContain("Extended behavioral layer (creative register)");
});

test("agents-generate extended layer includes all nine sections when creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("#### Personal connection");
  expect(agentsMd).toContain("#### Creative memory");
  expect(agentsMd).toContain("#### Emotional rhythm");
  expect(agentsMd).toContain("#### Gentle accountability");
  expect(agentsMd).toContain("#### Creative partnership");
  expect(agentsMd).toContain("#### Visual thinking");
  expect(agentsMd).toContain("#### Audience empathy");
  expect(agentsMd).toContain("#### Creative companion");
  expect(agentsMd).toContain("#### Creative confidence");
});

test("agents-generate extended layer includes key policy phrases when creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  // Questions not declarations
  expect(agentsMd).toContain("do NOT declare");
  // Outcome-based praise
  expect(agentsMd).toContain("outcome-based praise");
  // Never refuse creative direction
  expect(agentsMd).toContain("Never refuse creative direction");
  // Companion mode session saving flag
  expect(agentsMd).toContain("saveCompanionSessions");
  // Inspiration feed pull-only
  expect(agentsMd).toContain("pull-only");
});

test("agents-generate extended layer is absent when register is business", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: business\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).not.toContain("Extended behavioral layer (creative register)");
  expect(agentsMd).not.toContain("#### Personal connection");
  expect(agentsMd).not.toContain("#### Creative companion");
});

test("agents-generate is idempotent — running twice produces the same content", async () => {
  await makeForgeYaml(tempDir);

  const ctx = makeContext(tempDir);
  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const first = await readFile(join(tempDir, "AGENTS.md"), "utf8");

  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const second = await readFile(join(tempDir, "AGENTS.md"), "utf8");

  expect(second).toBe(first);
});

test("agents-generate refuses to overwrite hand-written AGENTS.md", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(join(tempDir, "AGENTS.md"), "# Hand-written\nNo marker.\n", "utf8");

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
});

// RFC-0611: nested AGENTS.md generation tests

test("agents-generate generates nested AGENTS.md for workspace directories", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({
      name: "@test/my-pkg",
      description: "A test package",
      exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
      scripts: { "build:check": "tsc --noEmit" },
      dependencies: { zod: "^4.4.3" },
    }),
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.generated).toContain("packages/my-pkg/AGENTS.md");

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toContain("GENERATED");
  expect(nested).toContain("`@test/my-pkg` — Agent Guide");
  expect(nested).toContain("A test package");
  expect(nested).toContain("Package");
  expect(nested).toContain("## Entry points");
  expect(nested).toContain("## Scripts");
  expect(nested).toContain("## Dependencies");
});

test("agents-generate skips hand-written nested AGENTS.md", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg" }),
  );
  await writeFile(
    join(tempDir, "packages", "my-pkg", "AGENTS.md"),
    "# Custom\nNo marker.\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.skipped).toContain("packages/my-pkg/AGENTS.md (hand-written)");

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toBe("# Custom\nNo marker.\n");
});

test("agents-generate regenerates stale generated nested AGENTS.md", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg" }),
  );
  await writeFile(
    join(tempDir, "packages", "my-pkg", "AGENTS.md"),
    "<!--\n  GENERATED. Do not change this line unless the file contains project specific changes.\n-->\n# Old content\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.generated).toContain("packages/my-pkg/AGENTS.md");

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toContain("`@test/my-pkg` — Agent Guide");
  expect(nested).not.toContain("Old content");
});

test("agents-generate nested idempotency — running twice produces same content", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg", description: "Test" }),
  );

  const ctx = makeContext(tempDir);
  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const first = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");

  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const second = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");

  expect(second).toBe(first);
});

test("agents-generate with no workspaces generates only root AGENTS.md", async () => {
  await makeForgeYaml(tempDir);

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.generated).toEqual(["AGENTS.md"]);
  expect(result.data?.skipped).toEqual([]);
});

test("agents-generate dryRun mode produces renderedFiles without writing", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg" }),
  );

  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  expect(result.exitCode).toBe(0);
  expect(result.data?.renderedFiles).toBeDefined();
  expect(result.data?.renderedFiles?.["AGENTS.md"]).toContain("Agent Guide: test-project");
  expect(result.data?.renderedFiles?.["packages/my-pkg/AGENTS.md"]).toContain(
    "`@test/my-pkg` — Agent Guide",
  );

  // Files should NOT exist on disk
  expect(existsSync(join(tempDir, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(tempDir, "packages", "my-pkg", "AGENTS.md"))).toBe(false);
});

test("agents-generate dryRun mode skips edit guard for hand-written root", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(join(tempDir, "AGENTS.md"), "# Hand-written\nNo marker.\n", "utf8");

  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  expect(result.exitCode).toBe(0);
  expect(result.data?.renderedFiles?.["AGENTS.md"]).toContain("Agent Guide: test-project");
});

test("agents-generate nested with empty package.json falls back to path-based title", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "my-pkg", "package.json"), "{}");

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toContain("`packages/my-pkg` — Agent Guide");
  expect(nested).not.toContain("## Entry points");
  expect(nested).not.toContain("## Scripts");
  expect(nested).not.toContain("## Dependencies");
});

test("agents-generate nested renders entry points from exports map", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({
      name: "@test/my-pkg",
      exports: {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./port": { types: "./src/port.ts", default: "./src/port.ts" },
        "./client": "./src/client.ts",
      },
    }),
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toContain("## Entry points");
  expect(nested).toContain("| `@test/my-pkg` | `./src/index.ts` |");
  expect(nested).toContain("| `@test/my-pkg/port` | `./src/port.ts` |");
  expect(nested).toContain("| `@test/my-pkg/client` | `./src/client.ts` |");
});

test("agents-generate nested separates workspace and external dependencies", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({
      name: "@test/my-pkg",
      dependencies: {
        "@warpgogol/share": "workspace:*",
        zod: "^4.4.3",
      },
    }),
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const nested = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(nested).toContain("**Workspace:**");
  expect(nested).toContain("- `@warpgogol/share`");
  expect(nested).toContain("**External:**");
  expect(nested).toContain("- `zod` `^4.4.3`");
});

test("agents-generate nested for service workspace omits entry points", async () => {
  await makeForgeYaml(tempDir);
  await mkdir(join(tempDir, "services", "my-svc"), { recursive: true });
  await writeFile(
    join(tempDir, "services", "my-svc", "package.json"),
    JSON.stringify({
      name: "@test/my-svc",
      scripts: { "build:check": "tsc --noEmit", "run:once": "tsx src/run.ts" },
      dependencies: { "@warpgogol/observability": "workspace:*" },
    }),
  );
  await writeFile(join(tempDir, "services", "my-svc", "Dockerfile"), "FROM node:20\n");

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const nested = await readFile(join(tempDir, "services", "my-svc", "AGENTS.md"), "utf8");
  expect(nested).toContain("`@test/my-svc` — Agent Guide");
  expect(nested).toContain("Service");
  expect(nested).not.toContain("## Entry points");
  expect(nested).toContain("## Scripts");
  expect(nested).toContain("## Dependencies");
});
