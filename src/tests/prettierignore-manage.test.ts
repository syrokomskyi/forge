/*
<MODULE_CONTRACT>
<purpose>Unit tests for the RFC-1154 managed .prettierignore block:
root-only prettier detection, delimited-block reconcile preserving operator
content, marker-driven skill entries, and the skipped contract for
prettier-free consumers.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial prettierignore plan/apply tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planPrettierignore,
  applyPrettierignore,
  reconcilePrettierignoreContent,
  PRETTIERIGNORE_BLOCK_BEGIN,
  PRETTIERIGNORE_BLOCK_END,
} from "../onboarding/prettierignore.ts";
import { SKILL_MARKER_FILE } from "../onboarding/skill-markers.ts";
import { buildGeneratedHeader } from "../utils/index.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "prettierignore-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function withPrettier(root: string): Promise<void> {
  await writeFile(join(root, ".prettierrc"), "{}\n");
}

test("detects prettier via root .prettierrc", async () => {
  await withPrettier(tmpDir);
  const plan = await planPrettierignore(tmpDir);
  expect(plan.applies).toBe(true);
});

test("detects prettier via package.json prettier key", async () => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({ prettier: {} }));
  const plan = await planPrettierignore(tmpDir);
  expect(plan.applies).toBe(true);
});

test("detects prettier via prettier devDependency", async () => {
  await writeFile(
    join(tmpDir, "package.json"),
    JSON.stringify({ devDependencies: { prettier: "^3" } }),
  );
  const plan = await planPrettierignore(tmpDir);
  expect(plan.applies).toBe(true);
});

test("detects prettier via existing .prettierignore alone", async () => {
  await writeFile(join(tmpDir, ".prettierignore"), "dist/\n");
  const plan = await planPrettierignore(tmpDir);
  expect(plan.applies).toBe(true);
});

test("AC-4: no prettier markers — plan does not apply, apply writes nothing", async () => {
  const plan = await planPrettierignore(tmpDir);
  expect(plan.applies).toBe(false);
  const result = await applyPrettierignore(tmpDir, plan);
  expect(result).toBe("skipped");
  expect(existsSync(join(tmpDir, ".prettierignore"))).toBe(false);
});

test("AC-2: block contains generated.yaml glob, sessions, metrics, queues entries", async () => {
  await withPrettier(tmpDir);
  const plan = await planPrettierignore(tmpDir);
  const result = await applyPrettierignore(tmpDir, plan);
  expect(result).toBe("written");
  const content = await readFile(join(tmpDir, ".prettierignore"), "utf8");
  expect(content).toContain(PRETTIERIGNORE_BLOCK_BEGIN);
  expect(content).toContain("**/*.generated.yaml");
  expect(content).toContain("docs/sessions/");
  expect(content).toContain("docs/metrics/");
  expect(content).toContain("docs/queues/session-*.yaml");
  expect(content).toContain(PRETTIERIGNORE_BLOCK_END);
});

test("skill entries enumerate only marker-carrying dirs (AC-9)", async () => {
  await withPrettier(tmpDir);
  const skillsDir = join(tmpDir, ".agents", "skills");
  await mkdir(join(skillsDir, "fo-idea"), { recursive: true });
  await writeFile(join(skillsDir, "fo-idea", SKILL_MARKER_FILE), '{"files":["SKILL.md"]}');
  await mkdir(join(skillsDir, "my-own-skill"), { recursive: true }); // unmarked — consumer-owned

  const plan = await planPrettierignore(tmpDir);
  expect(plan.entries).toContain(".agents/skills/fo-idea/");
  expect(plan.entries).not.toContain(".agents/skills/my-own-skill/");
});

test("generated AGENTS.md entries — root + marker-bearing nested, hand-written excluded", async () => {
  await withPrettier(tmpDir);
  const header = buildGeneratedHeader({
    filePath: "AGENTS.md",
    ownerCommand: "agents.generate",
    editable: true,
  });
  // Root generated AGENTS.md
  await writeFile(join(tmpDir, "AGENTS.md"), `${header}\n# Guide\n`);
  // Nested workspace with a generated AGENTS.md
  const genDir = join(tmpDir, "packages", "gen");
  await mkdir(genDir, { recursive: true });
  await writeFile(join(genDir, "package.json"), JSON.stringify({ name: "gen" }));
  await writeFile(join(genDir, "AGENTS.md"), `${header}\n# Gen\n`);
  // Hand-written nested AGENTS.md — stays operator-owned, prettier-covered
  const ownDir = join(tmpDir, "packages", "own");
  await mkdir(ownDir, { recursive: true });
  await writeFile(join(ownDir, "package.json"), JSON.stringify({ name: "own" }));
  await writeFile(join(ownDir, "AGENTS.md"), "# Hand-written\n");

  const plan = await planPrettierignore(tmpDir);
  expect(plan.entries).toContain("/AGENTS.md");
  expect(plan.entries).toContain("packages/gen/AGENTS.md");
  expect(plan.entries).not.toContain("packages/own/AGENTS.md");
  // A bare "AGENTS.md" entry would ignore hand-written nested guides too —
  // the root entry must stay anchored.
  expect(plan.entries).not.toContain("AGENTS.md");
});

test("reconcile preserves operator content outside the block", async () => {
  const existing = `dist/\nnode_modules/\n${PRETTIERIGNORE_BLOCK_BEGIN}\nold-entry/\n${PRETTIERIGNORE_BLOCK_END}\ncustom/\n`;
  const { next, changed } = reconcilePrettierignoreContent(existing, ["a/", "b/"]);
  expect(changed).toBe("updated");
  expect(next).toContain("dist/\nnode_modules/\n");
  expect(next).toContain("custom/\n");
  expect(next).not.toContain("old-entry/");
  expect(next).toContain("a/\nb/");
});

test("unbalanced markers treat the file as operator-owned and append a fresh block", async () => {
  const existing = `dist/\n${PRETTIERIGNORE_BLOCK_BEGIN}\nstray/\n`; // no END marker
  const { next, changed } = reconcilePrettierignoreContent(existing, ["x/"]);
  expect(changed).toBe("updated");
  expect(next).toContain("dist/\n");
  // Original content preserved verbatim — forge does not merge into a
  // corrupted region; a fresh block is appended.
  expect(next.indexOf(PRETTIERIGNORE_BLOCK_BEGIN)).toBeLessThan(
    next.lastIndexOf(PRETTIERIGNORE_BLOCK_BEGIN),
  );
});

test("repeated apply is idempotent", async () => {
  await withPrettier(tmpDir);
  await writeFile(join(tmpDir, ".prettierignore"), "dist/\n");
  const plan = await planPrettierignore(tmpDir);
  const first = await applyPrettierignore(tmpDir, plan);
  expect(first).toBe("updated");
  const second = await applyPrettierignore(tmpDir, await planPrettierignore(tmpDir));
  expect(second, "second apply must be unchanged — check reconcile block boundaries").toBe(
    "unchanged",
  );
});
