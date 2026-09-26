/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-1154 skill markers: .forge-managed manifests
recorded on sync, and the stale-dir prune under the subset-of-manifest rule
(keeps dirs with consumer files or corrupt markers, never touches unmarked
dirs).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial marker + prune tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_MARKER_FILE,
  writeSkillMarker,
  writeSkillMarkerSync,
  pruneStaleSkillDirs,
} from "../onboarding/skill-markers.ts";

let tmpDir: string;
let skillsDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "skill-marker-"));
  skillsDir = join(tmpDir, ".agents", "skills");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function makeSkillDir(name: string, files: string[]): Promise<void> {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const filePath = join(dir, f);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, `content of ${f}\n`);
  }
}

test("AC-7: writeSkillMarker records the exact file list", async () => {
  const dir = join(skillsDir, "fo-idea");
  await mkdir(dir, { recursive: true });
  await writeSkillMarker(dir, ["SKILL.md", "qa-log.md"]);
  const raw = await readFile(join(dir, SKILL_MARKER_FILE), "utf8");
  expect(JSON.parse(raw)).toEqual({ files: ["SKILL.md", "qa-log.md"] });
});

test("marker write is idempotent (identical content on repeat)", async () => {
  const dir = join(skillsDir, "fo-idea");
  await mkdir(dir, { recursive: true });
  writeSkillMarkerSync(dir, ["b.md", "a.md"]);
  const first = await readFile(join(dir, SKILL_MARKER_FILE), "utf8");
  writeSkillMarkerSync(dir, ["b.md", "a.md"]);
  expect(await readFile(join(dir, SKILL_MARKER_FILE), "utf8")).toBe(first);
  expect(JSON.parse(first).files).toEqual(["a.md", "b.md"]); // sorted, deterministic
});

test("AC-8: prunes a stale marked dir whose contents match the manifest", async () => {
  const dir = join(skillsDir, "old-skill");
  await makeSkillDir("old-skill", ["SKILL.md"]);
  await writeSkillMarker(dir, ["SKILL.md"]);

  const result = await pruneStaleSkillDirs(skillsDir, new Set(["other-skill"]));
  expect(result.pruned).toEqual(["old-skill"]);
  expect(result.keptWithConsumerFiles).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test("AC-8: keeps a stale marked dir containing consumer files", async () => {
  const dir = join(skillsDir, "old-skill");
  await makeSkillDir("old-skill", ["SKILL.md", "my-notes.md"]);
  await writeSkillMarker(dir, ["SKILL.md"]);

  const result = await pruneStaleSkillDirs(skillsDir, new Set([]));
  expect(result.pruned).toEqual([]);
  expect(result.keptWithConsumerFiles).toHaveLength(1);
  expect(result.keptWithConsumerFiles[0]).toContain("old-skill");
  expect(result.keptWithConsumerFiles[0]).toContain("my-notes.md");
  expect(existsSync(dir)).toBe(true);
});

test("AC-9: unmarked dirs are never pruned", async () => {
  const dir = join(skillsDir, "consumer-skill");
  await makeSkillDir("consumer-skill", ["SKILL.md"]);

  const result = await pruneStaleSkillDirs(skillsDir, new Set([]));
  expect(result.pruned).toEqual([]);
  expect(result.keptWithConsumerFiles).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});

test("dirs still in the sync set are kept regardless of marker", async () => {
  const dir = join(skillsDir, "current-skill");
  await makeSkillDir("current-skill", ["SKILL.md"]);
  await writeSkillMarker(dir, ["SKILL.md"]);

  const result = await pruneStaleSkillDirs(skillsDir, new Set(["current-skill"]));
  expect(result.pruned).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});

test("corrupt marker disables prune for that dir (fail-safe keep)", async () => {
  const dir = join(skillsDir, "broken-skill");
  await makeSkillDir("broken-skill", ["SKILL.md"]);
  await writeFile(join(dir, SKILL_MARKER_FILE), "not json {{{");

  const result = await pruneStaleSkillDirs(skillsDir, new Set([]));
  expect(result.pruned).toEqual([]);
  expect(result.keptWithConsumerFiles).toHaveLength(1);
  expect(result.keptWithConsumerFiles[0]).toContain("corrupt marker");
  expect(existsSync(dir)).toBe(true);
});

test("nested manifest files are matched recursively", async () => {
  const dir = join(skillsDir, "nested-skill");
  await makeSkillDir("nested-skill", ["SKILL.md", "knowledge/notes.md"]);
  await writeSkillMarker(dir, ["SKILL.md", "knowledge/notes.md"]);

  const result = await pruneStaleSkillDirs(skillsDir, new Set([]));
  expect(result.pruned).toEqual(["nested-skill"]);
  expect(existsSync(dir)).toBe(false);
});

test("missing skills dir returns empty result", async () => {
  const result = await pruneStaleSkillDirs(join(tmpDir, "nonexistent"), new Set());
  expect(result).toEqual({ pruned: [], keptWithConsumerFiles: [] });
});
