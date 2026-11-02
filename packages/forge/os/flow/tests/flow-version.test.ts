/*
<MODULE_CONTRACT>
<purpose>flow.version behavior tests (RFC-1488: AC-1, AC-2, AC-4 plus
FLOW-VER-01/04): annotated baseline tags in throwaway repos anchor the
derived version `X.Y.Z+N.&lt;head9&gt;`, per-line path filtering counts
commits correctly, a clean line at its tag reports `none`, and the
diagnostics surface reports missing baselines and unknown --line ids.</purpose>
<non-goals>
  <item>No level math — flow-version-level.test.ts owns AC-3.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 4 — flow.version tests</item>
  <item>RFC-1488: steps 2-4 — release tags, pending level (X-RFC + versionBump), flow.version command</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectFlowVersion } from "../handlers/flow-version.ts";
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

async function annotatedTag(repo: string, name: string, at?: string): Promise<void> {
  const args = ["tag", "-a", name, "-m", `release ${name}\n\nschema: forge/release-tag@1\nline: repo\nversion: ${name.replace(/^v|^[^@]*@/, "")}\nlevel: baseline\nprevious: null\nrfcs: []\nfingerprints: {}`];
  if (at !== undefined) args.push(at);
  const result = await gitExec(repo, args);
  if (result.exitCode !== 0) throw new Error(`tag ${name} failed: ${result.stderr}`);
}

async function repoWithRootVersion(version: string): Promise<string> {
  const repo = await initRepo({ prefix: "flow-ver-" });
  dirs.push(repo);
  await writeAndCommit(repo, "package.json", `{ "version": "${version}" }\n`, `version ${version}`);
  return repo;
}

describe("collectFlowVersion", () => {
  it("AC-1: HEAD three commits after v1.2.0 reports derived 1.2.0+3.<head9>", async () => {
    const repo = await repoWithRootVersion("1.2.0");
    await annotatedTag(repo, "v1.2.0");
    for (let i = 0; i < 3; i += 1) {
      await writeAndCommit(repo, `file-${i}.txt`, `${i}\n`, `post ${i}`);
    }

    const { data, diagnostics } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const line = data.lines[0];
    expect(line?.id).toBe("repo");
    expect(line?.lastTag).toBe("v1.2.0");
    expect(line?.lastVersion).toBe("1.2.0");
    expect(line?.commitsSince).toBe(3);
    expect(line?.dirty).toBe(false);
    expect(line?.derived).toBe(`1.2.0+3.${line.head}`);
    expect(line?.head).toHaveLength(9);
  });

  it("AC-2: only commits under the package line's paths count toward commitsSince", async () => {
    const repo = await repoWithRootVersion("1.0.0");
    await mkdir(join(repo, "packages/forge"), { recursive: true });
    await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writeFile(join(repo, "packages/forge/package.json"), '{ "version": "9.0.0" }\n');
    await writeFile(join(repo, "packages/forge/extract.config.yaml"), "forgePlugin: true\n");
    await writeAndCommit(repo, "x.txt", "x\n", "workspace");
    await annotatedTag(repo, "forge@9.0.0");

    for (let i = 0; i < 5; i += 1) {
      if (i < 2) {
        await writeAndCommit(repo, `packages/forge/f${i}.ts`, `${i}\n`, `forge ${i}`);
      } else {
        await writeAndCommit(repo, `root-${i}.txt`, `${i}\n`, `root ${i}`);
      }
    }

    const { data } = await collectFlowVersion(repo, ambientIo, "forge");
    const line = data.lines[0];
    expect(line?.id).toBe("forge");
    expect(line?.lastTag).toBe("forge@9.0.0");
    expect(line?.commitsSince).toBe(2);
    expect(line?.derived).toBe(`9.0.0+2.${line.head}`);
  });

  it("AC-4: a line with no commits since its tag reports none and the tag version", async () => {
    const repo = await repoWithRootVersion("1.2.0");
    await annotatedTag(repo, "v1.2.0");

    const { data } = await collectFlowVersion(repo, ambientIo, "repo");
    const line = data.lines[0];
    expect(line?.commitsSince).toBe(0);
    expect(line?.level).toBe("none");
    expect(line?.derived).toBe("1.2.0");
    expect(line?.nextVersion).toBeNull();
  });

  it("untagged line reports derived null and FLOW-VER-01 pointing at flow.install", async () => {
    const repo = await repoWithRootVersion("1.0.0");
    const { data, diagnostics } = await collectFlowVersion(repo, ambientIo, "repo");
    const line = data.lines[0];
    expect(line?.derived).toBeNull();
    expect(line?.lastTag).toBeNull();
    expect(line?.level).toBe("patch"); // commits exist on the line, nothing tagged yet
    const ver01 = diagnostics.filter((d) => d.ruleId === "FLOW-VER-01");
    expect(ver01).toHaveLength(1);
    expect(ver01[0]?.message).toContain("flow.install");
  });

  it("unknown --line id fails with FLOW-VER-04 listing known lines", async () => {
    const repo = await repoWithRootVersion("1.0.0");
    const { data, diagnostics } = await collectFlowVersion(repo, ambientIo, "nope");
    expect(data.lines).toEqual([]);
    const ver04 = diagnostics.filter((d) => d.ruleId === "FLOW-VER-04");
    expect(ver04).toHaveLength(1);
    expect(ver04[0]?.severity).toBe("error");
    expect(ver04[0]?.message).toContain("repo");
  });

  it("tracked modification inside the line's paths marks the line dirty", async () => {
    const repo = await repoWithRootVersion("1.2.0");
    await annotatedTag(repo, "v1.2.0");
    await writeFile(join(repo, "package.json"), '{ "version": "1.2.0" } // dirty\n');

    const { data } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(data.lines[0]?.dirty).toBe(true);
    expect(data.lines[0]?.derived).toBe("1.2.0.dirty");
  });

  it("lightweight tags never anchor a line", async () => {
    const repo = await repoWithRootVersion("1.2.0");
    const lw = await gitExec(repo, ["tag", "v0.9.0"]);
    if (lw.exitCode !== 0) throw new Error(lw.stderr);
    await annotatedTag(repo, "v1.2.0");

    const { data } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(data.lines[0]?.lastTag).toBe("v1.2.0");
  });
});
