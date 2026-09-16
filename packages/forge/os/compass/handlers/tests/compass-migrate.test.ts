import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { migrateFile, type MigrateAction } from "../compass-migrate.ts";
import { runCompassMigrate } from "../compass-migrate-handler.ts";
import { resolveCompassPolicy, type CompassPolicy } from "../../policy.ts";
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

// Dynamic tags: literal CHANGE_SUMMARY blocks in this file would be matched
// by compass.summary.record itself and rewritten at commit time.
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const MC = (purpose: string) =>
  `<MODULE_CONTRACT>\n<purpose>${purpose}</purpose>\n<non-goals>\n  <item>Do not perform real validation — fixtures only.</item>\n</non-goals>\n</MODULE_CONTRACT>`;
const KD = (items: string[]) =>
  `<KEY_DECISIONS>\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n</KEY_DECISIONS>`;
const CS = (items: string[], history?: string) =>
  `${CS_OPEN}\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n${history ? `  <history>${history}</history>\n` : ""}${CS_CLOSE}`;
const wrap = (...blocks: string[]) => `/*\n${blocks.join("\n")}\n*/`;

const PURPOSE = "Validates mission widget fixtures for the compass migrate test suite.";
const KD_ITEM = "Fixtures live in a temp workspace so tests never touch the real repository.";

// Medium-risk: packages/<pkg>/src/components/** → workspace-relative src/components/** → layer component.
const MEDIUM_ROOT = "packages/fixture-pkg/src/components/mission-widget.ts";
const MEDIUM_WS = "src/components/mission-widget.ts";
// Low-risk: bare src/** → layer source.
const LOW_ROOT = "packages/fixture-pkg/src/mission-notes.ts";
const LOW_WS = "src/mission-notes.ts";

const BODY = Array.from({ length: 25 }, (_, i) => `export const fixtureLine${i} = ${i};`).join(
  "\n",
);

let policy: CompassPolicy;

function migrate(source: string, root = MEDIUM_ROOT, ws = MEDIUM_WS) {
  return migrateFile(`${source}\n\n${BODY}\n`, policy, root, ws);
}

