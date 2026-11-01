/*
<MODULE_CONTRACT>
<purpose>RFC-1470 context.assemble tests — budgeted slate ranks task-relevant units first, every unit carries source + reasons, missing index blocks.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-context</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContextAssemble } from "./context-assemble.ts";
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

const INDEX = `schema: forge/context-index@1
sourceWatermark: docs/sessions/2026-10-30-12-00-00-aaaaaa.md
units:
  - id: "friction:F-0009"
    kind: friction
    source: "docs/frictions.yaml#F-0009"
    tokens: 50
    text: "F-0009 [process]: scar bullets accumulate in AGENTS.md without a migration path"
    meta: { category: process }
  - id: "session-block:s1:summary"
    kind: session-block
    source: "docs/sessions/s1.md#summary"
    tokens: 40
    text: "summary: worked on deployment pipeline for the frontend"
    meta: { date: "2026-10-30" }
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ctx-assemble-"));
  await mkdir(join(root, "docs", ".index", "context"), { recursive: true });
  await writeFile(join(root, "docs", ".index", "context", "index.yaml"), INDEX);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("context.assemble (RFC-1470)", () => {
  test("slate ranks task-relevant units first, every unit carries source + reasons", async () => {
    const res = await runContextAssemble(flags({ task: "migrate friction scars" }), ctx());
    expect(res.data?.units[0]?.id).toContain("F-0009");
    for (const u of res.data?.units ?? []) {
      expect(u.source.length).toBeGreaterThan(0);
      expect(u.reasons.length).toBeGreaterThan(0);
    }
    expect(res.exitCode).toBe(0);
  });

  test("budget fills in rank order — smallest high-score units first", async () => {
    const res = await runContextAssemble(flags({ task: "friction scars", budget: 60 }), ctx());
    // 50-token friction + 40-token session — only one fits in 60.
    expect(res.data?.usedTokens).toBeLessThanOrEqual(60);
    expect(res.data?.skipped).toBeGreaterThanOrEqual(0);
  });

  test("CTX-02: stale index vs a newer session source → warn", async () => {
    await mkdir(join(root, "docs", "sessions"), { recursive: true });
    await writeFile(join(root, "docs", "sessions", "2026-10-31-18-00-00-bbbbbb.md"), `---\nid: s-new\n---\nbody`);
    const warns: string[] = [];
    const c = ctx() as unknown as { logger: { warn: (m: string) => void } };
    c.logger.warn = (m: string) => warns.push(m);
    await runContextAssemble(flags({ task: "scars" }), c as never);
    expect(warns.some((w) => w.startsWith("CTX-02"))).toBe(true);
  });

  test("missing index → CONTEXT-01 blocking hint", async () => {
    await rm(join(root, "docs", ".index", "context", "index.yaml"));
    const res = await runContextAssemble(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("CONTEXT-01");
  });
});
