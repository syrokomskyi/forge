/*
<MODULE_CONTRACT>
<purpose>
RFC-1455: V-50/V-51 tests — `## Fixed inputs` rows must bind exactly one
existing AC-N whose outcome probe (page or file-contains) contains the
declared value (V-50 error); verbatim prose without the section earns a
V-51 warning. Covers fence-stripped parsing, escaped pipes, header-row
location, marked-literal extraction, and the createdAt cutoff.
</purpose>
<non-goals>
  <item>Do not exercise probe execution — outcome sessions are covered by acceptance.test.ts (RFC-1453).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1455: V-50/V-51 fixed-inputs binding validation tests.</item>
  <item>RFC-1455: fixed inputs bound to outcome probes — V-50/V-51 + skills</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

interface Seen {
  rule: string;
  severity?: string;
  message?: string;
}

const CUTOFF_DAY = "2026-10-30";

const BODY = (sections: string) => `# RFC-9999: Test RFC

${sections}
`;

const CRITERIA = (ids: string[]) =>
  `## Acceptance criteria\n\n${ids.map((id) => `- [ ] ${id}: something observable (evidence: probe:${id})`).join("\n")}\n`;

const FIXED = (rows: string) =>
  `## Fixed inputs\n\n| ID | Value | Source | Checked by |\n| --- | --- | --- | --- |\n${rows}\n`;

const makeParsed = (fm: Record<string, unknown>, body: string): ParsedRfc => ({
  frontmatter: {
    id: "RFC-9999",
    title: "Test RFC",
    status: "draft",
    kind: "policy",
    scope: "workspace",
    owners: ["architecture"],
    createdAt: CUTOFF_DAY,
    updatedAt: CUTOFF_DAY,
    ...fm,
  },
  body,
});

const runValidate = async (
  fileName: string,
  parsed: ParsedRfc,
  workspaceRoot: string,
): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const add: AddViolationFn = (_id, _file, rule, msg, severity) =>
    void seen.push({ rule, severity, message: msg });
  await validateSingleRfc(
    fileName,
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    workspaceRoot,
    add,
  );
  return seen;
};

const WS = join(tmpdir(), "rfc1455-ws");
const fileContains = (pattern: string, criterion = "AC-1") => ({
  probe: "file-contains",
  path: "x.ts",
  pattern,
  criterion,
});
const pageProbe = (fields: Record<string, unknown>, criterion = "AC-1") => ({
  probe: "page",
  target: "site-a",
  path: "/",
  ...fields,
  criterion,
});

describe("V-50 — fixed inputs bind outcome probes (AC-1..AC-3)", () => {
  test("AC-1: errors when the row names a criterion that does not exist", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("RU · DE")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-9 |")),
      ),
      WS,
    );
    const v50 = violations.filter((v) => v.rule === "V-50");
    expect(v50.length).toBeGreaterThan(0);
    expect(v50.every((v) => v.severity === "error")).toBe(true);
  });

  test("AC-1: errors on a malformed or empty Checked by cell", async () => {
    for (const cell of ["", "AC-1, AC-2", "criterion-1"]) {
      const violations = await runValidate(
        "rfc-9999-test.md",
        makeParsed(
          { acceptance: [fileContains("RU · DE")] },
          BODY(CRITERIA(["AC-1"]) + FIXED(`| FI-1 | \`RU · DE\` | grilling | ${cell} |`)),
        ),
        WS,
      );
      expect(violations.some((v) => v.rule === "V-50")).toBe(true);
    }
  });

  test("AC-2: errors when the criterion has only non-outcome probes", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        {
          acceptance: [
            { probe: "test", file: "x.test.ts", expect: { exitCode: 0 }, criterion: "AC-1" },
            { probe: "run", command: "true", expect: { exitCode: 0 }, criterion: "AC-1" },
          ],
        },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-1 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(true);
  });

  test("AC-3: errors when the bound probe pattern lacks the value", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("something else entirely")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-1 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(true);
  });

  test("passes when the bound file-contains pattern carries the value", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("RU · DE")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-1 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(false);
  });

  test("passes via page textPattern or selector containing the value", async () => {
    for (const probe of [
      pageProbe({ textPattern: "^RU · DE$" }),
      pageProbe({ selector: "header .lang-switcher__link[aria-label*=Deutsch]" }),
    ]) {
      const value = "textPattern" in probe ? "RU · DE" : "aria-label*=Deutsch";
      const violations = await runValidate(
        "rfc-9999-test.md",
        makeParsed(
          { acceptance: [probe] },
          BODY(CRITERIA(["AC-1"]) + FIXED(`| FI-1 | \`${value}\` | grilling | AC-1 |`)),
        ),
        WS,
      );
      expect(violations.some((v) => v.rule === "V-50")).toBe(false);
    }
  });

  test("unescapes \\| inside values before containment", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("ru | Deutsch")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `ru \\| Deutsch` | grilling | AC-1 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(false);
  });

  test("ignores the grammar example inside a fenced code block", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("RU · DE")] },
        BODY(
          CRITERIA(["AC-1"]) +
            FIXED("| FI-1 | `RU · DE` | grilling | AC-1 |") +
            "\n```md\n## Fixed inputs\n\n| ID | Value | Source | Checked by |\n| --- | --- | --- | --- |\n| FI-9 | `never checked` | docs | AC-9 |\n```\n",
        ),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(false);
  });

  test("pre-cutoff RFCs are exempt from V-50", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { createdAt: "2026-10-29", acceptance: [fileContains("x")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-9 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(false);
  });

  test("archived RFCs are exempt from V-50", async () => {
    const violations = await runValidate(
      "archive/rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("x")] },
        BODY(CRITERIA(["AC-1"]) + FIXED("| FI-1 | `RU · DE` | grilling | AC-9 |")),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-50")).toBe(false);
  });
});

describe("V-51 — verbatim markers without a Fixed inputs section (warning)", () => {
  test("warns on verbatim markers in Design with no section", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        {},
        BODY(CRITERIA(["AC-1"]) + "## Design\n\nThe label is verbatim from the client.\n"),
      ),
      WS,
    );
    const v51 = violations.filter((v) => v.rule === "V-51");
    expect(v51).toHaveLength(1);
    expect(v51[0]!.severity).toBe("warning");
  });

  test("markers inside fenced blocks do not fire V-51", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        {},
        BODY(
          CRITERIA(["AC-1"]) + "## Design\n\n```\nverbatim marker in a fence\n```\n",
        ),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-51")).toBe(false);
  });

  test("silent when the section exists", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed(
        { acceptance: [fileContains("RU · DE")] },
        BODY(
          CRITERIA(["AC-1"]) +
            FIXED("| FI-1 | `RU · DE` | grilling | AC-1 |") +
            "## Design\n\nThe label is verbatim from the client.\n",
        ),
      ),
      WS,
    );
    expect(violations.some((v) => v.rule === "V-51")).toBe(false);
  });
});
