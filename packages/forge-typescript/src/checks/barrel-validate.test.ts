// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.barrel.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: replace load-verification stub with execute()-seam tests.</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  KernelCommandInput,
  KernelLogger,
  KernelRuntimeContext,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { createBarrelValidateCommand, type BarrelValidateData } from "./barrel-validate.ts";

const noopLogger: KernelLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  event: () => {},
  getEvents: () => [],
};

function ctx(workspaceRoot: string): KernelRuntimeContext {
  return {
    workspaceRoot,
    siteExplicit: false,
    logger: noopLogger,
    dryRun: false,
    outputFormat: "json",
    io: undefined as never,
    actualState: undefined as never,
  };
}

const input: KernelCommandInput = { argv: [], flags: {} };

let root: string;

function writePkg(dir: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir }));
}

function writeSrc(dir: string, file: string, content: string): void {
  const full = join(root, dir, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

async function run(): Promise<BarrelValidateData> {
  const def = createBarrelValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as BarrelValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-barrel-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.barrel.validate", () => {
  it("returns pass on empty workspace", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns warn when barrel re-exports a Node-only module", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'export { readFile } from "node:fs/promises";');
    const data = await run();
    expect(data.status).toBe("warn");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-BARREL-02")).toBe(true);
  });

  it("warns when barrel imports a Node-only module", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      'import { readFile } from "node:fs/promises";\nexport const x = readFile;',
    );
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-BARREL-01")).toBe(true);
  });

  it("ignores node: imports in non-barrel files", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/util.ts",
      'import { readFile } from "node:fs/promises";\nexport const x = readFile;',
    );
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("passes on a clean barrel", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'export { x } from "./x";');
    const data = await run();
    expect(data.status).toBe("pass");
  });
});
