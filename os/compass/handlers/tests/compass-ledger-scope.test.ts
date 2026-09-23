/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1139 AC-5: compass.audit.baseline must not seed ledger entries for
    paths under missions/ or gitignored roots — the tracked ledger only
    accumulates entries for paths that can be audited long-term.
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
import { runCompassAuditBaseline } from "../compass-audit-handler.ts";
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

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

interface LedgerEntry {
  path: string;
}

describe("compass.audit.baseline — RFC-1139 ledger scope", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-ledger-"));
    // Authored source file (plain .ts, no generated marker → authored entry)
    await mkdir(join(root, "packages", "foo"), { recursive: true });
    await writeFile(join(root, "packages", "foo", "index.ts"), "export const x = 1;\n", "utf8");
    // Mission workpiece file — would be authored but must be excluded
    await mkdir(join(root, "missions", "acme-m000001", "workpiece", "src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "missions", "acme-m000001", "workpiece", "src", "local.ts"),
      "export const y = 2;\n",
      "utf8",
    );
    // Gitignored generated dir — excluded via check-ignore
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.ts"), "export const z = 3;\n", "utf8");
    await writeFile(join(root, ".gitignore"), "dist/\nmissions/\n", "utf8");
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

  it("AC-5: baseline seeds no missions/ or gitignored ledger entries", async () => {
    const result = await runCompassAuditBaseline(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);

    const ledgerRaw = await readFile(
      join(root, "docs", "compass-audit-ledger.generated.yaml"),
      "utf8",
    );
    const ledger = yamlParse(ledgerRaw) as { entries: LedgerEntry[] };
    const paths = ledger.entries.map((e) => e.path);

    expect(paths.some((p) => p.startsWith("missions/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(paths).toContain("packages/foo/index.ts");
  });

  it("AC-5: pre-existing missions/ entries are pruned on next baseline", async () => {
    // Seed a ledger with a stale missions/ entry
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "compass-audit-ledger.generated.yaml"),
      `entries:\n  - path: missions/acme-m000001/workpiece/src/local.ts\n    entityId: ""\n    auditedRevision: abc\n    auditedHash: def\n    auditedAt: "2026-01-01T00:00:00Z"\n    verdict: baseline\n    agent: system:baseline\n`,
      "utf8",
    );

    const result = await runCompassAuditBaseline(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);

    const ledgerRaw = await readFile(
      join(root, "docs", "compass-audit-ledger.generated.yaml"),
      "utf8",
    );
    const ledger = yamlParse(ledgerRaw) as { entries: LedgerEntry[] };
    expect(ledger.entries.some((e) => e.path.startsWith("missions/"))).toBe(false);
  });
});
