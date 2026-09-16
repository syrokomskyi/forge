// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.phantom.deps.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
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
  createPhantomDepsValidateCommand,
  type PhantomDepsValidateData,
} from "./phantom-deps-validate.ts";

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

function writePkg(dir: string, deps: Record<string, string> = {}): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, dependencies: deps }));
}

function writeSrc(dir: string, file: string, content: string): void {
  const full = join(root, dir, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

async function run(): Promise<PhantomDepsValidateData> {
  const def = createPhantomDepsValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as PhantomDepsValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-phantom-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.phantom.deps.validate", () => {
  it("returns pass on empty workspace", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns fail when import is not in dependencies", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'import { z } from "zod";');
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-PHANTOM-01")).toBe(true);
  });

  it("returns pass when import is in dependencies", async () => {
    writePkg("packages/my-pkg", { zod: "^3.0.0" });
    writeSrc("packages/my-pkg", "src/index.ts", 'import { z } from "zod";');
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("ignores node: builtins and relative imports", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      'import { readFile } from "node:fs/promises";\nimport { x } from "./x";',
    );
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("detects phantom deps in dynamic imports and re-exports", async () => {
    writePkg("packages/my-pkg");
    writeSrc(
      "packages/my-pkg",
      "src/index.ts",
      'const m = await import("undici");\nexport { y } from "left-pad";',
    );
    const data = await run();
    const flagged = data.diagnostics.filter((d) => d.ruleId === "TS-PHANTOM-01");
    expect(flagged).toHaveLength(2);
  });

  it("detects phantom deps in services/* packages", async () => {
    writePkg("services/api");
    writeSrc("services/api", "src/index.ts", 'import { z } from "zod";');
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-PHANTOM-01")).toBe(true);
  });
});
