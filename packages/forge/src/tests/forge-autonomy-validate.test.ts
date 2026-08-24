/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.autonomy.validate handler (RFC-0940, FORGE-AUTONOMY-01).</purpose>
<non-goals>
  <item>Does not test the pipeline wiring — that is covered by integration tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0940: initial unit tests for forge.autonomy.validate handler.</item>
</CHANGE_SUMMARY>
*/

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runForgeAutonomyValidate } from "../../os/core/handlers/forge-autonomy-validate.ts";
import type { ForgeRuntimeContext } from "../types.ts";

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-autonomy-"));
  mkdirSync(join(dir, "packages", "forge", "os", "core", "handlers"), { recursive: true });
  mkdirSync(join(dir, "packages", "forge", "os", "werkstatt", "handlers"), { recursive: true });
  mkdirSync(join(dir, "packages", "forge", "os", "rfc"), { recursive: true });
  return dir;
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "pretty",
  };
}

describe("forge.autonomy.validate", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("passes when no @warpgogol/werkstatt-engine imports exist", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "clean.ts"),
      `import { join } from "node:path";\nexport function foo() { return join("a", "b"); }\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  test("fails when @warpgogol/werkstatt-engine is imported outside os/werkstatt/", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "bad.ts"),
      `import { foo } from "@warpgogol/werkstatt-engine/kernel";\nexport function bar() { return foo(); }\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations).toHaveLength(1);
    expect(result.data?.violations[0]!.ruleId).toBe("FORGE-AUTONOMY-01");
    expect(result.data?.violations[0]!.specifier).toBe("@warpgogol/werkstatt-engine/kernel");
    expect(result.exitCode).toBe(1);
  });

  test("passes when @warpgogol/werkstatt-engine is imported inside os/werkstatt/", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "werkstatt", "handlers", "adapter.ts"),
      `import { foo } from "@warpgogol/werkstatt-engine/kernel";\nexport function bar() { return foo(); }\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
  });

  test("passes when @warpgogol/werkstatt-shared is imported (exempt)", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "shared.ts"),
      `import { scanDirectoryForImports } from "@warpgogol/werkstatt-shared/share/import-scan";\nexport function bar() { return scanDirectoryForImports; }\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
  });

  test("passes for type-only imports (import type)", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "type-only.ts"),
      `import type { KernelModule } from "@warpgogol/werkstatt-engine/kernel";\nexport const x: KernelModule | null = null;\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
  });

  test("passes for multi-line import type with specifier on different line", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "multiline-type.ts"),
      `import type {\n  KernelModule,\n  KernelPipelineStep,\n} from "@warpgogol/werkstatt-engine/kernel";\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
  });

  test("does not scan test files", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "bad.test.ts"),
      `import { foo } from "@warpgogol/werkstatt-engine/kernel";\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toHaveLength(0);
  });

  test("reports multiple violations from different files", async () => {
    writeFileSync(
      join(workspace, "packages", "forge", "os", "core", "handlers", "bad1.ts"),
      `import { foo } from "@warpgogol/werkstatt-engine";\n`,
    );
    writeFileSync(
      join(workspace, "packages", "forge", "os", "rfc", "bad2.ts"),
      `import { bar } from "@warpgogol/werkstatt-engine/release";\n`,
    );

    const result = await runForgeAutonomyValidate({ argv: [], flags: {} }, makeContext(workspace));

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations).toHaveLength(2);
  });
});
