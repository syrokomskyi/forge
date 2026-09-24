/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1143 AC-4: compass.audit.plan must not list ledger-ineligible paths
    (missions/, gitignored) in its due work-order items and must report the
    skippedIneligible count.
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCompassAuditPlan } from "../compass-audit-handler.ts";
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

// missions/ is not in the default scanRoots — pass both roots so the fixture
// produces a mixed eligible/ineligible authored set.
const SCAN_ROOTS = ["missions", "packages"];

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags: { root: SCAN_ROOTS, ...flags } } as unknown as ForgeCommandInput;
}

const ELIGIBLE_FILE = "packages/foo/index.ts";

describe("compass.audit.plan — RFC-1143 ledger-ineligible skips", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-plan-"));
    await mkdir(join(root, "packages", "foo"), { recursive: true });
    await writeFile(join(root, "packages", "foo", "index.ts"), "export const x = 1;\n", "utf8");
    await mkdir(join(root, "missions", "acme-m000001", "workpiece", "src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "missions", "acme-m000001", "workpiece", "src", "local.ts"),
      "export const y = 2;\n",
      "utf8",
    );
    await writeFile(join(root, ".gitignore"), "missions/\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-4: due items exclude ledger-ineligible paths and report skippedIneligible", async () => {
    const result = await runCompassAuditPlan(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      items: Array<{ path: string }>;
      skippedIneligible: number;
    };
    expect(
      data.items.some((i) => i.path.startsWith("missions/")),
      "plan must not emit work orders for ledger-ineligible paths — check the eligibility partition in runCompassAuditPlan",
    ).toBe(false);
    expect(data.items.some((i) => i.path === ELIGIBLE_FILE)).toBe(true);
    expect(data.skippedIneligible).toBeGreaterThan(0);
  });
});
