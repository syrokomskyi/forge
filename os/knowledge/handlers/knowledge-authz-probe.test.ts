/*
<MODULE_CONTRACT>
<purpose>RFC-1468 knowledge.authz.probe tests — KAUTHZ-01 (authz-relevant without authorityRefs → error), KAUTHZ-03 (authorization-shaped entry without class → warning), clean entries green.</purpose>
<non-goals>
  <item>Not a contract source of truth — knowledge.authz.probe and RFC-1468 own the behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: assert authorization probes preserve consumer-local knowledge IDs.</item>
  <item>RFC-1481: collapse compass summaries and add missing contract blocks</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKnowledgeAuthzProbe } from "./knowledge-authz-probe.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown>) {
  return { argv: [], flags: f } as never;
}

async function seed(file: string, entry: string): Promise<void> {
  const abs = join(root, file);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, entry);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-authz-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("knowledge.authz.probe (RFC-1468)", () => {
  test("AC-3: authz-relevant entry without authorityRefs → KAUTHZ-01 error", async () => {
    await seed(
      ".agents/skills/demo/learned-principles.md",
      `### K-0001: test
\`\`\`knowledge-entry
layer: L1
class: authz-relevant
\`\`\`
Agents must never do the thing.`,
    );
    const res = await runKnowledgeAuthzProbe(flags({}), ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "KAUTHZ-01")).toBe(true);
    expect(res.exitCode).toBe(1);
  });

  test("AC-3: authorization-shaped entry without class → KAUTHZ-03 warning", async () => {
    await seed(
      ".agents/skills/demo/qa-log.md",
      `### K-0002: test
\`\`\`knowledge-entry
layer: L1
\`\`\`
Agents must not run git commit directly.`,
    );
    const res = await runKnowledgeAuthzProbe(flags({}), ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "KAUTHZ-03")).toBe(true);
    expect(res.data?.status).toBe("ok");
    expect(res.exitCode).toBe(0);
  });

  test("AC-3: factual entries stay green", async () => {
    await seed(
      ".agents/skills/demo/learned-principles.md",
      `### K-0003: test
\`\`\`knowledge-entry
layer: L1
\`\`\`
The build uses turbo.`,
    );
    const res = await runKnowledgeAuthzProbe(flags({}), ctx());
    expect(res.data?.diagnostics).toHaveLength(0);
    expect(res.exitCode).toBe(0);
  });

  test("RFC-1481: authorization diagnostics retain consumer-local L-K IDs", async () => {
    await seed(
      ".agents/skills/demo/qa-log.md",
      `### L-K-0042: local rule
\`\`\`knowledge-entry
layer: L1
\`\`\`
Agents must never run the forbidden action.`,
    );
    const res = await runKnowledgeAuthzProbe(flags({}), ctx());

    expect(res.data?.diagnostics[0]?.entry).toBe("L-K-0042");
  });
});
