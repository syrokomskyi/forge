/*
<MODULE_CONTRACT>
<purpose>RFC-1474 checks.counters.validate tests — journal integrity gates:
COUNT-01 blocks when a record's ruleId resolves to no inventory rule (or a
malformed middle line exists), COUNT-02 blocks on non-monotonic `at` append
order; clean journal exits 0.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCountersValidate } from "./counters-validate.ts";
import { COUNTERS_JOURNAL_PATH, type CheckCounterRecord } from "./counters-journal.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

const rec = (over: Partial<CheckCounterRecord> = {}): CheckCounterRecord => ({
  runId: "run-a",
  ruleId: "gate/GATE-CMP-01",
  contract: "gate",
  outcome: "pass",
  at: "2026-10-31T20:00:00.000Z",
  ...over,
});

async function seedInventory() {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:
  - contract: gate
    validators:
      - rules:
          - id: GATE-CMP-01
            severity: error
          - id: GATE-CMP-02
            severity: warning
`,
  );
}

async function seedJournal(lines: string[]) {
  await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
  await writeFile(join(root, COUNTERS_JOURNAL_PATH), lines.join("\n") + "\n");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "counters-validate-"));
  await seedInventory();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checks.counters.validate", () => {
  test("clean journal exits 0", async () => {
    await seedJournal([
      JSON.stringify(rec({ at: "2026-10-31T20:00:00.000Z" })),
      JSON.stringify(rec({ ruleId: "gate/GATE-CMP-02", outcome: "diagnostic", at: "2026-10-31T21:00:00.000Z" })),
    ]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(0);
    expect(result.data!.diagnostics ?? []).toHaveLength(0);
  });

  test("absent journal exits 0 (nothing evaluated yet)", async () => {
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(0);
  });

  test("AC-3: COUNT-01 blocks on a ruleId absent from the inventory", async () => {
    await seedJournal([
      JSON.stringify(rec()),
      JSON.stringify(rec({ ruleId: "gate/UNKNOWN-99", contract: "gate" })),
    ]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    const diag = result.data!.diagnostics!.find((d) => d.ruleId === "COUNT-01");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("gate/UNKNOWN-99");
  });

  test("AC-3: COUNT-01 blocks on a ruleId under an unknown contract", async () => {
    await seedJournal([JSON.stringify(rec({ ruleId: "bogus/GATE-CMP-01", contract: "bogus" }))]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-01")).toBe(true);
  });

  test("COUNT-01 surfaces malformed non-tail lines", async () => {
    await seedJournal([
      JSON.stringify(rec()),
      `{"runId":"x","ruleId":`, // malformed middle line
      JSON.stringify(rec({ ruleId: "gate/GATE-CMP-02" })),
    ]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-01" && d.message.includes("malformed"))).toBe(true);
  });

  test("AC-4: COUNT-02 blocks on non-monotonic at append order", async () => {
    await seedJournal([
      JSON.stringify(rec({ at: "2026-10-31T22:00:00.000Z" })),
      JSON.stringify(rec({ ruleId: "gate/GATE-CMP-02", at: "2026-10-31T20:00:00.000Z" })),
    ]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    const diag = result.data!.diagnostics!.find((d) => d.ruleId === "COUNT-02");
    expect(diag).toBeDefined();
  });

  test("COUNT-02 compares numerically — second-precision ISO does not false-flag against millisecond stamps", async () => {
    // Lexically "...:00Z" > "...:00.500Z" ('Z' > '.'), but numerically
    // 23:00:00.000 < 23:00:00.500 — a lexical compare would flag a clean tail.
    await seedJournal([
      JSON.stringify(rec({ at: "2026-10-31T23:00:00Z" })),
      JSON.stringify(rec({ ruleId: "gate/GATE-CMP-02", at: "2026-10-31T23:00:00.500Z" })),
    ]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-02")).toBe(false);
  });

  test("crash-truncated tail is tolerated (no diagnostic, records still gated)", async () => {
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(rec({ ruleId: "gate/UNKNOWN-99", contract: "gate" })) + "\n" + `{"runId":"x`,
    );
    const result = await runCountersValidate(flags(), ctx());
    // The surviving record still violates COUNT-01; the truncated tail adds
    // no diagnostic of its own.
    const diags = result.data!.diagnostics!;
    expect(diags.every((d) => d.ruleId === "COUNT-01")).toBe(true);
    expect(result.data!.truncatedTail).toBe(true);
  });

  test("missing inventory blocks resolution with COUNT-01", async () => {
    await rm(join(root, "docs", "validator-inventory.generated.yaml"));
    await seedJournal([JSON.stringify(rec())]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-01")).toBe(true);
  });

  test("malformed inventory surfaces COUNT-01, not a thrown crash", async () => {
    await writeFile(join(root, "docs", "validator-inventory.generated.yaml"), "contracts: [unclosed");
    await seedJournal([JSON.stringify(rec())]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-01" && d.message.includes("malformed"))).toBe(true);
  });

  test("empty-document inventory surfaces COUNT-01 — null doc is an unavailable universe", async () => {
    await writeFile(join(root, "docs", "validator-inventory.generated.yaml"), "");
    await seedJournal([JSON.stringify(rec())]);
    const result = await runCountersValidate(flags(), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-01" && d.message.includes("empty"))).toBe(true);
  });
});