describe("compass.migrate codemod (RFC-1097)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-migrate-test-"));
    policy = resolveCompassPolicy(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no-header: file without any Compass block is skipped", () => {
    const result = migrateFile(`export const x = 1;\n`, policy, MEDIUM_ROOT, MEDIUM_WS);
    expect(result.actions).toEqual(["no-header"]);
    expect(result.source).toBe("export const x = 1;\n");
  });

  it("unparseable: open tag without close is skipped", () => {
    const broken = `/*\n<MODULE_CONTRACT>\n<purpose>${PURPOSE}</purpose>\n`;
    const result = migrateFile(broken, policy, MEDIUM_ROOT, MEDIUM_WS);
    expect(result.actions).toEqual(["unparseable"]);
    expect(result.source).toBe(broken);
  });

  it("collapsed: 8 items keep newest 5, overflow IDs merge into sorted history, ID-less items drop", () => {
    const items = [
      "RFC-1001: first.",
      "no-id item that must be dropped.",
      "RFC-1002: second.",
      "RFC-1003: third.",
      "RFC-1004: fourth.",
      "RFC-1005: fifth.",
      "RFC-1006: sixth.",
      "RFC-1007: seventh.",
      "RFC-1008: eighth.",
    ];
    const result = migrate(wrap(MC(PURPOSE), KD([KD_ITEM]), CS(items, "ADR-0001, RFC-0999")));
    expect(result.actions).toContain("collapsed");
    const csBlock = result.source.match(
      new RegExp(
        `${CS_OPEN.replace(/[<>]/g, "\\$&")}[\\s\\S]*?${CS_CLOSE.replace(/[<>/]/g, "\\$&")}`,
      ),
    );
    const kept = csBlock?.[0].match(/<item>([^<]+)<\/item>/g) ?? [];
    // 5 newest CS items survive inside the block.
    expect(kept.length).toBe(5);
    expect(result.source).toContain("RFC-1008: eighth.");
    expect(result.source).not.toContain("no-id item");
    const historyMatch = result.source.match(/<history>([^<]+)<\/history>/);
    expect(historyMatch, "collapsed IDs must land in history").toBeTruthy();
    expect(historyMatch![1]).toBe("ADR-0001, RFC-0999, RFC-1001, RFC-1002, RFC-1003");
  });

  it("stripped: MODULE_MAP, keywords, responsibilities and COMPASS_BLOCK anchors are removed", () => {
    const mm = "<" + "MODULE_MAP" + ">\n  <item>x</item>\n</" + "MODULE_MAP" + ">";
    const kw = "<keywords>a, b</keywords>";
    const resp = "<responsibilities>\n  <item>y</item>\n</responsibilities>";
    const anchorOpen = "<" + "COMPASS_BLOCK" + ">";
    const anchorClose = "</" + "COMPASS_BLOCK" + ">";
    const source = wrap(
      anchorOpen,
      MC(PURPOSE),
      mm,
      kw,
      resp,
      KD([KD_ITEM]),
      CS(["RFC-1094: fixture."]),
      anchorClose,
    );
    const result = migrate(source);
    expect(result.actions).toContain("stripped");
    expect(result.source).not.toContain("MODULE_MAP");
    expect(result.source).not.toContain("keywords");
    expect(result.source).not.toContain("responsibilities");
    expect(result.source).not.toContain("COMPASS_BLOCK");
  });

  it("reordered: KEY_DECISIONS after CHANGE_SUMMARY moves to canonical order", () => {
    const result = migrate(wrap(MC(PURPOSE), CS(["RFC-1094: fixture."]), KD([KD_ITEM])));
    expect(result.actions).toContain("reordered");
    const mcIdx = result.source.indexOf("<MODULE_CONTRACT>");
    const kdIdx = result.source.indexOf("<KEY_DECISIONS>");
    const csIdx = result.source.indexOf(CS_OPEN);
    expect(mcIdx).toBeLessThan(kdIdx);
    expect(kdIdx).toBeLessThan(csIdx);
  });

  it("seeded: medium-risk file with @ai-invariant comments gets real KEY_DECISIONS, ID prefix stripped", () => {
    const source = `${wrap(MC(PURPOSE), CS(["RFC-1094: fixture."]))}\n// @ai-invariant RFC-0020: Widget tokens must stay deterministic.\n// @ai-invariant Widget tokens must stay deterministic.\n\n${BODY}\n`;
    const result = migrateFile(source, policy, MEDIUM_ROOT, MEDIUM_WS);
    expect(result.actions).toContain("seeded");
    const kdMatch = result.source.match(/<KEY_DECISIONS>([\s\S]*?)<\/KEY_DECISIONS>/);
    expect(kdMatch, "seeded file must carry a KEY_DECISIONS block").toBeTruthy();
    expect(kdMatch![1]).toContain("Widget tokens must stay deterministic.");
    // Deduped (two identical invariants → one item) and ID prefix stripped (KD-05).
    expect(kdMatch![1]).not.toContain("RFC-0020");
    expect((kdMatch![1].match(/<item>/g) ?? []).length).toBe(1);
  });

  it("todo: medium-risk file without @ai-invariant gets the TODO placeholder", () => {
    const result = migrate(wrap(MC(PURPOSE), CS(["RFC-1094: fixture."])));
    expect(result.actions).toContain("todo");
    expect(result.source).toContain("TODO: record current design decisions");
  });

  it("low-risk file without KEY_DECISIONS is not seeded", () => {
    const result = migrateFile(
      `${wrap(MC(PURPOSE), CS(["RFC-1094: fixture."]))}\n\n${BODY}\n`,
      policy,
      LOW_ROOT,
      LOW_WS,
    );
    expect(result.actions).not.toContain("seeded");
    expect(result.actions).not.toContain("todo");
    expect(result.source).not.toContain("<KEY_DECISIONS>");
  });

  it("purpose-flagged: boilerplate purpose is reported without rewriting", () => {
    const result = migrate(
      wrap(
        MC("This file provides various reusable capabilities for the wider workspace ecosystem."),
        KD([KD_ITEM]),
        CS(["RFC-1094: fixture."]),
      ),
    );
    expect(result.actions).toEqual(["purpose-flagged"]);
  });

  it("unchanged: fully compliant v2 file reports unchanged and is idempotent", () => {
    const v2 = wrap(MC(PURPOSE), KD([KD_ITEM]), CS(["RFC-1094: fixture."], "RFC-0348"));
    const first = migrate(v2);
    expect(first.actions).toEqual(["unchanged"]);
    const second = migrateFile(first.source, policy, MEDIUM_ROOT, MEDIUM_WS);
    expect(second.actions).toEqual(["unchanged"]);
    expect(second.source).toBe(first.source);
  });

  it("idempotent: a migrated file migrates to unchanged on the second pass", () => {
    const items = Array.from({ length: 8 }, (_, i) => `RFC-100${i}: item ${i}.`);
    const first = migrate(wrap(MC(PURPOSE), CS(items)));
    expect(first.actions.length).toBeGreaterThan(0);
    const second = migrateFile(first.source, policy, MEDIUM_ROOT, MEDIUM_WS);
    expect(
      second.actions,
      `second pass must be a no-op, got ${JSON.stringify(second.actions)}`,
    ).toEqual(["unchanged"]);
  });
});

