import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runCompassSummaryRecord,
  parseChangeSummary,
  mergeHistoryIds,
  buildChangeSummaryBlock,
  stripConventionalPrefix,
  stripGitTrailers,
  isValidGovernanceId,
  CHANGE_SUMMARY_WINDOW,
} from "../summary-record.ts";
import { resolveCompassPolicy } from "../../policy.ts";
import { policyWithIdPattern, cleanupForgeYamlFixtures } from "./forge-yaml-fixture.ts";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

// Generic policy — this path has no forge.yaml, so resolution falls back to
// GENERIC defaults.
const policy = resolveCompassPolicy(join(tmpdir(), "summary-record-no-forge-yaml"));

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

// Dynamic tags: a literal CHANGE_SUMMARY block in this file would be matched
// by compass.summary.record itself and rewritten at commit time.
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const MC_OPEN = "<" + "MODULE_CONTRACT>";
const MC_CLOSE = "</" + "MODULE_CONTRACT>";
const CS_BLOCK_RE = new RegExp(`${CS_OPEN}[\\s\\S]*?${CS_CLOSE}`);
const HTML_OPEN = "<!" + "--";
const HTML_CLOSE = "--" + ">";

// .astro headers can live in a markup comment below the frontmatter — the
// extension table guesses block, the real enclosure is html.
const ASTRO_HTML_HEADER = (items: string[]) => `---
const frontmatter = true;
---
${HTML_OPEN}
${MC_OPEN}
<purpose>Astro page fixture exercising html-enclosed Compass headers.</purpose>
<non-goals><item>No production logic.</item></non-goals>
${MC_CLOSE}
${CS_OPEN}
${items.map((i) => `  <item>${i}</item>`).join("\n")}
${CS_CLOSE}
${HTML_CLOSE}
<main/>
`;

