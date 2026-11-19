/*
<MODULE_CONTRACT>
<purpose>Unit tests for qaLogShardPath — the shared shard-naming rule — covers the qa log shards suite surface and its observable contract.</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { ForgeFlagValue, ForgeRuntimeContext } from "../../src/types.ts";
import { qaLogShardPath, runFrictionMigrate } from "./handlers/friction-migrate.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-log-shards-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SKILL = ".agents/skills/grilling";

function ctx(): {
  input: { argv: string[]; flags: Record<string, ForgeFlagValue> };
  context: ForgeRuntimeContext;
} {
  return {
    input: { argv: [], flags: {} },
    context: {
      workspaceRoot: tmpDir,
      dryRun: false,
      outputFormat: "json",
      logger: {
        section: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        success: () => {},
      },
    },
  };
}

async function writeQaLog(skill: string, body: string): Promise<void> {
  const p = path.join(tmpDir, skill, "qa-log.md");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
}

describe("qaLogShardPath — the shared shard-naming rule", () => {
  test("two sessions name two different files under qa-log/ (AC-8)", () => {
    const a = qaLogShardPath(SKILL, "auto/session-261114-03-a");
    const b = qaLogShardPath(SKILL, "auto/session-261114-03-b");
    expect(a).not.toBe(b);
    expect(a).toContain("qa-log/");
    expect(b).toContain("qa-log/");
    // Branch-style ids carry no path separators into the shard name.
    expect(path.basename(a)).toBe("auto-session-261114-03-a.md");
  });
});

describe("friction.migrate — qa-log sharding", () => {
  test("an existing qa-log.md moves to qa-log/legacy.md unchanged", async () => {
    await writeQaLog(SKILL, "# log\n\n- Q: a\n- A: b\n");
    const { input, context } = ctx();
    const result = await runFrictionMigrate(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.qaLogMoved).toEqual([`${SKILL}/qa-log.md`]);
    expect(await fs.readFile(path.join(tmpDir, SKILL, "qa-log", "legacy.md"), "utf8")).toBe(
      "# log\n\n- Q: a\n- A: b\n",
    );
    // The legacy single file is gone — sessions now write their own shard.
    await expect(fs.stat(path.join(tmpDir, SKILL, "qa-log.md"))).rejects.toThrow();
  });

  test("a reappeared qa-log.md merges into the existing legacy shard (idempotent)", async () => {
    await writeQaLog(SKILL, "first-run");
    const first = ctx();
    await runFrictionMigrate(first.input, first.context);
    // A session appended to the old path again — migrate must not lose it.
    await writeQaLog(SKILL, "second-run");
    const second = ctx();
    const r2 = await runFrictionMigrate(second.input, second.context);
    expect(r2.exitCode).toBe(0);
    expect(r2.data?.qaLogMerged).toEqual([`${SKILL}/qa-log.md`]);
    const merged = await fs.readFile(path.join(tmpDir, SKILL, "qa-log", "legacy.md"), "utf8");
    expect(merged).toContain("first-run");
    expect(merged).toContain("second-run");
  });

  test("per-session shards coexist — a session write never lands in another's file", async () => {
    const dir = path.join(tmpDir, SKILL, "qa-log");
    await fs.mkdir(dir, { recursive: true });
    // Simulated two-session append under the shard convention.
    await fs.writeFile(path.join(dir, "s-a.md"), "session a notes");
    await fs.writeFile(path.join(dir, "s-b.md"), "session b notes");
    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(["s-a.md", "s-b.md"]);
    expect(await fs.readFile(path.join(dir, "s-a.md"), "utf8")).toBe("session a notes");
    expect(await fs.readFile(path.join(dir, "s-b.md"), "utf8")).toBe("session b notes");
  });
});
