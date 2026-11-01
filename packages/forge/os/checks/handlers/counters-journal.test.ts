/*
<MODULE_CONTRACT>
<purpose>RFC-1474 counters journal tests — append-only JSONL writer/reader for
docs/.index/checks/counters.jsonl, outcome computation per declared rule, and
executor-hook semantics (dryRun suppression, non-fatal append failure,
truncated-tail tolerance).</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-checks</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COUNTERS_JOURNAL_PATH,
  computeRunOutcomes,
  readCountersJournal,
  recordRuleEvaluations,
  type CheckCounterRecord,
} from "./counters-journal.ts";

let root: string;

const rec = (over: Partial<CheckCounterRecord> = {}): CheckCounterRecord => ({
  runId: "checks.validate-1-abc",
  ruleId: "gate/GATE-CMP-01",
  contract: "gate",
  outcome: "pass",
  at: "2026-10-31T23:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "counters-journal-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("recordRuleEvaluations", () => {
  test("AC-1: appends one JSONL line per record", async () => {
    await recordRuleEvaluations(root, [rec(), rec({ ruleId: "gate/GATE-CMP-02", outcome: "diagnostic" })]);
    const src = await readFile(join(root, COUNTERS_JOURNAL_PATH), "utf8");
    const lines = src.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toEqual(rec());
    const second = JSON.parse(lines[1]!);
    expect(second.outcome).toBe("diagnostic");
  });

  test("AC-9: append-only — second append preserves earlier bytes", async () => {
    await recordRuleEvaluations(root, [rec({ ruleId: "a/A-1" })]);
    const firstBytes = await readFile(join(root, COUNTERS_JOURNAL_PATH), "utf8");
    await recordRuleEvaluations(root, [rec({ ruleId: "b/B-2" })]);
    const secondBytes = await readFile(join(root, COUNTERS_JOURNAL_PATH), "utf8");
    expect(secondBytes.startsWith(firstBytes)).toBe(true);
    expect(secondBytes.trim().split("\n")).toHaveLength(2);
  });

  test("empty record set is a no-op (no file created)", async () => {
    await recordRuleEvaluations(root, []);
    const { records } = await readCountersJournal(root);
    expect(records).toHaveLength(0);
  });

  test("AC-11: append failure returns a warning, never throws", async () => {
    // Make the journal's parent path a regular file — mkdir/append must fail.
    await mkdir(join(root, "docs", ".index"), { recursive: true });
    await writeFile(join(root, "docs", ".index", "checks"), "not-a-dir");
    const warning = await recordRuleEvaluations(root, [rec()]);
    expect(typeof warning).toBe("string");
    expect(warning).toContain("counters");
  });
});

describe("readCountersJournal", () => {
  test("absent journal yields empty records, not an error", async () => {
    const { records, truncatedTail } = await readCountersJournal(root);
    expect(records).toEqual([]);
    expect(truncatedTail).toBe(false);
  });

  test("AC-9: truncated last line drops only the partial record", async () => {
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    const file = join(root, COUNTERS_JOURNAL_PATH);
    await appendFile(file, JSON.stringify(rec({ ruleId: "a/A-1" })) + "\n");
    await appendFile(file, JSON.stringify(rec({ ruleId: "a/A-2" })) + "\n");
    await appendFile(file, `{"runId":"x","ruleId":"a/A-3","con`); // crash-truncated tail
    const { records, truncatedTail } = await readCountersJournal(root);
    expect(records.map((r) => r.ruleId)).toEqual(["a/A-1", "a/A-2"]);
    expect(truncatedTail).toBe(true);
  });

  test("malformed non-tail lines surface in malformedLines, parsed records preserved", async () => {
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    const file = join(root, COUNTERS_JOURNAL_PATH);
    await writeFile(
      file,
      [
        JSON.stringify(rec({ ruleId: "a/A-1" })),
        `{"runId":"x"`, // malformed middle line
        JSON.stringify({ runId: "x", ruleId: "a/A-9", contract: "a", outcome: "bogus", at: "t" }), // schema-invalid
        JSON.stringify(rec({ ruleId: "a/A-2" })),
        "",
      ].join("\n"),
    );
    const { records, malformedLines, truncatedTail } = await readCountersJournal(root);
    expect(records.map((r) => r.ruleId)).toEqual(["a/A-1", "a/A-2"]);
    expect(malformedLines).toBe(2);
    expect(truncatedTail).toBe(false);
  });

  test("a parseable-but-schema-invalid tail counts as malformed, not truncated", async () => {
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    const file = join(root, COUNTERS_JOURNAL_PATH);
    await writeFile(
      file,
      [
        JSON.stringify(rec({ ruleId: "a/A-1" })),
        JSON.stringify({ runId: "x", ruleId: "undefined/X-1", contract: "undefined", outcome: "bogus", at: "not-a-date" }),
        "",
      ].join("\n"),
    );
    const { records, malformedLines, truncatedTail } = await readCountersJournal(root);
    expect(records.map((r) => r.ruleId)).toEqual(["a/A-1"]);
    expect(malformedLines).toBe(1);
    expect(truncatedTail).toBe(false);
  });

  test("non-ENOENT read errors propagate — an unreadable journal must not green", async () => {
    await mkdir(join(root, COUNTERS_JOURNAL_PATH), { recursive: true }); // journal path is a directory → EISDIR
    await expect(readCountersJournal(root)).rejects.toThrow();
  });
});

describe("computeRunOutcomes", () => {
  const rules = [
    { id: "GATE-CMP-01", severity: "error" as const },
    { id: "GATE-CMP-02", severity: "warning" as const },
  ];

  test("maps declared rules to pass/diagnostic from result diagnostic ruleIds", () => {
    const records = computeRunOutcomes({
      runId: "run-1",
      contract: "gate",
      rules,
      diagnosticRuleIds: new Set(["GATE-CMP-02"]),
      at: "2026-10-31T23:00:00.000Z",
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ ruleId: "gate/GATE-CMP-01", contract: "gate", outcome: "pass", runId: "run-1" });
    expect(records[1]).toMatchObject({ ruleId: "gate/GATE-CMP-02", outcome: "diagnostic" });
  });

  test("matches namespaced diagnostic ruleIds too", () => {
    const records = computeRunOutcomes({
      runId: "run-1",
      contract: "gate",
      rules,
      diagnosticRuleIds: new Set(["gate/GATE-CMP-01"]),
      at: "2026-11-01T00:00:00.000Z",
    });
    expect(records[0]!.outcome).toBe("diagnostic");
    expect(records[1]!.outcome).toBe("pass");
  });

  test("forced outcome (ensured/skipped) applies to every declared rule", () => {
    const records = computeRunOutcomes({
      runId: "run-2",
      contract: "checks",
      rules: ["COUNT-01", "COUNT-02"],
      diagnosticRuleIds: new Set(["COUNT-01"]),
      outcome: "ensured",
      at: "2026-11-01T00:00:00.000Z",
    });
    expect(records.every((r) => r.outcome === "ensured")).toBe(true);
    expect(records.map((r) => r.ruleId)).toEqual(["checks/COUNT-01", "checks/COUNT-02"]);
  });

  test("undefined/empty rules yield no records", () => {
    expect(
      computeRunOutcomes({ runId: "r", contract: "c", rules: undefined, diagnosticRuleIds: new Set(), at: "2026-11-01T00:00:00.000Z" }),
    ).toEqual([]);
  });
});
