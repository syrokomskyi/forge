// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.strict.mode.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
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
  createStrictModeValidateCommand,
  type StrictModeValidateData,
} from "./strict-mode-validate.ts";

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

async function run(): Promise<StrictModeValidateData> {
  const def = createStrictModeValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as StrictModeValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-strict-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.strict.mode.validate", () => {
  it("returns pass on empty workspace", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns warn when unescaped any is found", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", "const x: any = 42;");
    const data = await run();
    expect(data.status).toBe("warn");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-STRICT-01")).toBe(true);
  });

  it("warns on as-any casts too", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", "const x = foo as any;");
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-STRICT-01")).toBe(true);
  });

  it("suppresses any on lines with eslint-disable or @ts-expect-error", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      "const x: any = 42; // eslint-disable-line\nconst y: any = 1; // @ts-expect-error\n",
    );
    const data = await run();
    expect(data.diagnostics.filter((d) => d.ruleId === "TS-STRICT-01")).toHaveLength(0);
  });

  it("warns on @ts-ignore without justification", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", "// @ts-ignore\nconst x = bad();");
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-STRICT-02")).toBe(true);
  });

  it("accepts @ts-ignore with trailing justification text", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      "// @ts-ignore — upstream types are wrong\nconst x = bad();",
    );
    const data = await run();
    expect(data.diagnostics.filter((d) => d.ruleId === "TS-STRICT-02")).toHaveLength(0);
  });

  it("warns on exported function with typed params but no return type", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", "export function f(a: number) { return a; }");
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-STRICT-03")).toBe(true);
  });

  it("passes on exported function with return type", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      "export function f(a: number): number { return a; }",
    );
    const data = await run();
    expect(data.status).toBe("pass");
  });
});
