/*
<MODULE_CONTRACT>
<purpose>RFC-1619 AC-1 — regenerateAfterRebase writes a
  forge/post-rebase-regen@1 provenance record on every successful return:
  base + post-regen tip + blob sha per owned generated path, at
  &lt;commonGitDir&gt;/forge/regen-records/&lt;branch&gt;.json. Drift-commit
  and no-drift exits both record; a missing baseSha (port/manual callers)
  writes nothing.</purpose>
<non-goals>
  <item>No gate binding — the consumer side is covered in
    werkstatt-site/src/checks/tests/worktree-gate-regen-binding.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: requirement AC-1 (RFC-1619)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ambientIo } from "../../../src/utils/io.ts";
import type { ForgeInvokeCommand } from "../../../src/types.ts";
import {
  regenerateAfterRebase,
  regenRecordFileName,
  type PostRebaseRegenRecord,
} from "../post-rebase-regen.ts";
import { gitExec, initRepo } from "./helpers.ts";

const MANIFEST = "docs/ecosystem.generated.yaml";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWithManifest(): Promise<string> {
  const dir = await initRepo({ prefix: "regen-record-" });
  dirs.push(dir);
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, MANIFEST), "contentHash: old\n");
  await gitExec(dir, ["add", MANIFEST]);
  await gitExec(dir, ["commit", "-m", "manifest"]);
  return dir;
}

function stubInvoke(worktree: string, content?: string): ForgeInvokeCommand {
  return async (name) => {
    if (name === "ecosystem.manifest.generate" && content !== undefined) {
      await writeFile(join(worktree, MANIFEST), content);
    }
    return { ok: true, exitCode: 0 };
  };
}

async function readRecord(dir: string, branch: string): Promise<PostRebaseRegenRecord> {
  const recordPath = join(dir, ".git", "forge", "regen-records", regenRecordFileName(branch));
  return JSON.parse(await readFile(recordPath, "utf8")) as PostRebaseRegenRecord;
}

const owners = [{ path: MANIFEST, command: "ecosystem.manifest.generate" }];

describe("regenerateAfterRebase provenance record (RFC-1619)", () => {
  it("AC-1: a drift-committing regen records base, new tip, and the output blob sha", async () => {
    const dir = await repoWithManifest();
    const baseSha = (await gitExec(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const regen = await regenerateAfterRebase({
      branchWorktree: dir,
      io: ambientIo,
      invoke: stubInvoke(dir, "contentHash: new\n"),
      owners,
      baseSha,
    });
    if ("refused" in regen) throw new Error(`unexpected refusal: ${regen.message}`);
    expect(regen.committed).toEqual([MANIFEST]);
    const rec = await readRecord(dir, "main");
    expect(rec.schema).toBe("forge/post-rebase-regen@1");
    expect(rec.baseSha).toBe(baseSha);
    // tip moved past the regen commit
    expect(rec.branchTip).toBe((await gitExec(dir, ["rev-parse", "HEAD"])).stdout.trim());
    expect(rec.branchTip).not.toBe(baseSha);
    expect(rec.outputs[MANIFEST]).toBe(
      (await gitExec(dir, ["hash-object", "--", MANIFEST])).stdout.trim(),
    );
  }, 30_000);

  it("AC-1: a no-drift regen still records — the file is regen output even when unchanged", async () => {
    const dir = await repoWithManifest();
    const baseSha = (await gitExec(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const regen = await regenerateAfterRebase({
      branchWorktree: dir,
      io: ambientIo,
      invoke: stubInvoke(dir), // generator rewrites nothing
      owners,
      baseSha,
    });
    if ("refused" in regen) throw new Error(`unexpected refusal: ${regen.message}`);
    expect(regen.committed).toEqual([]);
    const rec = await readRecord(dir, "main");
    expect(rec.branchTip).toBe(baseSha);
    expect(rec.outputs[MANIFEST]).toBe(
      (await gitExec(dir, ["hash-object", "--", MANIFEST])).stdout.trim(),
    );
  }, 30_000);

  it("AC-1: without baseSha no record is written (port/manual regen callers)", async () => {
    const dir = await repoWithManifest();
    const regen = await regenerateAfterRebase({
      branchWorktree: dir,
      io: ambientIo,
      invoke: stubInvoke(dir, "contentHash: new\n"),
      owners,
    });
    if ("refused" in regen) throw new Error(`unexpected refusal: ${regen.message}`);
    const recordDir = join(dir, ".git", "forge", "regen-records");
    expect(await ambientIo.exists(recordDir)).toBe(false);
  }, 30_000);

  it("AC-1: the record names the branch it was written under", async () => {
    const dir = await repoWithManifest();
    await gitExec(dir, ["switch", "-c", "auto/session-260101-01-rec"]);
    const baseSha = (await gitExec(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const regen = await regenerateAfterRebase({
      branchWorktree: dir,
      io: ambientIo,
      invoke: stubInvoke(dir, "contentHash: new\n"),
      owners,
      baseSha,
    });
    if ("refused" in regen) throw new Error(`unexpected refusal: ${regen.message}`);
    const rec = await readRecord(dir, "auto/session-260101-01-rec");
    expect(rec.schema).toBe("forge/post-rebase-regen@1");
  }, 30_000);
});
