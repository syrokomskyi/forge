/*
<MODULE_CONTRACT>
<purpose>AC-1: parseFlowBranch accepts exactly the FI-1 grammar rows and
returns null for every invalid row of the shared name table
(tests/fixtures/branch-names.yaml); formatFlowBranch round-trips valid names
and renders the date in UTC.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 1 — fixed branch-model grammar, marker detection contracts, git helpers</item>
  <item>RFC-1486: step 1 — branch grammar, marker detection, git helpers</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  classifyBranch,
  formatFlowBranch,
  isValidFlowDate,
  parseFlowBranch,
} from "../branch-name.ts";

interface NameRow {
  name: string;
  verdict: "allow" | "refuse";
  rule: "FLOW-GUARD-01" | "FLOW-GUARD-02" | null;
  ref_ok: boolean;
}

const table = yamlParse(
  readFileSync(fileURLToPath(new URL("./fixtures/branch-names.yaml", import.meta.url)), "utf8"),
) as { rows: NameRow[] };

describe("shared name table", () => {
  it("carries at least 30 rows and marks uncreatable refs as refuse", () => {
    expect(table.rows.length).toBeGreaterThanOrEqual(30);
    const uncreatable = table.rows.filter((row) => !row.ref_ok);
    expect(uncreatable.length).toBeGreaterThan(0);
    for (const row of uncreatable) {
      expect(row.verdict, `uncreatable ref must be a refuse row: ${row.name}`).toBe("refuse");
    }
  });
});

describe("parseFlowBranch", () => {
  for (const row of table.rows) {
    it(`${row.verdict === "allow" ? "accepts" : "rejects"} "${row.name}"`, () => {
      const parsed = parseFlowBranch(row.name);
      if (row.verdict === "allow") {
        expect(parsed, `expected "${row.name}" to parse`).not.toBeNull();
        expect(parsed!.name).toBe(row.name);
        expect(["task", "session", "fix"]).toContain(parsed!.kind);
        expect(isValidFlowDate(parsed!.date)).toBe(true);
        expect(parsed!.seq).toBeGreaterThanOrEqual(1);
        expect(parsed!.seq).toBeLessThanOrEqual(99);
        expect(parsed!.slug.length).toBeGreaterThanOrEqual(3);
        expect(parsed!.slug.length).toBeLessThanOrEqual(48);
      } else {
        expect(parsed, `expected "${row.name}" to return null`).toBeNull();
      }
    });
  }
});

describe("classifyBranch", () => {
  it("maps every table row to the verdict the shell guard must produce", () => {
    for (const row of table.rows) {
      const cls = classifyBranch(row.name);
      const expectedRule =
        cls.kind === "protected"
          ? "FLOW-GUARD-01"
          : cls.kind === "nonconforming"
            ? "FLOW-GUARD-02"
            : null;
      expect(expectedRule, `classifyBranch("${row.name}")`).toBe(row.rule);
      expect(cls.kind !== "flow", `verdict of "${row.name}"`).toBe(row.verdict === "refuse");
    }
  });
});

describe("formatFlowBranch", () => {
  it("round-trips every valid table row", () => {
    for (const row of table.rows.filter((r) => r.verdict === "allow")) {
      const parsed = parseFlowBranch(row.name)!;
      const date = new Date(
        Date.UTC(
          2000 + Number(parsed.date.slice(0, 2)),
          Number(parsed.date.slice(2, 4)) - 1,
          Number(parsed.date.slice(4, 6)),
        ),
      );
      expect(
        formatFlowBranch({ kind: parsed.kind, date, seq: parsed.seq, slug: parsed.slug }),
      ).toBe(row.name);
    }
  });

  it("renders the date in UTC regardless of the Date's wall-clock edge", () => {
    // 2026-11-01 23:30 UTC is still 2026-11-01 in UTC — and 2026-11-02 in
    // UTC+2. The name must follow UTC, not the local zone.
    const edge = new Date(Date.UTC(2026, 10, 1, 23, 30));
    expect(formatFlowBranch({ kind: "session", date: edge, seq: 1, slug: "forge-flow" })).toBe(
      "auto/session-261101-01-forge-flow",
    );
  });

  it("throws on out-of-range seq and malformed slug", () => {
    const date = new Date(Date.UTC(2026, 10, 1));
    for (const seq of [0, 100, -1, 1.5]) {
      expect(() =>
        formatFlowBranch({ kind: "task", date, seq, slug: "abc" }),
      ).toThrow(/seq/);
    }
    for (const slug of ["ab", "a_b", "ABC", "a".repeat(49), "a-"]) {
      expect(() =>
        formatFlowBranch({ kind: "task", date, seq: 1, slug }),
      ).toThrow(/slug/);
    }
  });
});

describe("isValidFlowDate", () => {
  it("accepts real calendar dates and rejects impossible ones", () => {
    for (const ok of ["261101", "240229", "241231", "991231"]) {
      expect(isValidFlowDate(ok), ok).toBe(true);
    }
    // 99 is a valid 2-digit year (2099-12-31): YYMMDD has no century pivot.
    for (const bad of ["261332", "260230", "260229", "230229", "261100", "261131", "abcdef", "26110"]) {
      expect(isValidFlowDate(bad), bad).toBe(false);
    }
  });
});
