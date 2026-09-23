/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1143 AC-5: compass.audit.record on a ledger-ineligible path (missions/,
    gitignored) still writes the entry (operator intent wins) but emits a
    warning that the next baseline run will sweep it.
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as yamlParse } from "yaml";
import { runCompassAuditRecord } from "../compass-audit-handler.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../../src/types.ts";

const execFileAsync = promisify(execFile);

const warnings: string[] = [];
const logger = {
  section() {},
  info() {},
  warn(msg: string) {
    warnings.push(msg);
  },
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

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

const MISSION_FILE = "missions/acme-m000001/workpiece/src/local.ts";

describe("compass.audit.record — RFC-1143 ineligible-path warning", () => {
  let root: string;

  beforeEach(async () => {
    warnings.length = 0;
    root = await mkdtemp(join(tmpdir(), "compass-record-"));
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

  it("AC-5: record on ineligible path writes the entry and warns about the sweep", async () => {
    const absTarget = join(root, MISSION_FILE);
    const result = await runCompassAuditRecord(
      makeInput({ file: absTarget, verdict: "pass", agent: "agent:test" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);

    // Entry was written despite ineligibility (operator intent wins)
    const ledgerRaw = await readFile(
      join(root, "docs", "compass-audit-ledger.generated.yaml"),
      "utf8",
    );
    const ledger = yamlParse(ledgerRaw) as { entries: Array<{ path: string }> };
    expect(ledger.entries.some((e) => e.path === MISSION_FILE)).toBe(true);

    // Warning about the next baseline sweep was emitted
    expect(
      warnings.some((w) => w.includes("ledger-ineligible") && w.includes("baseline")),
      "record must warn that an ineligible entry will be swept by the next baseline run",
    ).toBe(true);
  });
});
