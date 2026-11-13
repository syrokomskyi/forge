/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: tests for codebase.measure — exclusion contour, category
classification, line metrics, AST symbol counts, honest degradation,
binary files, read-only default and --out snapshot writing.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial test coverage.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
  <item>RFC-1581: apply REVIEW-CODE-2026-11-13-01 — contract alignment, repo-root anchor, publishConfig exports</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodebaseMeasure } from "../../os/codebase/handlers/codebase-measure.ts";
import type { CodebaseMeasure } from "../../os/codebase/types.ts";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeLogger } from "../../src/types.ts";

const noopLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return { workspaceRoot, logger: noopLogger, dryRun: false, outputFormat: "json" };
}

const NO_FLAGS: ForgeCommandInput = { argv: [], flags: {} };

function gitInit(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
}

async function add(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  execFileSync("git", ["add", rel], { cwd: root });
}

async function addUntracked(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const testRequire = createRequire(import.meta.url);

/** Give the fixture a resolvable typescript (the pass resolves from workspaceRoot). */
async function linkTypescript(root: string): Promise<void> {
  const tsPkg = dirname(testRequire.resolve("typescript/package.json"));
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(tsPkg, join(root, "node_modules", "typescript"), "dir");
}

async function measure(
  root: string,
  flags: Record<string, string | boolean> = {},
): Promise<{ data: CodebaseMeasure; exitCode?: number }> {
  const res = await runCodebaseMeasure({ argv: [], flags }, makeContext(root));
  return { data: res.data as CodebaseMeasure, exitCode: res.exitCode };
}

describe("RFC-1581: codebase.measure", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codebase-measure-XXXXXX-"));
    gitInit(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-1: counts code/comment/blank lines on the tracked set", async () => {
    await add(root, "src/a.ts", "// c\nconst x = 1;\n\nconst y = 2;\n");
    const { data, exitCode } = await measure(root);
    expect(exitCode).toBe(0);
    expect(data.status).toBe("ok");
    expect(data.totals.code.files).toBe(1);
    expect(data.totals.code.code).toBe(2);
    const ts = data.languages.find((l) => l.language === "TypeScript");
    expect(ts).toBeDefined();
    expect(ts!.comments).toBe(1);
    expect(ts!.blanks).toBe(1);
  });

  it("AC-4: excluded paths and untracked files never enter the measurement", async () => {
    await add(root, "src/keep.ts", "const a = 1;\n");
    await add(root, ".agents/skills/x/SKILL.md", "# twin\n");
    await add(root, "missions/m1/a.ts", "const m = 1;\n");
    await add(root, "docs/specs/spec.md", "# spec\n");
    await add(root, "docs/audits/old.md", "# audit\n");
    await add(root, "dist/bundle.js", "var b;\n");
    await add(root, "docs/metrics/m.yaml", "a: 1\n");
    await addUntracked(root, "src/untracked.ts", "const u = 1;\n");
    const { data } = await measure(root);
    expect(data.totals.code.files).toBe(1);
    expect(data.totals.code.code).toBe(1);
    expect(data.languages.map((l) => l.language)).toEqual(["TypeScript"]);
  });

  it("AC-5: categories are exactly code/tests/docs/generated, first-match wins", async () => {
    await add(root, "src/impl.ts", "const i = 1;\n");
    await add(root, "src/x.test.ts", "const t = 1;\n");
    await add(root, "tests/e2e.ts", "const e = 1;\n");
    await add(root, "README.md", "# hi\n");
    await add(root, "docs/cfg.yaml", "a: 1\n");
    await add(root, "LICENSE", "MIT\n");
    await add(root, "docs/eco.generated.yaml", "a: 1\n");
    const { data } = await measure(root);
    expect(Object.keys(data.totals).sort()).toEqual(["code", "docs", "generated", "tests"]);
    expect(data.totals.code.files).toBe(1);
    expect(data.totals.tests.files).toBe(2);
    expect(data.totals.docs.files).toBe(3);
    expect(data.totals.generated.files).toBe(1);
  });

  it("AC-6: AST-derived symbol counts for the TS family", async () => {
    await linkTypescript(root);
    await add(
      root,
      "src/k.ts",
      "class K {\n  m() {}\n}\nfunction f() {}\nconst g = () => 1;\nconst h = function () {};\n",
    );
    const { data } = await measure(root);
    const ts = data.languages.find((l) => l.language === "TypeScript");
    expect(ts!.symbols).toBeDefined();
    expect(ts!.symbols!.classes).toBe(1);
    expect(ts!.symbols!.methods).toBe(1);
    expect(ts!.symbols!.functions).toBe(3); // f + arrow g + function-expression h
    expect(data.symbolsSkipped).toEqual([]);
  });

  it("AC-6: .astro counts markup lines; frontmatter feeds the symbol pass", async () => {
    await linkTypescript(root);
    await add(root, "src/P.astro", "---\nconst x = 1;\nfunction go() {}\n---\n<div>hi</div>\n");
    const { data } = await measure(root);
    const astro = data.languages.find((l) => l.language === "Astro");
    expect(astro).toBeDefined();
    expect(astro!.files).toBe(1);
    expect(astro!.symbols!.functions).toBe(1);
  });

  it("AC-3: missing typescript degrades to lines-only with an explicit skip", async () => {
    await add(root, "src/a.ts", "class A {}\n");
    const { data, exitCode } = await measure(root);
    expect(exitCode).toBe(0);
    expect(data.symbolsSkipped).toContain("typescript-unavailable");
    const ts = data.languages.find((l) => l.language === "TypeScript");
    expect(ts!.code).toBe(1);
    expect(ts!.symbols).toBeUndefined();
  });

  it("AC-2/AC-10: fails with required nextSteps outside a git repository", async () => {
    const bare = await mkdtemp(join(tmpdir(), "codebase-nogit-XXXXXX-"));
    try {
      const res = await runCodebaseMeasure(NO_FLAGS, makeContext(bare));
      expect(res.exitCode).toBe(1);
      expect(res.summary).toContain("[codebase.measure]");
      expect(res.nextSteps?.some((s) => s.kind === "required")).toBe(true);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("binary files count toward files but contribute zero lines", async () => {
    await add(root, "src/a.ts", "const x = 1;\n");
    await add(root, "img/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await add(root, "img/logo.generated.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const { data } = await measure(root);
    expect(data.binaryFiles).toBe(2);
    expect(data.totals.code.files).toBe(2); // a.ts + logo.png (name rules apply)
    expect(data.totals.generated.files).toBe(1); // logo.generated.png — name rule without content
    expect(data.totals.code.code).toBe(1);
    expect(data.languages).toHaveLength(1);
  });

  it("lockfiles count as generated bookkeeping mass, never as code", async () => {
    await add(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await add(root, "src/a.ts", "const x = 1;\n");
    const { data } = await measure(root);
    expect(data.totals.generated.files).toBe(1);
    expect(data.totals.code.files).toBe(1);
    expect(data.totals.code.code).toBe(1);
  });

  it("AC-1: contract keys — repo, exclusions, measuredAt present in data", async () => {
    await add(root, "missions/m1/a.ts", "const m = 1;\n");
    await add(root, "src/a.ts", "const x = 1;\n");
    const { data } = await measure(root);
    expect(data.repo).toBe(basename(root));
    expect(data.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.exclusions).toContain("dir:missions/");
    expect(data.exclusions).not.toContain("dir:docs/specs/");
  });

  it("anchors on the repo root — identical measurement from a subdirectory", async () => {
    await add(root, "src/a.ts", "const x = 1;\n");
    await add(root, "docs/guide.md", "# g\n");
    const sub = join(root, "src");
    const res = await runCodebaseMeasure(NO_FLAGS, makeContext(sub));
    expect(res.exitCode).toBe(0);
    expect(res.data!.totals.code.files).toBe(1);
    expect(res.data!.totals.docs.files).toBe(1);
  });

  it("empty repository exits 0 with zeroed measures", async () => {
    const { data, exitCode } = await measure(root);
    expect(exitCode).toBe(0);
    expect(data.totals.code).toEqual({ files: 0, code: 0 });
    expect(data.languages).toEqual([]);
    expect(data.topDirs).toEqual([]);
  });

  it("AC-9: default invocation writes nothing; --out writes the snapshot", async () => {
    await add(root, "src/a.ts", "const x = 1;\n");
    const before = (dir: string): string[] =>
      readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => !f.startsWith(".git"));
    const namesBefore = before(root);
    await measure(root);
    expect(before(root)).toEqual(namesBefore);

    const { data, exitCode } = await measure(root, { out: "snap/snap.yaml" });
    expect(exitCode).toBe(0);
    expect(existsSync(join(root, "snap", "snap.yaml"))).toBe(true);
    const snap = readFileSync(join(root, "snap", "snap.yaml"), "utf8");
    expect(snap).toContain("codebase.measure");
    expect(data.status).toBe("ok");
  });

  it("topDirs ranks directories by code lines, capped at 10", async () => {
    for (let i = 0; i < 12; i++) {
      await add(root, `pkg${i}/src/a.ts`, `const x${i} = ${i};\n`.repeat(i + 1));
    }
    const { data } = await measure(root);
    expect(data.topDirs.length).toBe(10);
    expect(data.topDirs[0]!.path).toBe("pkg11/src");
    for (let i = 1; i < data.topDirs.length; i++) {
      expect(data.topDirs[i]!.code).toBeLessThanOrEqual(data.topDirs[i - 1]!.code);
    }
  });
});
