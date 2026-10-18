/*
<MODULE_CONTRACT>
<purpose>RFC-1334: V-45 tests — post-cutoff proposed/added commands without a command-mode reachable probe warn.</purpose>
<non-goals>
  <item>Not a probe-execution suite.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1334: tests for AC-8.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type AddViolationFn, validateSingleRfc } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

async function v45(acceptance: unknown[]): Promise<Array<{ message: string; severity: string }>> {
  const parsed: ParsedRfc = {
    frontmatter: {
      id: "RFC-9997",
      title: "T",
      status: "draft",
      kind: "command",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-10-18",
      updatedAt: "2026-10-18",
      commands: { proposed: ["demo.run"], added: [], changed: [], removed: [] },
      acceptance,
    },
    body: "\n# RFC-9997: T\n\n## Acceptance criteria\n\n- [ ] AC-1: THE x SHALL y.\n",
  };
  const out: Array<{ message: string; severity: string }> = [];
  const add: AddViolationFn = (_id, _f, rule, message, severity = "error") => {
    if (rule === "V-45") out.push({ message, severity });
  };
  await validateSingleRfc(
    "rfc-9997-t.md",
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    join(tmpdir(), "ws-1334"),
    add,
  );
  return out;
}

describe("V-45 (RFC-1334)", () => {
  test("V-45 warns when a proposed command has no reachable probe", async () => {
    const found = await v45([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.message).toContain("demo.run");
  });

  test("stays quiet when a command-mode reachable probe covers the command", async () => {
    expect(await v45([{ probe: "reachable", command: "demo.run", criterion: "AC-1" }])).toEqual([]);
  });
});
