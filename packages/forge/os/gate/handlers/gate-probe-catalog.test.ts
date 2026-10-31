/*
<MODULE_CONTRACT>
<purpose>RFC-1469 gate.probe.catalog tests — contract coverage + unprobed error-severity rules.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGateProbeCatalog } from "./gate-probe-catalog.ts";
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

describe("gate.probe.catalog (RFC-1469)", () => {
  test("AC-5: catalog reports contract coverage + unprobed error rules", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "validator-inventory.generated.yaml"),
      `validators:
  - rules:
      - id: DEMO-19
        severity: error
      - id: UNPROBED-01
        severity: error
      - id: STALE-77
        severity: warning
`,
    );
    const res = await runGateProbeCatalog(flags({}), ctx({}));
    expect(res.data?.contracts[0]?.rules[0]?.rule).toBe("DEMO-19");
    expect(res.data?.unprobedErrorRules).toContain("UNPROBED-01");
    expect(res.data?.unprobedErrorRules).not.toContain("DEMO-19");
  });
});
