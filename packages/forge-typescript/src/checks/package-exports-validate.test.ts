// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.package.exports.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
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
import {
  createPackageExportsValidateCommand,
  type PackageExportsValidateData,
} from "./package-exports-validate.ts";

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

function writePkg(dir: string, pkgJson: object): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkgJson));
}

function writeFile(dir: string, file: string, content: string): void {
  const full = join(root, dir, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

async function run(): Promise<PackageExportsValidateData> {
  const def = createPackageExportsValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as PackageExportsValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-exports-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.package.exports.validate", () => {
  it("returns pass on empty workspace", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns fail when exports entry points to non-existent file", async () => {
    writePkg("packages/my-pkg", {
      name: "my-pkg",
      exports: { ".": "./src/index.ts" },
    });
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-EXPORTS-01")).toBe(true);
  });

  it("returns pass when exports entry points to existing file", async () => {
    writePkg("packages/my-pkg", {
      name: "my-pkg",
      exports: { ".": "./src/index.ts" },
    });
    writeFile("packages/my-pkg", "src/index.ts", "export {}");
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("resolves conditional exports (types/default/import/require)", async () => {
    writePkg("packages/my-pkg", {
      name: "my-pkg",
      exports: {
        ".": {
          types: "./src/index.d.ts",
          default: "./src/index.ts",
        },
      },
    });
    writeFile("packages/my-pkg", "src/index.ts", "export {}");
    const data = await run();
    // types target missing → one TS-EXPORTS-01
    expect(data.diagnostics.filter((d) => d.ruleId === "TS-EXPORTS-01")).toHaveLength(1);
  });

  it("checks exports in services/* packages", async () => {
    writePkg("services/api", {
      name: "api",
      exports: { ".": "./src/index.ts" },
    });
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-EXPORTS-01")).toBe(true);
  });
});
