/*
<MODULE_CONTRACT>
<purpose>resolveRepositoryLineVersion tests (RFC-1493 step 1): a tagged repo
line derives X.Y.Z+N.&lt;head9&gt; from the last annotated tag, an untagged
line falls back to the version-file value, and a lightweight tag is invisible
to the release line.</purpose>
<non-goals>
  <item>No flow.version report coverage — flow-version.test.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1493: step 1 — public reader tests on throwaway repositories</item>
  <item>RFC-1493: step 1 — forge public release-line version reader</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { resolveRepositoryLineVersion } from "../index.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeAndCommit(repo: string, file: string, content: string, message = "c"): Promise<void> {
  await mkdir(join(repo, file.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  const result = await gitExec(repo, ["commit", "-m", message]);
  if (result.exitCode !== 0) throw new Error(`commit failed: ${result.stderr}`);
}

async function annotatedTag(repo: string, name: string): Promise<void> {
  const result = await gitExec(repo, [
    "tag", "-a", name, "-m",
    `release ${name}\n\nschema: forge/release-tag@1\nline: repo\nversion: ${name.slice(1)}\nlevel: baseline\nprevious: null\nrfcs: []\nfingerprints: {}`,
  ]);
  if (result.exitCode !== 0) throw new Error(`tag ${name} failed: ${result.stderr}`);
}

async function repoWithRootVersion(version: string): Promise<string> {
  const repo = await initRepo({ prefix: "line-ver-" });
  dirs.push(repo);
  await writeAndCommit(repo, "package.json", `{ "version": "${version}" }\n`, `version ${version}`);
  return repo;
}

describe("resolveRepositoryLineVersion", () => {
  it("a tagged line two commits ahead derives X.Y.Z+2.<head9> with source release-tag", async () => {
    const repo = await repoWithRootVersion("1.0.0");
    await annotatedTag(repo, "v1.0.0");
    await writeAndCommit(repo, "a.txt", "a\n", "post 1");
    await writeAndCommit(repo, "b.txt", "b\n", "post 2");

    const resolved = await resolveRepositoryLineVersion(repo, ambientIo);
    const head = (await gitExec(repo, ["rev-parse", "--short=9", "HEAD"])).stdout.trim();
    expect(resolved.source).toBe("release-tag");
    expect(resolved.lastTag).toBe("v1.0.0");
    expect(resolved.version).toBe(`1.0.0+2.${head}`);
  });

  it("an untagged line resolves the version-file value with source version-file", async () => {
    const repo = await repoWithRootVersion("6.451.0");
    await writeAndCommit(repo, "x.txt", "x\n", "later");

    const resolved = await resolveRepositoryLineVersion(repo, ambientIo);
    expect(resolved.source).toBe("version-file");
    expect(resolved.lastTag).toBeNull();
    expect(resolved.version).toBe("6.451.0");
  });

  it("a lightweight tag is invisible — the line still resolves version-file", async () => {
    const repo = await repoWithRootVersion("2.3.4");
    const tag = await gitExec(repo, ["tag", "v2.3.4"]);
    if (tag.exitCode !== 0) throw new Error(`lightweight tag failed: ${tag.stderr}`);
    await writeAndCommit(repo, "y.txt", "y\n", "post");

    const resolved = await resolveRepositoryLineVersion(repo, ambientIo);
    expect(resolved.source).toBe("version-file");
    expect(resolved.lastTag).toBeNull();
    expect(resolved.version).toBe("2.3.4");
  });

  it("an untagged line without a version file throws", async () => {
    const repo = await initRepo({ prefix: "line-ver-" });
    dirs.push(repo);
    await writeAndCommit(repo, "only.txt", "x\n", "no package.json");

    await expect(resolveRepositoryLineVersion(repo, ambientIo)).rejects.toThrow(/package\.json/);
  });
});
