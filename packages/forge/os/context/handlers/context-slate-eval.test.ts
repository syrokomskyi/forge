/*
<MODULE_CONTRACT>
<purpose>RFC-1470 context.slate.eval tests — recall@budget over the devset; missing index/devset block honestly.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSlateEval } from "./context-slate-eval.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-eval-"));
  await mkdir(join(root, "docs", ".index", "context"), { recursive: true });
  await mkdir(join(root, "docs", "context-devset"), { recursive: true });
  await writeFile(join(root, "docs", ".index", "context", "index.yaml"), `schema: forge/context-index@1
units:
  - id: "friction:F-0009"
    kind: friction
    source: "docs/frictions.yaml#F-0009"
    tokens: 50
    text: "F-0009 [process]: scar bullets accumulate without a migration path"
    meta: {}
`);
  await writeFile(join(root, "docs", "context-devset", "t1.yaml"), `task: migrate friction scars
requiredUnits:
  - "friction:F-0009"
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("context.slate.eval (RFC-1470)", () => {
  test("required unit found in slate → recall 1.0", async () => {
    const res = await runSlateEval(flags({ budget: 4000 }), ctx());
    expect(res.data?.tasks).toBe(1);
    expect(res.data?.recall).toBe(1);
    expect(res.exitCode).toBe(0);
  });

  test("missing index → CONTEXT-01 block", async () => {
    await rm(join(root, "docs", ".index", "context", "index.yaml"));
    const res = await runSlateEval(flags({}), ctx());
    expect(res.exitCode).toBe(1);
  });
});
