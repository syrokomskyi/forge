/*
<MODULE_CONTRACT>
<purpose>Unit tests for alignMarkdownTable + parseMarkdownTable (RFC-1154):
prettier-normal emission, separator dash-padding, escaped-pipe literals,
idempotency, and a regression guard over forge emission surfaces.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial table-emitter tests + compact-separator regression guard.</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { alignMarkdownTable, parseMarkdownTable } from "../utils/markdown-table.ts";

test("aligns cells and pads separator with dashes to column width", () => {
  const out = alignMarkdownTable(
    ["Name", "Value"],
    [
      ["long-name-here", "x"],
      ["a", "b"],
    ],
  );
  expect(out).toBe(
    [
      "| Name           | Value |",
      "| -------------- | ----- |",
      "| long-name-here | x     |",
      "| a              | b     |",
    ].join("\n"),
  );
});

test("minimum column width is 3 even for short cells", () => {
  const out = alignMarkdownTable(["a", "b"], [["1", "2"]]);
  expect(out).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |");
});

test("escaped pipe inside a cell is a literal, not a delimiter", () => {
  const out = alignMarkdownTable(["Pattern", "Meaning"], [["a \\| b", "or"]]);
  const lines = out.split("\n");
  expect(lines[0]).toBe("| Pattern | Meaning |");
  expect(lines[1]).toBe("| ------- | ------- |");
  expect(lines[2]).toBe("| a \\| b  | or      |");
});

test("rows shorter or longer than headers extend the column set", () => {
  const out = alignMarkdownTable(["A"], [["x", "extra"]]);
  expect(out.split("\n")[0]).toBe("| A   |       |");
  expect(out.split("\n")[2]).toBe("| x   | extra |");
});

test("empty input emits empty string", () => {
  expect(alignMarkdownTable([], [])).toBe("");
});

test("AC-5: re-aligning emitted output is byte-identical", () => {
  const once = alignMarkdownTable(
    ["Name", "Category", "Concerns"],
    [
      ["fo-idea", "fo", "classification"],
      ["wg-mission", "wg", "lifecycle"],
    ],
  );
  const parsed = parseMarkdownTable(once);
  expect(parsed).not.toBeNull();
  const twice = alignMarkdownTable(parsed!.headers, parsed!.rows);
  expect(twice, "align(parse(emit)) must be byte-stable — check separator width math").toBe(once);
});

test("parseMarkdownTable returns null for non-table input", () => {
  expect(parseMarkdownTable("just prose\nno table here")).toBeNull();
  expect(parseMarkdownTable("| a |\nno separator")).toBeNull();
});

test("parseMarkdownTable splits on unescaped pipes only", () => {
  const parsed = parseMarkdownTable("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |");
  expect(parsed).not.toBeNull();
  expect(parsed!.headers).toEqual(["a \\| b", "c"]);
});

test("regression guard: no forge emitter emits a compact '| --- |' separator", () => {
  const srcDir = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "tests" || entry === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const content = readFileSync(full, "utf8");
      // Flag compact separator literals — all tables must route through
      // alignMarkdownTable. The aligner itself lives in utils/markdown-table.ts.
      if (full.endsWith("markdown-table.ts")) continue;
      if (/\| -{2,} \|/.test(content)) offenders.push(full);
    }
  };
  walk(srcDir);
  expect(
    offenders,
    "compact '| --- |' table literals found — route through alignMarkdownTable",
  ).toEqual([]);
});
