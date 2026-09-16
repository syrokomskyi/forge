import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCompassValidation, runCompassInventory } from "../compass-inventory-handler.ts";
import { runCompassChangeSummaryValidate } from "../compass-change-summary-handler.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../../src/types.ts";

function dataOf<T>(result: ForgeCommandResult<T>): T {
  if (!result.data) throw new Error("command returned no data payload");
  return result.data;
}

function makeContext(workspaceRoot: string, dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    dryRun,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { flags } as ForgeCommandInput;
}

const MC = (purpose: string) =>
  `<MODULE_CONTRACT>\n<purpose>${purpose}</purpose>\n<non-goals>\n  <item>Do not perform real validation — fixtures only.</item>\n</non-goals>\n</MODULE_CONTRACT>`;
const KD = (items: string[]) =>
  `<KEY_DECISIONS>\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n</KEY_DECISIONS>`;
const KD_EMPTY = `<KEY_DECISIONS>\n</KEY_DECISIONS>`;
const CS = (items: string[], history?: string) =>
  `<CHANGE_SUMMARY>\n${items.map((i) => `  <item>${i}</item>`).join("\n")}${history ? `\n  <history>${history}</history>` : ""}\n</CHANGE_SUMMARY>`;
const wrap = (...blocks: string[]) => `/*\n${blocks.join("\n")}\n*/`;

const PURPOSE_WITH_TOKEN =
  "Validates mission widget fixtures for the compass v2 contract test suite.";
const KD_ITEM = "Fixtures live in a temp workspace so tests never touch the real repository.";
const CS_ITEM = "RFC-1094: initial v2 fixture.";

// Medium-risk path: src/components/** maps to layer "component" → riskClass medium.
const MEDIUM_FILE = "packages/fixture-pkg/src/components/mission-widget.ts";
// Low-risk path: bare src/** maps to layer "source" → riskClass low.
const LOW_FILE = "packages/fixture-pkg/src/mission-notes.ts";