const TS_HEADER = (items: string[], history?: string[]) => `/*
<MODULE_CONTRACT>
<purpose>
Unit tests for summary record covering compass.summary.record; summary-record helpers. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals><item>No production logic.</item></non-goals>
</MODULE_CONTRACT>
${CS_OPEN}
${items.map((i) => `  <item>${i}</item>`).join("\n")}
${history && history.length > 0 ? `  <history>${history.join(", ")}</history>\n` : ""}${CS_CLOSE}
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the summary suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1323: write-time comment-terminator safety — shared comment-safety seam, authored CS-08 reject, injected neutralization, header-region scan</item>
  <item>RFC-1323: review pass — still-open enclosing-style detection, per-file pre-pass parity, scaffold never-throws, docs.scaffold raw-leaf assert, trim per-file skip, CS-08 always-error severity</item>
  <item>RFC-1323: re-review pass — frontmatter-zone enclosing-style detection, existing-item pre-pass gating, trim exit-1 on unsafe, nextSteps rule labels, severity/census test coverage</item>
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
    const parsed = parseChangeSummary(source.match(CS_BLOCK_RE)![0]);
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
    const parsed = parseChangeSummary(source.match(CS_BLOCK_RE)![0]);
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

  it("skips auto-inject when the worktree diff already adds a same-ID item (id-in-diff)", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(["RFC-0001: existing item."]));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
    // The pending change carries a hand-authored descriptive item for the ID.
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-0001: existing item.", "RFC-1095: descriptive hand-written entry"]),
    );

    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "generic subject line" }),
      makeContext(root),
    );

    expect(result.data?.skipped).toEqual([{ file: "src/a.ts", reason: "id-in-diff" }]);
    expect(result.data?.recorded).toEqual([]);
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).not.toContain("generic subject line");
  });

  it("still records when the same-ID item already exists at HEAD (consecutive-commit stack)", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-1095: step 1 — recorded by the previous commit"]),
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });

    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1095", files: ["src/a.ts"], text: "step 2" }),
      makeContext(root),
    );

    expect(result.data?.recorded).toEqual(["src/a.ts"]);
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1095: step 2</item>");
  });

  it("suppresses a diff-added same-ID item even when HEAD already carries the ID (RFC-1315 AC-1)", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-1315: step 1 — recorded by the previous commit"]),
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
    // Pending change hand-authors a second, descriptive same-ID item.
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER([
        "RFC-1315: step 1 — recorded by the previous commit",
        "RFC-1315: hand-authored descriptive entry for this step",
      ]),
    );

    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1315", files: ["src/a.ts"], text: "generic subject line" }),
      makeContext(root),
    );

    expect(result.data?.skipped).toEqual([{ file: "src/a.ts", reason: "id-in-diff" }]);
    expect(result.data?.recorded).toEqual([]);
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).not.toContain("generic subject line");
  });

  it("does not suppress when the diff adds an item for a different ID (RFC-1315)", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(join(root, "src", "a.ts"), TS_HEADER(["RFC-0001: existing item."]));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-0001: existing item.", "RFC-0002: another RFC's item"]),
    );

    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1315", files: ["src/a.ts"], text: "inject me" }),
      makeContext(root),
    );

    expect(result.data?.recorded).toEqual(["src/a.ts"]);
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1315: inject me</item>");
  });

  it("suppresses when the diff verbatim re-adds a same-ID item line (RFC-1315)", async () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-1315: the same line", "RFC-0001: other item."]),
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
    // Swapped item order — git emits the RFC-1315 line as -/+ verbatim re-add.
    await writeFile(
      join(root, "src", "a.ts"),
      TS_HEADER(["RFC-0001: other item.", "RFC-1315: the same line"]),
    );

    const result = await runCompassSummaryRecord(
      makeInput({ id: "RFC-1315", files: ["src/a.ts"], text: "generic subject" }),
      makeContext(root),
    );

    expect(result.data?.skipped).toEqual([{ file: "src/a.ts", reason: "id-in-diff" }]);
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

  it("strips Generated-with/Co-Authored-By trailer blocks from the recorded item (RFC-1233 AC-1)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1233",
        files: ["src/a.ts"],
        text: "trailer stripping\n\nGenerated with [Devin](https://devin.ai)\nCo-Authored-By: Devin <bot@users.noreply.github.com>",
      }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1233: trailer stripping</item>");
    expect(source).not.toContain("Co-Authored-By");
    expect(source).not.toContain("Generated with");
    expect(source).not.toContain("devin.ai");
  });

  it("neutralizes a literal star-slash in injected --text so the item cannot terminate the block comment (RFC-1233 AC-2, RFC-1323)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1233",
        files: ["src/a.ts"],
        text: "glob src" + "/**/*.ts in comments",
        injected: true,
      }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("RFC-1233: glob src");
    expect(source.match(CS_BLOCK_RE)).not.toBeNull();
    // The neutralized form keeps both characters readable but cannot close /*.
    expect(source).toContain("glob src/**" + "∕*.ts in comments");
    // RFC-1323: the record report marks the neutralized file.
    expect(result.data?.neutralized).toEqual(["src/a.ts"]);
  });

  it("rejects a literal star-slash in authored --text with COMPASS-CS-08 and writes nothing (RFC-1323 AC-1)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    const before = await readFile(join(root, "src", "a.ts"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["src/a.ts"],
        text: "glob src" + "/**/*.ts in comments",
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("COMPASS-CS-08");
    expect(result.summary).toContain("src/a.ts");
    // Fail closed: the file is untouched.
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(before);
  });

  it("keeps a single-line subject identical — negative regression (RFC-1233 AC-3)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await runCompassSummaryRecord(
      makeInput({ id: "RFC-1233", files: ["src/a.ts"], text: "plain subject line" }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("<item>RFC-1233: plain subject line</item>");
  });

  it("preserves a Key: value-shaped line when it is not in the trailing block (RFC-1233 AC-4)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1233",
        files: ["src/a.ts"],
        text: "fix the parser\n\nNote: this line is prose about the fix\nfinal summary line",
      }),
      makeContext(root),
    );
    const source = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(source).toContain("Note: this line is prose about the fix");
    expect(source).toContain("final summary line");
  });

  // RFC-1323: style-aware authored/injected coverage. Concatenation keeps the
  // terminator literal out of this file's own comment-level view.
  const BLOCK_TERM = "*" + "/";
  const HTML_CLOSE = "--" + ">";
  const MD_HEADER = (items: string[]) => `${"<"}!--
