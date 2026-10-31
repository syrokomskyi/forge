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
  /** Mock the scratch-workspace exec — the check's real run happens there. */
  execOut?: { stdout: string; stderr: string; exitCode: number };
}): ForgeRuntimeContext {
  const io = {
    exists: async () => true,
    readFile: async (p: string) => p.endsWith("fixture.yaml") ? FIXTURE : "",
    writeFile: async () => {},
    mkdir: async () => {},
    readdir: async (p: string) => {
      if (p.endsWith("gate-probes")) return [{ name: "demo", isDirectory: true, isFile: false }];
      if (p.endsWith("demo")) return [{ name: "DEMO-19", isDirectory: true, isFile: false }];
      return [{ name: "fixture.yaml", isDirectory: false, isFile: true }];
    },
    exec: async () => opts.execOut ?? { stdout: '{"data":{"diagnostics":[{}]}}', stderr: "", exitCode: 1 },
  };
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
    io: io as never,
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
      ctx({ execOut: { stdout: '{"data":{"diagnostics":[{}]}}', stderr: "", exitCode: 1 } }),
    );
    expect(res.data?.reports[0]?.status).toBe("pass");
    expect(res.data?.status).toBe("ok");
    expect(res.exitCode).toBe(0);
  });

  test("AC-4: check silent on the seeded violation → fail (dead gate)", async () => {
    const res = await runGateProbe(
      flags({}),
      ctx({ execOut: { stdout: '{"data":{"diagnostics":[]}}', stderr: "", exitCode: 0 } }),
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

