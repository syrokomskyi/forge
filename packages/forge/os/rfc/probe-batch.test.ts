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
import { readRfcFrontmatter, readAndParseRfc, listRfcFiles } from "./frontmatter-io.ts";
import { RFC_DIR, type AcceptanceProbe } from "./types.ts";

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
      { start: 0, end: 3, boundMs: 120_000 },
    ]);
  });

  test("a timeoutMs change closes the segment", () => {
    const probes = [
      testProbe("a.test.ts"),
      testProbe("b.test.ts", { timeoutMs: 5_000 }),
      testProbe("c.test.ts"),
    ];
    expect(planProbeSegments(probes, 120_000)).toEqual([
      { start: 0, end: 1, boundMs: 120_000 },
      { start: 1, end: 2, boundMs: 5_000 },
      { start: 2, end: 3, boundMs: 120_000 },
    ]);
  });

  test("run/page/proof and every non-test kind are barriers", () => {
    const probes: AcceptanceProbe[] = [
      testProbe("a.test.ts"),
      runProbe("site-kernel run x"),
      testProbe("b.test.ts"),
      { probe: "page", target: "site", path: "/", expect: { status: 200 } } as AcceptanceProbe,
      testProbe("c.test.ts"),
      { probe: "proof", spec: "s.yaml" },
      testProbe("d.test.ts"),
    ];
    expect(planProbeSegments(probes, 120_000)).toEqual([
      { start: 0, end: 1, boundMs: 120_000 },
      { start: 2, end: 3, boundMs: 120_000 },
      { start: 4, end: 5, boundMs: 120_000 },
      { start: 6, end: 7, boundMs: 120_000 },
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

  test("testName matching no assertion is unverified", () => {
    const p = attributeProbeResult(
      testProbe("os/rfc/a.test.ts", { testName: "no such test" }),
      WORKSPACE_ROOT,
      report,
    );
    expect(p.verdict).toBe("unverified");
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
      // Singleton test segment → legacy runProbe path — a spawn failure is a
      // plain fail (legacy results carry no `verdict` field), not unverified.
      expect(results[4]!.ok).toBe(false);
      expect(results[4]!.verdict ?? "fail").toBe("fail");
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

describe("readRfcFrontmatter — AC-5/AC-6 corpus reads", () => {
  const fmDoc = (id: string, extra = ""): string =>
    `---\nid: ${id}\nstatus: draft\n${extra}---\n\n# Body ${id}\n\nSome body text.\n`;

  test("returns frontmatter with an empty body (AC-5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-"));
    try {
      writeFileSync(join(dir, "rfc-0001-a.md"), fmDoc("RFC-0001"));
      const res = await readRfcFrontmatter(dir, "rfc-0001-a.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter["id"] : undefined).toBe("RFC-0001");
      expect(res && "parsed" in res ? res.parsed.body : "x").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to full parse when the closing fence exceeds the bound (AC-6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-big-"));
    try {
      // A >64 KiB frontmatter block: the bounded head cannot see the fence.
      const big = `note: "${"y".repeat(70 * 1024)}"\n`;
      writeFileSync(join(dir, "rfc-0002-big.md"), fmDoc("RFC-0002", big));
      const res = await readRfcFrontmatter(dir, "rfc-0002-big.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter["id"] : undefined).toBe("RFC-0002");
      // Full-parse fallback populates the body.
      expect(res && "parsed" in res ? res.parsed.body : "").toContain("# Body RFC-0002");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("small file without a closing fence yields empty frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-nofm-"));
    try {
      writeFileSync(join(dir, "rfc-0003-bare.md"), "# No frontmatter\n\nbody\n");
      const res = await readRfcFrontmatter(dir, "rfc-0003-bare.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter : { x: 1 }).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed YAML produces the same error variant as full parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-bad-"));
    try {
      writeFileSync(join(dir, "rfc-0004-bad.md"), "---\nid: [unclosed\n---\nbody\n");
      const slim = await readRfcFrontmatter(dir, "rfc-0004-bad.md");
      const full = await readAndParseRfc(dir, "rfc-0004-bad.md");
      expect(slim && "error" in slim).toBe(true);
      expect(full && "error" in full).toBe(true);
      expect(slim && "error" in slim ? slim.error : "").toBe(
        full && "error" in full ? full.error : "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AC-9 — frontmatter-only corpus produces the same rule input as full parse", () => {
  test(
    "every real corpus file: frontmatter identical between the two paths",
    async () => {
      const rfcDir = join(WORKSPACE_ROOT, RFC_DIR);
      const files = await listRfcFiles(rfcDir);
      expect(files.length).toBeGreaterThan(100);
      let fallbackSeen = 0;
      for (const f of files) {
        const slim = await readRfcFrontmatter(rfcDir, f);
        const full = await readAndParseRfc(rfcDir, f);
        if (!slim || !full) continue;
        if ("error" in slim || "error" in full) {
          expect("error" in slim, `error parity for ${f}`).toBe("error" in full);
          continue;
        }
        // Referential rules consume only this map — identical input means an
        // identical violation set.
        expect(slim.parsed.frontmatter, `frontmatter parity for ${f}`).toEqual(
          full.parsed.frontmatter,
        );
        if (slim.parsed.body !== "") fallbackSeen++;
      }
      // Sanity: the corpus is large enough that the slim path actually ran.
      expect(files.length).toBeGreaterThan(1000);
      void fallbackSeen;
    },
    120_000,
  );
});

describe("e2e — one instrumented Vitest run attributes two files", () => {
  test(
    "two real test files in one segment produce per-file verdicts (AC-1/AC-2)",
    async () => {
      const segment: ProbeSegment = { start: 0, end: 2, boundMs: 120_000 };
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
