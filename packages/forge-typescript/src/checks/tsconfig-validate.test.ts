// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.tsconfig.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
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
import { createTsconfigValidateCommand, type TsconfigValidateData } from "./tsconfig-validate.ts";

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

function writePkg(dir: string, tsconfig?: object): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir }));
  if (tsconfig !== undefined) {
    writeFileSync(join(root, dir, "tsconfig.json"), JSON.stringify(tsconfig));
  }
}

function writeBase(compilerOptions: object): void {
  writeFileSync(join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions }));
}

async function run(): Promise<TsconfigValidateData> {
  const def = createTsconfigValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as TsconfigValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-tsconfig-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.tsconfig.validate", () => {
  it("returns pass on empty workspace (no packages)", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
    expect(data.diagnostics).toHaveLength(0);
  });

  it("returns fail when tsconfig.base.json is missing but packages exist", async () => {
    writePkg("packages/my-pkg");
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-01")).toBe(true);
  });

  it("returns fail when strict is false in base config", async () => {
    writeBase({ strict: false, moduleResolution: "Bundler", target: "ES2022" });
    writePkg("packages/my-pkg");
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-02")).toBe(true);
  });

  it("returns pass when base config has strict:true and no per-package configs", async () => {
    writeBase({ strict: true, moduleResolution: "Bundler", target: "ES2022" });
    writePkg("packages/my-pkg");
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns fail on moduleResolution mismatch in a package tsconfig", async () => {
    writeBase({ strict: true, moduleResolution: "Bundler", target: "ES2022" });
    writePkg("packages/my-pkg", {
      compilerOptions: { moduleResolution: "NodeNext", target: "ES2022" },
    });
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-03")).toBe(true);
  });

  it("returns fail on target mismatch in a package tsconfig", async () => {
    writeBase({ strict: true, moduleResolution: "Bundler", target: "ES2022" });
    writePkg("packages/my-pkg", {
      compilerOptions: { moduleResolution: "Bundler", target: "ES2015" },
    });
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-04")).toBe(true);
  });

  it("returns fail when a package tsconfig.json is malformed", async () => {
    writeBase({ strict: true });
    mkdirSync(join(root, "packages/my-pkg"), { recursive: true });
    writeFileSync(join(root, "packages/my-pkg/package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(root, "packages/my-pkg/tsconfig.json"), "{ not json");
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-05")).toBe(true);
  });

  it("covers services/* packages too", async () => {
    writeBase({ strict: true, moduleResolution: "Bundler", target: "ES2022" });
    writePkg("services/api", {
      compilerOptions: { moduleResolution: "NodeNext" },
    });
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-03")).toBe(true);
  });
});
