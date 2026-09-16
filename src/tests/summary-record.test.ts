import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCompassSummaryRecord,
  parseChangeSummary,
  mergeHistoryIds,
  buildChangeSummaryBlock,
  stripConventionalPrefix,
  isValidGovernanceId,
  CHANGE_SUMMARY_WINDOW,
} from "../../os/compass/handlers/summary-record.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const logger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
  getEvents() {
    return [];
  },
};

function makeContext(workspaceRoot: string, dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: logger as never,
    dryRun,
    outputFormat: "pretty",
  };
}

function makeInput(flags: Record<string, unknown>) {
  return { argv: [], flags: flags as never };
}

const TS_HEADER = (items: string[], history?: string[]) => `/*
<MODULE_CONTRACT>
<purpose>Test fixture file for summary record coverage.</purpose>
<non-goals><item>No production logic.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>${i}</item>
  <item>RFC-1095: summary-record unit tests, commit integration tests, CS rules into compass.validate</item>
</CHANGE_SUMMARY>
*/
export const x = 1;
`;

describe("compass.summary.record", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "summary-record-"));
    await mkdir(join(root, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends an ID-prefixed item to CHANGE_SUMMARY (AC-1)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(["RFC-0001: existing item."]));
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "added record command" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1095: added record command</item>");
    expect(result.data?.recorded).toEqual(["src/a.ts"]);
  });

  it("skips duplicate items with identical ID+text (AC-2)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(["RFC-1095: added record command"]));
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "added record command" }),
      makeContext(root),
    );
    expect(result.data?.skipped).toEqual([{ file: "src/a.ts", reason: "duplicate" }]);
    expect(result.data?.recorded).toEqual([]);
  });

  it("collapses the oldest item into <history> past the 5-item window (AC-3)", async () => {
    const items = Array.from(
      { length: CHANGE_SUMMARY_WINDOW },
      (_, i) => `RFC-000${i}: item ${i}.`,
    );
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(items));
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "overflow item" }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    const parsed = parseChangeSummary(
      source.match(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/)![0],
    );
    expect(parsed.items).toHaveLength(CHANGE_SUMMARY_WINDOW);
    expect(parsed.items.at(-1)).toBe("RFC-1095: overflow item");
    expect(parsed.historyIds).toContain("RFC-0000");
    expect(result.data?.collapsed).toEqual(["src/a.ts"]);
  });

  it("merges collapsed IDs into existing history deduped and per-namespace ascending (AC-4)", async () => {
    const items = Array.from(
      { length: CHANGE_SUMMARY_WINDOW },
      (_, i) => `RFC-000${i}: item ${i}.`,
    );
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(items, ["RFC-0000", "ADR-0002"]));
    await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "overflow" }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    const parsed = parseChangeSummary(
      source.match(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/)![0],
    );
    // RFC-0000 deduped; ADR-0002 sorts before RFC namespace.
    expect(parsed.historyIds).toEqual(["ADR-0002", "RFC-0000"]);
  });

  it("skips files without a CHANGE_SUMMARY block (AC-5)", async () => {
    await writeFile(join(root, "src", "plain.ts"), "export const y = 2;\n");
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/plain.ts"], text: "x" }),
      makeContext(root),
    );
    expect(result.data?.skipped).toEqual([{ file: "src/plain.ts", reason: "no-block" }]);
  });

  it("skips missing files as unparseable without failing (AC-5)", async () => {
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/ghost.ts"], text: "x" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.skipped).toEqual([{ file: "src/ghost.ts", reason: "unparseable" }]);
  });

  it("rejects a missing or malformed --id", async () => {
    const bad = await runCompassSummaryRecord(
      makeInput({ id: "not-an-id", files: ["src/a.ts"] }),
      makeContext(root),
    );
    expect(bad.exitCode).toBe(1);
    const missing = await runCompassSummaryRecord(
      makeInput({ files: ["src/a.ts"] }),
      makeContext(root),
    );
    expect(missing.exitCode).toBe(1);
  });

  it("defaults item text to the bare ID when --text is absent", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await runCompassSummaryRecord(
      makeInput({ id: "ADR-0042", files: ["src/a.ts"] }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>ADR-0042</item>");
  });

  it("does not write files in dry-run mode", async () => {
    const original = TS_HEADER(["RFC-0001: existing."]);
    await writeFile(join(root, "src", "a.ts"), original);
    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "dry run item" }),
      makeContext(root, true),
    );
    expect(result.data?.recorded).toEqual(["src/a.ts"]);
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(original);
  });

  it("strips a duplicated leading ID from --text", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "RFC-1095 — record command" }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1095: record command</item>");
    expect(source).not.toContain("RFC-1095: RFC-1095");
  });
});

describe("summary-record helpers", () => {
  it("stripConventionalPrefix removes conventional commit prefixes", () => {
    expect(stripConventionalPrefix("implement: RFC-1095 — record")).toBe("RFC-1095 — record");
    expect(stripConventionalPrefix("fix(scope)!: bug")).toBe("bug");
    expect(stripConventionalPrefix("plain subject")).toBe("plain subject");
  });

  it("isValidGovernanceId accepts RFC/ADR/ticket shapes only", () => {
    expect(isValidGovernanceId("RFC-1095")).toBe(true);
    expect(isValidGovernanceId("ADR-0042")).toBe(true);
    expect(isValidGovernanceId("PROJ-123")).toBe(true);
    expect(isValidGovernanceId("rfc-1095")).toBe(false);
    expect(isValidGovernanceId("RFC1095")).toBe(false);
    expect(isValidGovernanceId("RFC-1095 extra")).toBe(false);
  });

  it("mergeHistoryIds dedupes and sorts per-namespace ascending", () => {
    expect(mergeHistoryIds(["RFC-0005"], ["RFC-0002", "ADR-0001", "RFC-0005"])).toEqual([
      "ADR-0001",
      "RFC-0002",
      "RFC-0005",
    ]);
  });

  it("buildChangeSummaryBlock omits <history> when empty", () => {
    const block = buildChangeSummaryBlock(["RFC-1: a"], [], "x.ts");
    expect(block).not.toContain("<history>");
    expect(block).toContain("<item>RFC-1: a</item>");
  });
});