describe("compass v2 contract (RFC-1094)", () => {
  let tempDir: string;

  function writeFixture(relPath: string, header: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    const body = Array.from({ length: 25 }, (_, i) => `export const fixtureLine${i} = ${i};`).join(
      "\n",
    );
    writeFileSync(abs, `${header}\n\n${body}\n`);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-v2-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("AC-1/AC-9: missing KEY_DECISIONS on medium-risk file — warning in default mode, error in --mode error", async () => {
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), CS([CS_ITEM])));

    const warnResult = await runCompassValidation(makeInput(), makeContext(tempDir));
    const warnDiag = dataOf(warnResult).diagnostics.find((d) => d.ruleId === "COMPASS-KD-01");
    expect(warnDiag, "KD-01 must fire for medium-risk file without KEY_DECISIONS").toBeDefined();
    expect(warnDiag!.severity).toBe("warning");
    expect(warnResult.exitCode).toBe(0);

    const errorResult = await runCompassValidation(
      makeInput({ mode: "error" }),
      makeContext(tempDir),
    );
    const errorDiag = dataOf(errorResult).diagnostics.find((d) => d.ruleId === "COMPASS-KD-01");
    expect(errorDiag!.severity).toBe("error");
    expect(errorResult.exitCode).toBe(1);
  });

  it("low-risk file without KEY_DECISIONS produces no KD-01", async () => {
    writeFixture(
      LOW_FILE,
      wrap(MC("Tracks mission notes for the compass v2 contract test suite."), CS([CS_ITEM])),
    );

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    expect(dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-KD-01")).toBeUndefined();
  });

  it("AC-2: CHANGE_SUMMARY with more than 5 items reports COMPASS-CS-05", async () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => `RFC-10${n}0: change number ${n}.`);
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS(items)));

    const result = await runCompassChangeSummaryValidate(makeInput(), makeContext(tempDir));
    const diag = dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-CS-05");
    expect(diag, "CS-05 must fire when CHANGE_SUMMARY exceeds 5 items").toBeDefined();
    expect(diag!.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("AC-3: CHANGE_SUMMARY item without governance ID reports COMPASS-CS-06", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS(["fixed a bug in the widget"])),
    );

    const result = await runCompassChangeSummaryValidate(makeInput(), makeContext(tempDir));
    const diag = dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-CS-06");
    expect(diag, "CS-06 must fire for items lacking a governance ID").toBeDefined();
  });

  it("AC-4: KEY_DECISIONS item with governance-ID prefix reports COMPASS-KD-05", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(MC(PURPOSE_WITH_TOKEN), KD(["RFC-1094: decided to compress history"]), CS([CS_ITEM])),
    );

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    const diag = dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-KD-05");
    expect(diag, "KD-05 must fire when a KEY_DECISIONS item starts with an ID").toBeDefined();
  });

  it("AC-5: compass.inventory emits the new v2 fields per entry", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS([CS_ITEM], "RFC-0348, RFC-0349")),
    );

    const result = await runCompassInventory(makeInput(), makeContext(tempDir, true));
    const entry = dataOf(result).entries.find((e) => e.path === MEDIUM_FILE);
    expect(entry, "inventory must include the fixture entry").toBeDefined();
    expect(entry!.hasKeyDecisions).toBe(true);
    expect(entry!.keyDecisionsItemCount).toBe(1);
    expect(entry!.keyDecisionsRequired).toBe(true);
    expect(entry!.changeSummaryItemCount).toBe(1);
    expect(entry!.historyIds).toEqual(["RFC-0348", "RFC-0349"]);
  });

  it("AC-6: boilerplate purpose reports COMPASS-PURPOSE-01; tokenless purpose reports COMPASS-PURPOSE-02", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(
        MC("This file provides various reusable capabilities for the wider workspace ecosystem."),
        KD([KD_ITEM]),
        CS([CS_ITEM]),
      ),
    );

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    expect(
      dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-PURPOSE-01"),
      "PURPOSE-01 must fire on a boilerplate purpose opener",
    ).toBeDefined();
    expect(
      dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-PURPOSE-02"),
      "PURPOSE-02 must fire when no file-derived token appears in purpose",
    ).toBeDefined();
  });

  it("AC-10: KEY_DECISIONS after CHANGE_SUMMARY reports COMPASS-ORDER-01", async () => {
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), CS([CS_ITEM]), KD([KD_ITEM])));

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    const diag = dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-ORDER-01");
    expect(diag, "ORDER-01 must fire when blocks violate canonical order").toBeDefined();
  });

  it("KD-02: empty or TODO-only KEY_DECISIONS block", async () => {
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), KD_EMPTY, CS([CS_ITEM])));

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    expect(dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-KD-02")).toBeDefined();
  });

  it("KD-03: KEY_DECISIONS item over 20 words", async () => {
    const longItem = Array.from({ length: 21 }, (_, i) => `word${i}`).join(" ");
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), KD([longItem]), CS([CS_ITEM])));

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    expect(dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-KD-03")).toBeDefined();
  });

  it("KD-04: more than 7 KEY_DECISIONS items", async () => {
    const items = Array.from({ length: 8 }, (_, i) => `Decision number ${i} stays deterministic.`);
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), KD(items), CS([CS_ITEM])));

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    expect(dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-KD-04")).toBeDefined();
  });

  it("CS-07: malformed history — non-ID token, duplicates, and descending order", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS([CS_ITEM], "RFC-0350, RFC-0348")),
    );

    const result = await runCompassChangeSummaryValidate(makeInput(), makeContext(tempDir));
    expect(
      dataOf(result).diagnostics.find((d) => d.ruleId === "COMPASS-CS-07"),
      "CS-07 must fire on descending per-namespace order",
    ).toBeDefined();
  });

  it("empty CHANGE_SUMMARY (no items, no history) is legal", async () => {
    writeFixture(MEDIUM_FILE, wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS([])));

    const warnResult = await runCompassValidation(makeInput(), makeContext(tempDir));
    const csResult = await runCompassChangeSummaryValidate(makeInput(), makeContext(tempDir));
    expect(
      dataOf(warnResult).diagnostics.filter((d) => d.ruleId.startsWith("COMPASS-CS-")),
    ).toHaveLength(0);
    expect(
      dataOf(csResult).diagnostics.filter((d) => d.ruleId.startsWith("COMPASS-CS-")),
    ).toHaveLength(0);
  });

  it("fully compliant v2 file produces zero v2 diagnostics", async () => {
    writeFixture(
      MEDIUM_FILE,
      wrap(MC(PURPOSE_WITH_TOKEN), KD([KD_ITEM]), CS([CS_ITEM], "RFC-0348, RFC-0349")),
    );

    const result = await runCompassValidation(makeInput(), makeContext(tempDir));
    const v2 = dataOf(result).diagnostics.filter((d) =>
      ["COMPASS-KD-", "COMPASS-ORDER-", "COMPASS-PURPOSE-"].some((p) => d.ruleId.startsWith(p)),
    );
    expect(v2, `unexpected v2 diagnostics: ${JSON.stringify(v2)}`).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
