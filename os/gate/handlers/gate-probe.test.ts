/*
<MODULE_CONTRACT>
<purpose>RFC-1469 gate.probe tests — check fires on the seeded violation (liveness), dead-gate fail detection, --list inventory.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGateProbe } from "./gate-probe.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

const FIXTURE = `rule: DEMO-19
contract: demo
derivedFrom: F-0011
spec:
  files:
    demo/broken.md: |
      content
expect:
  rule: DEMO-19
  minDiagnostics: 1
`;

function ctx(opts: {
  invoke?: (cmd: string) => { exitCode: number; ok: boolean; data?: unknown };
}): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
    invoke: opts.invoke
      ? async (cmd: string) => ({ ...opts.invoke!(cmd), filesModified: [] })
      : undefined,
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown>) {
  return { argv: [], flags: f } as never;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gate-probe-"));
  await mkdir(join(root, "docs", "gate-probes", "demo", "DEMO-19"), { recursive: true });
  await writeFile(join(root, "docs", "gate-probes", "demo", "DEMO-19", "fixture.yaml"), FIXTURE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gate.probe (RFC-1469)", () => {
  test("AC-3: bound check fires on the seeded violation → pass", async () => {
    const res = await runGateProbe(
      flags({}),
      ctx({ invoke: () => ({ exitCode: 1, ok: false, data: { diagnostics: [{}] } }) }),
    );
    expect(res.data?.reports[0]?.status).toBe("pass");
    expect(res.data?.status).toBe("ok");
    expect(res.exitCode).toBe(0);
  });

  test("AC-4: check silent on the seeded violation → fail (dead gate)", async () => {
    const res = await runGateProbe(
      flags({}),
      ctx({ invoke: () => ({ exitCode: 0, ok: true, data: { diagnostics: [] } }) }),
    );
    expect(res.data?.reports[0]?.status).toBe("fail");
    expect(res.data?.reports[0]?.detail).toContain("dead");
    expect(res.data?.status).toBe("failures");
    expect(res.exitCode).toBe(1);
  });

  test("AC-4: --list inventories fixtures without executing", async () => {
    const res = await runGateProbe(flags({ list: true }), ctx({}));
    expect(res.data?.probed).toBe(1);
    expect(res.data?.reports[0]?.fixture).toContain("fixture.yaml");
    expect(res.exitCode).toBe(0);
  });
});