describe("runCompassMigrate handler (RFC-1097)", () => {
  let tempDir: string;

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: tempDir, stdio: "ignore", timeout: 10000 });
  }

  function writeFixture(relPath: string, header: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${header}\n\n${BODY}\n`);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-migrate-handler-"));
    policy = resolveCompassPolicy(tempDir);
    git("init", "-q");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "Test");
    git("commit", "-q", "--allow-empty", "-m", "init");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses a dirty git tree without --force and lists dirty paths", async () => {
    writeFixture(MEDIUM_ROOT, wrap(MC(PURPOSE), CS(["RFC-1094: fixture."])));

    const result = await runCompassMigrate(makeInput(), makeContext(tempDir));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("dirty");
  });

  it("--force overrides the dirty-tree refusal", async () => {
    writeFixture(MEDIUM_ROOT, wrap(MC(PURPOSE), CS(["RFC-1094: fixture."])));

    const result = await runCompassMigrate(makeInput({ force: true }), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    const data = dataOf(result);
    expect(data.scanned).toBeGreaterThan(0);
  });

  it("dry-run reports actions without writing", async () => {
    const items = Array.from({ length: 8 }, (_, i) => `RFC-100${i}: item ${i}.`);
    writeFixture(MEDIUM_ROOT, wrap(MC(PURPOSE), KD([KD_ITEM]), CS(items)));
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    const before = (await import("node:fs/promises")).readFile;
    const original = await before(join(tempDir, MEDIUM_ROOT), "utf8");
    const result = await runCompassMigrate(makeInput({ "dry-run": true }), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    const data = dataOf(result);
    const entry = data.files.find((f) => f.path === MEDIUM_ROOT);
    expect(entry?.actions).toContain("collapsed");
    const after = await before(join(tempDir, MEDIUM_ROOT), "utf8");
    expect(after, "dry-run must not write").toBe(original);
  });

  it("--files bypasses scan roots and processes the explicit list", async () => {
    const outside = "custom-dir/widget.ts";
    writeFixture(outside, wrap(MC(PURPOSE), CS(["RFC-1094: fixture."])));
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    const result = await runCompassMigrate(makeInput({ files: [outside] }), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    const data = dataOf(result);
    expect(data.files).toHaveLength(1);
    expect(data.files[0]!.path).toBe(outside);
    const actions: MigrateAction[] = data.files[0]!.actions;
    // custom-dir/widget.ts is low-risk (no layer match) → no seeding, v1 file is already clean.
    expect(actions).toEqual(["unchanged"]);
  });
});