${MC_OPEN}
<purpose>
Fixture markdown doc for summary record tests.
</purpose>
${MC_CLOSE}
${CS_OPEN}
${items.map((i) => `  <item>${i}</item>`).join("\n")}
${CS_CLOSE}
${HTML_CLOSE}
`;

  it("rejects an authored html terminator on a .md target with COMPASS-CS-08 (RFC-1323 AC-1)", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), MD_HEADER([]));
    const before = await readFile(join(root, "docs", "guide.md"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["docs/guide.md"],
        text: `close the comment ${HTML_CLOSE} here`,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("COMPASS-CS-08");
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe(before);
  });

  it("accepts authored text whose star-slash is harmless in the target's html style (RFC-1323)", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), MD_HEADER([]));
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["docs/guide.md"],
        text: `glob src${BLOCK_TERM}*.ts stays literal in html comments`,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(join(root, "docs", "guide.md"), "utf8");
    expect(source).toContain(`glob src${BLOCK_TERM}*.ts stays literal`);
  });

  it("neutralizes html terminators in injected --text and reports the file (RFC-1323)", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), MD_HEADER([]));
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["docs/guide.md"],
        text: `close ${HTML_CLOSE} open ${"<"}!--`,
        injected: true,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(join(root, "docs", "guide.md"), "utf8");
    expect(source).toContain(`close --› open ‹!--`);
    expect(result.data?.neutralized).toEqual(["docs/guide.md"]);
  });

  it("a mixed target set rejects authored text unsafe for ANY member's style (RFC-1323)", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), MD_HEADER([]));
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    const tsBefore = await readFile(join(root, "src", "a.ts"), "utf8");
    const mdBefore = await readFile(join(root, "docs", "guide.md"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["docs/guide.md", "src/a.ts"],
        text: `glob src${BLOCK_TERM}*.ts`,
      }),
      makeContext(root),
    );
    // Legal inside guide.md's html comment but fatal inside a.ts's block
    // comment — the whole set fails closed, nothing is written anywhere.
    expect(result.exitCode).toBe(1);
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(tsBefore);
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe(mdBefore);
  });

  // RFC-1323 review fixes: .astro files carry BOTH candidate styles — the
  // enclosing comment, not the extension guess, must gate the write.
  it("rejects an authored html terminator on an .astro file whose header is html-enclosed (RFC-1323)", async () => {
    await writeFile(join(root, "src", "page.astro"), ASTRO_HTML_HEADER([]));
    const before = await readFile(join(root, "src", "page.astro"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["src/page.astro"],
        text: `close the comment ${HTML_CLOSE} here`,
      }),
      makeContext(root),
    );
    // The extension table guesses block for .astro — the pre-pass must still
    // catch the html terminator, and nothing must be written.
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("COMPASS-CS-08");
    expect(await readFile(join(root, "src", "page.astro"), "utf8")).toBe(before);
  });

  it("allows authored star-slash text on an .astro file whose header is html-enclosed (RFC-1323)", async () => {
    await writeFile(join(root, "src", "page.astro"), ASTRO_HTML_HEADER([]));
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["src/page.astro"],
        text: `glob src${BLOCK_TERM}*.ts is inert inside an html comment`,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(join(root, "src", "page.astro"), "utf8");
    expect(source).toContain(`glob src${BLOCK_TERM}*.ts is inert`);
  });

  it("neutralizes injected html terminators inside an .astro html header (RFC-1323)", async () => {
    await writeFile(join(root, "src", "page.astro"), ASTRO_HTML_HEADER([]));
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["src/page.astro"],
        text: `close ${HTML_CLOSE} open ${"<"}!--`,
        injected: true,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(join(root, "src", "page.astro"), "utf8");
    expect(source).toContain(`close --› open ‹!--`);
    expect(result.data?.neutralized).toEqual(["src/page.astro"]);
  });

  it("a .ts + .astro-html mixed set rejects authored html text before EITHER file is written (RFC-1323)", async () => {
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await writeFile(join(root, "src", "page.astro"), ASTRO_HTML_HEADER([]));
    const tsBefore = await readFile(join(root, "src", "a.ts"), "utf8");
    const astroBefore = await readFile(join(root, "src", "page.astro"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        // a.ts comes FIRST in the list — a divergent pre-pass would write it
        // before the astro file rejects mid-loop. Atomicity: nothing written.
        files: ["src/a.ts", "src/page.astro"],
        text: `close the comment ${HTML_CLOSE} here`,
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(tsBefore);
    expect(await readFile(join(root, "src", "page.astro"), "utf8")).toBe(astroBefore);
  });

  it("a PRE-EXISTING corrupt item aborts the record before any file writes (RFC-1323)", async () => {
    // The html item parses (<!-- does not end the comment) but re-emitting it
    // would corrupt — buildChangeSummaryBlock asserts all items, so the
    // pre-pass must catch it before the first file in the batch is written.
    await writeFile(join(root, "src", "a.ts"), TS_HEADER([]));
    await writeFile(
      join(root, "src", "page.astro"),
      ASTRO_HTML_HEADER([`RFC-0001: existing ${"<"}!-- note`]),
    );
    const tsBefore = await readFile(join(root, "src", "a.ts"), "utf8");
    const astroBefore = await readFile(join(root, "src", "page.astro"), "utf8");
    const result = await runCompassSummaryRecord(
      makeInput({
        id: "RFC-1323",
        files: ["src/a.ts", "src/page.astro"],
        text: "harmless new text",
      }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("COMPASS-CS-08");
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(tsBefore);
    expect(await readFile(join(root, "src", "page.astro"), "utf8")).toBe(astroBefore);
  });
});

describe("summary-record helpers", () => {
  it("stripConventionalPrefix removes conventional commit prefixes", () => {
    expect(stripConventionalPrefix("implement: RFC-1095 — record")).toBe("RFC-1095 — record");
    expect(stripConventionalPrefix("fix(scope)!: bug")).toBe("bug");
    expect(stripConventionalPrefix("plain subject")).toBe("plain subject");
  });

  it("isValidGovernanceId accepts RFC/ADR/ticket shapes only", () => {
    expect(isValidGovernanceId("RFC-1095", policy)).toBe(true);
    expect(isValidGovernanceId("ADR-0042", policy)).toBe(true);
    expect(isValidGovernanceId("PROJ-123", policy)).toBe(true);
    expect(isValidGovernanceId("rfc-1095", policy)).toBe(false);
    expect(isValidGovernanceId("RFC1095", policy)).toBe(false);
    expect(isValidGovernanceId("RFC-1095 extra", policy)).toBe(false);
  });

  it("mergeHistoryIds dedupes and sorts per-namespace ascending", () => {
    expect(mergeHistoryIds(["RFC-0005"], ["RFC-0002", "ADR-0001", "RFC-0005"], policy)).toEqual([
      "ADR-0001",
      "RFC-0002",
      "RFC-0005",
    ]);
  });

  afterEach(() => {
    cleanupForgeYamlFixtures();
  });

  it("mergeHistoryIds sorts mission-format tokens under their namespace (RFC-1220)", () => {
    const missionPolicy = policyWithIdPattern(
      "\\b(?:[A-Z][A-Z0-9]*-)+\\d+\\b|\\b[a-z][a-z0-9-]*-m\\d{6}\\b",
    );
    expect(mergeHistoryIds(["acme-m000003"], ["acme-m000001", "RFC-0002"], missionPolicy)).toEqual([
      "acme-m000001",
      "acme-m000003",
      "RFC-0002",
    ]);
  });

  it("mergeHistoryIds appends unparseable admitted tokens last (RFC-1220)", () => {
    const driftPolicy = policyWithIdPattern("\\b(?:[A-Z][A-Z0-9]*-)+\\d+\\b|\\b[A-Z]+-[A-Z]+\\b");
    expect(mergeHistoryIds(["FOO-BAR"], ["RFC-0002", "RFC-0001"], driftPolicy)).toEqual([
      "RFC-0001",
      "RFC-0002",
      "FOO-BAR",
    ]);
  });

  it("buildChangeSummaryBlock omits <history> when empty", () => {
    const block = buildChangeSummaryBlock(["RFC-1: a"], [], "x.ts");
    expect(block).not.toContain("<history>");
    expect(block).toContain("<item>RFC-1: a</item>");
  });

  it("stripGitTrailers strips a Token:-shaped tail block (RFC-1233)", () => {
    expect(
      stripGitTrailers("subject\n\nbody line\nCo-Authored-By: Devin <bot@x>\nX-RFC: RFC-1233"),
    ).toBe("subject\n\nbody line");
  });

  it("stripGitTrailers keeps a lone markdown-link tail (no strict trailer line)", () => {
    const msg = "subject\n\nsee [the docs](https://example.com)";
    expect(stripGitTrailers(msg)).toBe(msg);
  });

  it("stripGitTrailers on a trailer-only message returns empty", () => {
    expect(stripGitTrailers("Co-Authored-By: Devin <bot@x>")).toBe("");
  });

  it("stripGitTrailers strips empty-value trailers (Token:) — interpret-trailers allows them", () => {
    expect(stripGitTrailers("subject\n\nReviewed-by:\nSigned-off-by: Devin <bot@x>")).toBe(
      "subject",
    );
  });
});
