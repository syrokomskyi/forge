/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1143 AC-1..AC-3: compass.audit.validate must skip ledger-ineligible
    authored paths (missions/, gitignored) instead of emitting COMPASS-AUDIT-01,
    report skippedIneligible/skippedPaths diagnostics, and still flag eligible
    authored files that have no ledger entry.
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCompassAuditValidate } from "../compass-audit-handler.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../../src/types.ts";

const execFileAsync = promisify(execFile);

const logger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
  getEvents() {
    return [];
  },
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    logger: logger as never,
    dryRun: false,
    outputFormat: "json",
    io: {} as never,
    actualState: undefined as never,
    fileIntents: [],
  } as unknown as ForgeRuntimeContext;
}

// missions/ is not in the default scanRoots — the real-world failure mode is a
// scoped scan (--root / site workpiece) that surfaces missions/ paths. Passing
// both roots reproduces the mixed eligible/ineligible authored set.
const SCAN_ROOTS = ["missions", "packages"];

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags: { root: SCAN_ROOTS, ...flags } } as unknown as ForgeCommandInput;
}

const MISSION_FILE = "missions/acme-m000001/workpiece/src/local.ts";
const ELIGIBLE_FILE = "packages/foo/index.ts";

describe("compass.audit.validate — RFC-1143 ledger-ineligible skips", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-validate-"));
    // Authored source file (plain .ts, no generated marker → authored entry)
    await mkdir(join(root, "packages", "foo"), { recursive: true });
    await writeFile(join(root, "packages", "foo", "index.ts"), "export const x = 1;\n", "utf8");
    // Mission workpiece file — authored but ledger-ineligible
    await mkdir(join(root, "missions", "acme-m000001", "workpiece", "src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "missions", "acme-m000001", "workpiece", "src", "local.ts"),
      "export const y = 2;\n",
      "utf8",
    );
    await writeFile(join(root, ".gitignore"), "missions/\n", "utf8");
    // Git repo for getRevisionByPath + check-ignore
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-1: no COMPASS-AUDIT-01 diagnostic for missions/ paths", async () => {
    const result = await runCompassAuditValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Array<{ file: string; ruleId: string }> })
      .diagnostics;
    expect(
      diagnostics.some((d) => d.file.startsWith("missions/")),
      "validate must not flag ledger-ineligible missions/ paths — check the eligibility partition in runCompassAuditValidate",
    ).toBe(false);
  });

  it("AC-2: result reports skippedIneligible > 0 and skippedPaths", async () => {
    const result = await runCompassAuditValidate(makeInput(), makeContext(root));
    const data = result.data as { skippedIneligible: number; skippedPaths: string[] };
    expect(data.skippedIneligible).toBeGreaterThan(0);
    expect(data.skippedPaths).toContain(MISSION_FILE);
  });

  it("AC-3: eligible authored file without ledger entry still emits COMPASS-AUDIT-01", async () => {
    const result = await runCompassAuditValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Array<{ file: string; ruleId: string }> })
      .diagnostics;
    expect(
      diagnostics.some((d) => d.file === ELIGIBLE_FILE && d.ruleId === "COMPASS-AUDIT-01"),
      "eligible authored files must still be audited — check that only ineligible paths were partitioned out",
    ).toBe(true);
  });

  it("AC-1 (strict): exits 0 when only ineligible paths would be due", async () => {
    // Seed a ledger entry for the eligible file at its current revision (1
    // commit → revision 1) so only the missions/ file would be due.
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "compass-audit-ledger.generated.yaml"),
      `entries:\n  - path: ${ELIGIBLE_FILE}\n    entityId: ""\n    auditedRevision: 1\n    auditedHash: ""\n    auditedAt: "2026-01-01T00:00:00Z"\n    verdict: pass\n    agent: human:test\n`,
      "utf8",
    );

    const result = await runCompassAuditValidate(makeInput({ strict: true }), makeContext(root));
    expect(result.exitCode).toBe(0);
    const data = result.data as { dueCount: number; skippedIneligible: number };
    expect(data.dueCount).toBe(0);
    expect(data.skippedIneligible).toBeGreaterThan(0);
  });
});
