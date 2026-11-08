/*
<MODULE_CONTRACT>
<purpose>Release-line discovery tests (RFC-1488, AC-2 foundation): temp
workspaces exercise the pnpm-workspace glob expansion, the
`extract.config.yaml` publishability marker, negated globs and the
FLOW-VER-02 basename collision; a read-only pass over the real werkstatt
root pins the expected line set.</purpose>
<non-goals>
  <item>No tag or version math — release-tags/release-level tests own those.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 1 — release-lines discovery tests</item>
  <item>RFC-1488: step 1 — semver helper + release-line discovery (extract.config.yaml workspace globs)</item>
  <item>RFC-1540: count the intake-validator release line in the werkstatt root discovery test</item>
</CHANGE_SUMMARY>
*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { discoverReleaseLines } from "../release-lines.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flow-lines-"));
  dirs.push(dir);
  return dir;
}

async function touch(repo: string, rel: string, content = ""): Promise<void> {
  await mkdir(join(repo, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(join(repo, rel), content);
}

describe("discoverReleaseLines", () => {
  it("reports the repo line plus every extract.config.yaml workspace dir", async () => {
    const repo = await tempRepo();
    await touch(repo, "package.json", '{ "version": "1.0.0" }\n');
    await touch(
      repo,
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*'\n  - 'missions/*/workpiece'\n",
    );
    await touch(repo, "packages/forge/package.json", '{ "version": "9.0.0" }\n');
    await touch(repo, "packages/forge/extract.config.yaml", "forgePlugin: true\n");
    await touch(repo, "packages/pbp/package.json", '{ "version": "2.1.0" }\n');
    await touch(repo, "packages/pbp/extract.config.yaml", "forgePlugin: false\n");
    await touch(repo, "packages/no-extract/package.json", '{ "version": "0.0.1" }\n');
    await touch(repo, "missions/m1/workpiece/src/index.ts", "// workpiece\n");

    const { lines, diagnostics } = await discoverReleaseLines(repo, ambientIo);
    expect(diagnostics).toEqual([]);
    expect(lines.map((l) => l.id).sort()).toEqual(["forge", "pbp", "repo"]);
    const forge = lines.find((l) => l.id === "forge");
    expect(forge).toMatchObject({
      tagPrefix: "forge@",
      versionFile: "packages/forge/package.json",
      paths: ["packages/forge"],
    });
    const repoLine = lines.find((l) => l.id === "repo");
    expect(repoLine).toMatchObject({ tagPrefix: "v", versionFile: "package.json", paths: [] });
  });

  it("reports a null versionFile when the repo has no root package.json", async () => {
    const repo = await tempRepo();
    const { lines } = await discoverReleaseLines(repo, ambientIo);
    expect(lines).toEqual([
      { id: "repo", tagPrefix: "v", versionFile: null, paths: [] },
    ]);
  });

  it("skips negated glob matches and node_modules", async () => {
    const repo = await tempRepo();
    await touch(repo, "package.json", '{ "version": "1.0.0" }\n');
    await touch(
      repo,
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*'\n  - '!packages/internal'\n",
    );
    await touch(repo, "packages/internal/extract.config.yaml", "forgePlugin: false\n");
    await touch(repo, "packages/forge/extract.config.yaml", "forgePlugin: true\n");
    await touch(repo, "packages/node_modules/x/extract.config.yaml", "x: 1\n");

    const { lines, diagnostics } = await discoverReleaseLines(repo, ambientIo);
    expect(diagnostics).toEqual([]);
    expect(lines.map((l) => l.id).sort()).toEqual(["forge", "repo"]);
  });

  it("refuses colliding basenames with FLOW-VER-02 naming both dirs", async () => {
    const repo = await tempRepo();
    await touch(repo, "package.json", '{ "version": "1.0.0" }\n');
    await touch(
      repo,
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*/x'\n  - 'services/*'\n",
    );
    await touch(repo, "packages/a/x/extract.config.yaml", "forgePlugin: false\n");
    await touch(repo, "services/x/extract.config.yaml", "forgePlugin: false\n");
    await touch(repo, "services/keep/extract.config.yaml", "forgePlugin: false\n");

    const { lines, diagnostics } = await discoverReleaseLines(repo, ambientIo);
    const collision = diagnostics.filter((d) => d.ruleId === "FLOW-VER-02");
    expect(collision).toHaveLength(1);
    expect(collision[0]?.severity).toBe("error");
    expect(collision[0]?.message).toContain("x");
    expect(collision[0]?.message).toContain("packages/a/x");
    expect(collision[0]?.message).toContain("services/x");
    // The non-colliding line still lands; the collided id is absent.
    expect(lines.map((l) => l.id).sort()).toEqual(["keep", "repo"]);
  });

  it("the real werkstatt root discovers repo plus its published package lines", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const { lines, diagnostics } = await discoverReleaseLines(root, ambientIo);
    expect(diagnostics.filter((d) => d.ruleId === "FLOW-VER-02")).toEqual([]);
    const ids = lines.map((l) => l.id);
    // RFC-1540 added the intake-validator extract line (16 → 17).
    expect(ids).toHaveLength(17);
    expect(ids).toContain("repo");
    expect(ids).toContain("intake-validator");
    expect(ids).toContain("forge");
    expect(ids).toContain("werkstatt-engine");
  });
});
