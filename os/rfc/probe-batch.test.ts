/*
<MODULE_CONTRACT>
<purpose>
Unit tests for probe-batch — segment planning across barriers, per-(file,testName) report attribution, runProbeSet ordering and --no-batch escape, and the one-spawn e2e (RFC-1489).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1489: batched test-probe planning + attribution coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planProbeSegments,
  attributeProbeResult,
  runBatchedTestSegment,
  type ProbeSegment,
} from "./probe-batch.ts";
import { runProbeSet } from "./acceptance.ts";
import type { AcceptanceProbe } from "./types.ts";

const WORKSPACE_ROOT = join(__dirname, "..", "..", "..", "..");

const testProbe = (
  file: string,
  overrides: Partial<Extract<AcceptanceProbe, { probe: "test" }>> = {},
): Extract<AcceptanceProbe, { probe: "test" }> => ({
  probe: "test",
  file,
  expect: { exitCode: 0 },
  ...overrides,
});

const fileExists = (path: string): AcceptanceProbe => ({ probe: "file-exists", path });
const runProbe = (command: string): AcceptanceProbe => ({
  probe: "run",
  command,
  expect: { exitCode: 0 },
});

describe("planProbeSegments — AC-1 barrier-free grouping", () => {
  test("contiguous same-bound test probes form one segment", () => {
    const probes = [
      testProbe("a.test.ts"),
      testProbe("b.test.ts"),
      testProbe("c.test.ts", { timeoutMs: 120_000 }),
    ];
    expect(planProbeSegments(probes, 120_000)).toEqual([
      { start: 0, members: [0, 1, 2], boundMs: 120_000 },
    ]);
  });

  test("a timeoutMs change closes the segment", () => {
    const probes = [
      testProbe("a.test.ts"),
      testProbe("b.test.ts", { timeoutMs: 5_000 }),
      testProbe("c.test.ts"),
    ];
    expect(planProbeSegments(probes, 120_000)).toEqual([
      { start: 0, members: [0], boundMs: 120_000 },
      { start: 1, members: [1], boundMs: 5_000 },
      { start: 2, members: [2], boundMs: 120_000 },
    ]);
  });

  test("run/page/proof are the only barriers — other kinds span without splitting", () => {
    const probes: AcceptanceProbe[] = [
      testProbe("a.test.ts"),
      runProbe("site-kernel run x"),
      testProbe("b.test.ts"),
      { probe: "page", target: "site", path: "/", expect: { status: 200 } } as AcceptanceProbe,
      testProbe("c.test.ts"),
      { probe: "proof", spec: "s.yaml" },
      testProbe("d.test.ts"),
      fileExists("x.txt"),
      testProbe("e.test.ts"),
    ];
    expect(planProbeSegments(probes, 120_000)).toEqual([
      { start: 0, members: [0], boundMs: 120_000 },
      { start: 2, members: [2], boundMs: 120_000 },
      { start: 4, members: [4], boundMs: 120_000 },
      { start: 6, members: [6, 8], boundMs: 120_000 },
    ]);
  });
});

describe("attributeProbeResult — AC-2/AC-3 per-slice attribution", () => {
  const report = {
    testResults: [
      {
        name: join(WORKSPACE_ROOT, "os/rfc/a.test.ts"),
        status: "passed",
        assertionResults: [
          { title: "first", fullName: "suite first", status: "passed" },
          { title: "second", fullName: "suite second", status: "passed" },
        ],
      },
      {
        name: join(WORKSPACE_ROOT, "os/rfc/b.test.ts"),
        status: "failed",
        assertionResults: [
          { title: "x", fullName: "bsuite x", status: "failed" },
          { title: "y", fullName: "bsuite y", status: "passed" },
        ],
      },
    ],
  };

  test("each probe derives only from its own file slice", () => {
    const a = attributeProbeResult(testProbe("os/rfc/a.test.ts"), WORKSPACE_ROOT, report);
    const b = attributeProbeResult(testProbe("os/rfc/b.test.ts"), WORKSPACE_ROOT, report);
    expect(a.ok).toBe(true);
    expect(a.verdict).toBe("pass");
    expect(b.ok).toBe(false);
    expect(b.verdict).toBe("fail");
    expect(b.detail).toContain("expected 0");
  });

  test("testName attribution matches only its own assertions", () => {
    const ok = attributeProbeResult(
      testProbe("os/rfc/b.test.ts", { testName: "bsuite y" }),
      WORKSPACE_ROOT,
      report,
    );
    expect(ok.ok).toBe(true);
    const fail = attributeProbeResult(
      testProbe("os/rfc/b.test.ts", { testName: "bsuite x" }),
      WORKSPACE_ROOT,
      report,
    );
    expect(fail.ok).toBe(false);
  });

  test("expected-nonzero exitCode inverts the derived verdict", () => {
    const p = attributeProbeResult(
      testProbe("os/rfc/b.test.ts", { expect: { exitCode: 1 } }),
      WORKSPACE_ROOT,
      report,
    );
    expect(p.ok).toBe(true);
    expect(p.verdict).toBe("pass");
  });

  test("absent file slice is unverified, never pass", () => {
    const p = attributeProbeResult(testProbe("os/rfc/missing.test.ts"), WORKSPACE_ROOT, report);
    expect(p.ok).toBe(false);
    expect(p.verdict).toBe("unverified");
  });

  test("testName matching no assertion is a fail (vitest -t parity, spec §4)", () => {
    const p = attributeProbeResult(
      testProbe("os/rfc/a.test.ts", { testName: "no such test" }),
      WORKSPACE_ROOT,
      report,
    );
    expect(p.ok).toBe(false);
    expect(p.verdict).toBe("fail");
    expect(p.detail).toContain("no testName match");
  });

  test("file-level requires status passed — skipped cannot prove execution", () => {
    const skipped = {
      testResults: [
        {
          name: join(WORKSPACE_ROOT, "os/rfc/s.test.ts"),
          status: "skipped",
          assertionResults: [{ title: "x", fullName: "s x", status: "skipped" }],
        },
      ],
    };
    const p = attributeProbeResult(testProbe("os/rfc/s.test.ts"), WORKSPACE_ROOT, skipped);
    expect(p.ok).toBe(false);
    expect(p.verdict).not.toBe("pass");
  });
});

describe("runProbeSet — AC-2 order/shape, AC-4 --no-batch", () => {
  test("preserves declared order across barriers; missing files are unverified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-set-"));
    try {
      writeFileSync(join(dir, "present.txt"), "x");
      const probes: AcceptanceProbe[] = [
        fileExists("present.txt"),
        testProbe("missing-a.test.ts"),
        testProbe("missing-b.test.ts"),
        fileExists("absent.txt"),
        testProbe("missing-c.test.ts"),
      ];
      const { results, durationsMs } = await runProbeSet(probes, { workspaceRoot: dir });
      expect(results).toHaveLength(5);
      expect(results[0]!.ok).toBe(true);
      expect(results[1]!.verdict).toBe("unverified");
      expect(results[1]!.detail).toContain("missing-a.test.ts");
      expect(results[2]!.verdict).toBe("unverified");
      expect(results[3]!.ok).toBe(false);
      expect(results[3]!.verdict).not.toBe("unverified");
      // Indexes 1,2,4 are all same-bound test probes with no run/page/proof
      // barrier between them — they share ONE segment; each missing file is
      // attributed unverified from its own slice.
      expect(results[4]!.verdict).toBe("unverified");
      expect(results[4]!.detail).toContain("missing-c.test.ts");
      expect(durationsMs).toHaveLength(5);
      // Each batched result echoes its own declared probe.
      results.forEach((r, i) => expect(r.probe).toBe(probes[i]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-batch forces the legacy per-probe path (spawn-failure != unverified)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-set-nb-"));
    try {
      const probes = [testProbe("missing-a.test.ts"), testProbe("missing-b.test.ts")];
      const legacy = await runProbeSet(probes, { workspaceRoot: dir, noBatch: true });
      // Legacy spawns vitest per probe in the tmp workspace — the spawn fails,
      // producing a fail verdict rather than the batched "unverified".
      for (const r of legacy.results) {
        expect(r.verdict).not.toBe("unverified");
        expect(r.ok).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("e2e — one instrumented Vitest run attributes two files", () => {
  test(
    "two real test files in one segment produce per-file verdicts (AC-1/AC-2)",
    async () => {
      const segment: ProbeSegment = { start: 0, members: [0, 1], boundMs: 120_000 };
      const probes = [
        testProbe("packages/forge/os/rfc/verification-normalize.test.ts"),
        testProbe("packages/forge/os/rfc/frontmatter-io.test.ts"),
      ];
      const results = await runBatchedTestSegment(probes, segment, WORKSPACE_ROOT);
      expect(results.size).toBe(2);
      const a = results.get(0)!;
      const b = results.get(1)!;
      expect(a.verdict, `probe 0 must attribute its own file — ${a.detail}`).toBe("pass");
      expect(b.verdict, `probe 1 must attribute its own file — ${b.detail}`).toBe("pass");
      expect(a.detail).toContain("batched:");
    },
    180_000,
  );
});
