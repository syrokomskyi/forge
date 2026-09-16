// @vitest-environment node

/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for ts.import.boundaries.validate through the execute() seam (RFC-1099, DNA-100).</purpose>
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
  createImportBoundariesValidateCommand,
  type ImportBoundariesValidateData,
} from "./import-boundaries-validate.ts";

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

async function run(): Promise<ImportBoundariesValidateData> {
  const def = createImportBoundariesValidateCommand();
  const result = await def.execute(input, ctx(root));
  return result?.data as ImportBoundariesValidateData;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-boundaries-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ts.import.boundaries.validate", () => {
  it("returns pass on empty workspace", async () => {
    const data = await run();
    expect(data.status).toBe("pass");
  });

  it("returns fail when a packages file imports from apps", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'import { foo } from "apps/my-app/src/foo";');
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-IMPORT-01")).toBe(true);
  });

  it("returns fail when a packages file imports from missions", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'import { m } from "../missions/m1/x";');
    const data = await run();
    expect(data.status).toBe("fail");
    expect(data.diagnostics.some((d) => d.ruleId === "TS-IMPORT-02")).toBe(true);
  });

  it("flags apps imports inside services/* packages too", async () => {
    writePkg("services/api");
    writeSrc("services/api", "src/index.ts", 'import { foo } from "apps/my-app/src/foo";');
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-IMPORT-01")).toBe(true);
  });

  it("flags boundary violations in re-exports", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'export { foo } from "apps/my-app/src/foo";');
    const data = await run();
    expect(data.diagnostics.some((d) => d.ruleId === "TS-IMPORT-01")).toBe(true);
  });

  it("returns pass when packages file has no boundary violations", async () => {
    writePkg("packages/my-pkg");
    writeSrc("packages/my-pkg", "src/index.ts", 'import { foo } from "./foo";');
    const data = await run();
    expect(data.status).toBe("pass");
  });
});
