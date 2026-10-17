/*
<MODULE_CONTRACT>
<purpose>
Unit tests for rfc evidence sync covering rfc.evidence.sync (RFC-1306); rfc.implement.stamp --sync (RFC-1306).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the rfc suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

import {
  EVIDENCE_SYNC_STEPS,
  EVIDENCE_SYNC_EMIT_STEP,
  runRfcEvidenceSync,
} from "../../os/rfc/handlers/rfc-evidence-sync.ts";
import type { ForgeCommandInput, ForgeInvokeResult, ForgeRuntimeContext } from "../types.ts";

function makeContext(
  invoke?: ForgeRuntimeContext["invoke"],
  workspaceRoot = "/tmp/rfc-evidence-sync-test",
): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "json",
    invoke,
  } as unknown as ForgeRuntimeContext;
}

const okReport: ForgeInvokeResult = { exitCode: 0, ok: true, filesModified: [] };

const run = (input: Partial<ForgeCommandInput>, ctx: ForgeRuntimeContext) =>
  runRfcEvidenceSync({ argv: [], flags: {}, ...input } as ForgeCommandInput, ctx);

describe("rfc.evidence.sync (RFC-1306)", () => {
  test("step list is pinned — the canonical regen order is contract", () => {
    expect(EVIDENCE_SYNC_STEPS).toEqual([
      "checks.commands.generate",
      "command.manifest.generate",
      "validator.inventory.generate",
      "docs.commands.generate",
      "ecosystem.manifest.generate",
    ]);
    expect(EVIDENCE_SYNC_EMIT_STEP).toBe("rfc.verification.emit");
  });

  test("coverage ratchet: every chain step's declared writes stay inside the sync declaration", () => {
    // RFC-1306 Risks: the chain is the canonical regen order — a step gaining
    // a generated artifact without the sync declaration covering it must fail
    // here. Source of truth is the committed command manifest (the command's
    // writes are embedded verbatim); the workspace-wide *.generated.*
    // producer set (60+ commands) is deliberately out of scope — the chain is
    // the RFC-evidence subset, not every generator.
    const manifestPath = fileURLToPath(
      new URL("../../../../docs/command-manifest.generated.yaml", import.meta.url),
    );
    const manifest = readFileSync(manifestPath, "utf8");
    const entries = manifest.split(/\n(?=  - name: )/);
    const writesOf = (name: string): string[] => {
      const entry = entries.find((e) => e.startsWith(`  - name: ${name}\n`));
      if (!entry)
        throw new Error(`command "${name}" missing from command manifest — stale fixture?`);
      const block = entry.match(/    writes:\n((?:      - .*\n)+)/);
      return block ? [...block[1]!.matchAll(/      - (.*)/g)].map((m) => m[1]!) : [];
    };
    const syncWrites = new Set(writesOf("rfc.evidence.sync"));
    expect(syncWrites.size).toBeGreaterThan(0);
    for (const step of [...EVIDENCE_SYNC_STEPS, EVIDENCE_SYNC_EMIT_STEP]) {
      for (const artifact of writesOf(step)) {
        expect(
          syncWrites.has(artifact),
          `${step} writes ${artifact} — rfc.evidence.sync's writes[] must declare every step output`,
        ).toBe(true);
      }
    }
  });

  test("EVIDENCE-SYNC-01: absent invoke port fails closed (standalone forge CLI)", async () => {
    const result = await run({ flags: { id: "RFC-9999" } }, makeContext(undefined));
    expect(result.exitCode).toBe(1);
    const violations = (result.data as { violations: Array<{ rule: string }> }).violations;
    expect(violations.map((v) => v.rule)).toEqual(["EVIDENCE-SYNC-01"]);
    expect(violations[0]!.rule).toBe("EVIDENCE-SYNC-01");
  });

  test("dry-run lists all steps and invokes nothing (AC: honors context.dryRun)", async () => {
    const invoke = vi.fn(async () => okReport);
    const ctx = makeContext(invoke);
    ctx.dryRun = true;
    const result = await run({ flags: { id: "RFC-9999" } }, ctx);
    expect(result.exitCode).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.summary).toContain(EVIDENCE_SYNC_EMIT_STEP);
  });

  test("AC-2: mid-chain step failure exits non-zero with that step's diagnostics verbatim", async () => {
    const failingDiagnostics = [
      { ruleId: "CMDGEN-04", severity: "error", message: "suspect file x.ts" },
      { ruleId: "CMDGEN-05", severity: "error", message: "control codepoint" },
    ];
    const invoke = vi.fn(async (name: string) =>
      name === "validator.inventory.generate"
        ? ({
            exitCode: 1,
            ok: false,
            data: { diagnostics: failingDiagnostics },
            summary: "inventory failed",
          } satisfies ForgeInvokeResult)
        : okReport,
    );
    const result = await run({}, makeContext(invoke));
    expect(result.exitCode).toBe(1);

    const data = result.data as {
      violations: Array<{ rule: string; step?: string; stepDiagnostics?: unknown }>;
      data: { failedStep: string; steps: Array<{ step: string; status: string }> };
    };
    expect(data.violations).toHaveLength(1);
    expect(data.violations[0]!.rule).toBe("EVIDENCE-SYNC-02");
    expect(data.violations[0]!.step).toBe("validator.inventory.generate");
    expect(data.violations[0]!.stepDiagnostics).toEqual(failingDiagnostics);
    expect(data.data.failedStep).toBe("validator.inventory.generate");
    // Steps after the failure never ran — the chain stops loud.
    expect(data.data.steps).toHaveLength(3);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test("AC-3: fully-synced tree reports all steps clean with zero changed files", async () => {
    const invoke = vi.fn(async () => okReport);
    const result = await run({ flags: { id: "RFC-9999" } }, makeContext(invoke));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      data: { steps: Array<{ step: string; status: string; filesModified: string[] }> };
    };
    expect(data.data.steps).toHaveLength(6);
    expect(data.data.steps.every((s) => s.status === "pass")).toBe(true);
    expect(data.data.steps.flatMap((s) => s.filesModified)).toEqual([]);
    expect(result.summary).toContain("0 files changed");
  });

  test("AC-4: --id appends rfc.verification.emit as the final step with the id", async () => {
    const invoke = vi.fn(async (_name: string): Promise<ForgeInvokeResult> => okReport);
    await run({ flags: { id: "RFC-1306" } }, makeContext(invoke));

    const calls = invoke.mock.calls.map(([name]) => name);
    expect(calls).toEqual([...EVIDENCE_SYNC_STEPS, EVIDENCE_SYNC_EMIT_STEP]);
    expect(invoke).toHaveBeenLastCalledWith(EVIDENCE_SYNC_EMIT_STEP, { id: "RFC-1306" });
  });

  test("no --id: only the five manifest steps run (emit skipped)", async () => {
    const invoke = vi.fn(async (_name: string): Promise<ForgeInvokeResult> => okReport);
    const result = await run({}, makeContext(invoke));
    expect(result.exitCode).toBe(0);
    const calls = invoke.mock.calls.map(([name]) => name);
    expect(calls).toEqual([...EVIDENCE_SYNC_STEPS]);
  });

  test("filesModified per step surfaces in the step report and summary", async () => {
    const invoke = vi.fn(async (name: string) =>
      name === "checks.commands.generate"
        ? {
            ...okReport,
            filesModified: ["packages/werkstatt-site/src/checks/command-tables/index.generated.ts"],
          }
        : okReport,
    );
    const result = await run({}, makeContext(invoke));
    expect(result.exitCode).toBe(0);
    const data = result.data as { data: { steps: Array<{ filesModified: string[] }> } };
    expect(data.data.steps[0]!.filesModified).toEqual([
      "packages/werkstatt-site/src/checks/command-tables/index.generated.ts",
    ]);
    expect(result.summary).toContain("1 file changed");
  });
});

// ── rfc.implement.stamp --sync (RFC-1306) ────────────────────────────────────

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runRfcImplementStamp } from "../../os/rfc/handlers/implement-stamp.ts";

const { mockRunProbe } = vi.hoisted(() => ({ mockRunProbe: vi.fn() }));
// Spread the original module — validate-rules.ts also consumes
// validateAcceptanceShape from acceptance.ts; a bare factory drops it and
// the frontmatter parse fails closed as IMP-01.
vi.mock("../../os/rfc/acceptance.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../os/rfc/acceptance.ts")>()),
  runProbe: mockRunProbe,
}));

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

async function stampWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "stamp-sync-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  await mkdir(join(dir, "docs", "rfcs"), { recursive: true });
  return dir;
}

const RFC_MD = `---
id: RFC-0100
title: "Stamp sync fixture"
status: accepted
kind: command
scope: workspace
owners:
  - architecture
createdAt: 2026-10-01
updatedAt: 2026-10-01
acceptance:
  - probe: file-exists
    path: src/index.ts
    criterion: AC-1
---

# RFC-0100

## Context
Fixture.
## Acceptance criteria

- [x] AC-1: THE thing SHALL work (evidence: test: packages/forge/x.test.ts)
`;

describe("rfc.implement.stamp --sync (RFC-1306)", () => {
  test("--sync invokes rfc.evidence.sync through the host port before stamping", async () => {
    const dir = await stampWorkspace();
    try {
      await writeFile(join(dir, "docs", "rfcs", "rfc-0100-stamp-sync.md"), RFC_MD);
      mockRunProbe.mockResolvedValue({
        probe: { probe: "file-exists", path: "src/index.ts", criterion: "AC-1" },
        ok: true,
        detail: "exists",
      });
      // Emit the evidence envelope, then commit so the stamp gates see a
      // clean RFC file and a passing envelope.
      const emit = await import("../../os/rfc/verification-evidence.ts");
      const emitResult = await emit.runRfcVerificationEmit(
        { argv: [], flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(undefined, dir),
      );
      expect(emitResult.exitCode).toBe(0);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "feat: implement RFC-0100"]);

      const invoke = vi.fn(async (_name: string): Promise<ForgeInvokeResult> => okReport);
      const result = await runRfcImplementStamp(
        {
          argv: [],
          flags: { id: "RFC-0100", sync: true },
        } as unknown as ForgeCommandInput,
        makeContext(invoke, dir),
      );
      expect(result.exitCode).toBe(0);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("rfc.evidence.sync", { id: "RFC-0100" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--sync fails closed without a kernel host (EVIDENCE-SYNC-01)", async () => {
    const dir = await stampWorkspace();
    try {
      await writeFile(join(dir, "docs", "rfcs", "rfc-0100-stamp-sync.md"), RFC_MD);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "feat: implement RFC-0100"]);

      const result = await runRfcImplementStamp(
        {
          argv: [],
          flags: { id: "RFC-0100", sync: true },
        } as unknown as ForgeCommandInput,
        makeContext(undefined, dir),
      );
      expect(result.exitCode).toBe(1);
      const violations = (result.data as { violations: Array<{ rule: string }> }).violations;
      expect(violations.map((v) => v.rule)).toContain("EVIDENCE-SYNC-01");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--sync propagates a chain failure as EVIDENCE-SYNC-02 and does not stamp", async () => {
    const dir = await stampWorkspace();
    try {
      await writeFile(join(dir, "docs", "rfcs", "rfc-0100-stamp-sync.md"), RFC_MD);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "feat: implement RFC-0100"]);

      const invoke = vi.fn(async (): Promise<ForgeInvokeResult> => ({
        exitCode: 1,
        ok: false,
        summary: 'failed at step "command.manifest.generate"',
      }));
      const result = await runRfcImplementStamp(
        {
          argv: [],
          flags: { id: "RFC-0100", sync: true },
        } as unknown as ForgeCommandInput,
        makeContext(invoke, dir),
      );
      expect(result.exitCode).toBe(1);
      const violations = (result.data as { violations: Array<{ rule: string }> }).violations;
      expect(violations.map((v) => v.rule)).toContain("EVIDENCE-SYNC-02");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
