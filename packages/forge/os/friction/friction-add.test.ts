import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

import type { ForgeRuntimeContext } from "../../src/types.ts";
import { gitExec, initRepo } from "../flow/tests/helpers.ts";
import { runFrictionAdd } from "./handlers/friction-add.ts";
import { FRICTION_DIR, loadFrictions } from "./store.ts";
import { ambientIo } from "../../src/utils/io.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friction-add-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function ctx(root: string): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    dryRun: false,
    outputFormat: "json",
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
  };
}

const VALID_FLAGS = {
  category: "tooling",
  signature: "gate ran twice on identical input",
  friction: "the integration gate re-ran a clean step",
  measure: "cache the gate verdict",
};

async function recordFiles(root: string): Promise<string[]> {
  const dir = path.join(root, FRICTION_DIR);
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith(".yaml"));
  } catch {
    return [];
  }
}

describe("friction.add — vocabulary gate (AC-3)", () => {
  test("a category outside the closed catalog refuses without writing a file", async () => {
    const result = await runFrictionAdd(
      { argv: [], flags: { ...VALID_FLAGS, category: "bogus" } },
      ctx(tmpDir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("FRICTION-02");
    expect(await recordFiles(tmpDir)).toEqual([]);
  });

  test("a measure-kind outside the catalog refuses without writing a file", async () => {
    const result = await runFrictionAdd(
      { argv: [], flags: { ...VALID_FLAGS, "measure-kind": "bogus" } },
      ctx(tmpDir),
    );
    expect(result.exitCode).toBe(1);
    expect(await recordFiles(tmpDir)).toEqual([]);
  });
});

describe("friction.add — write path", () => {
  test("valid input writes F-0001.yaml with the schema fields", async () => {
    const result = await runFrictionAdd(
      { argv: [], flags: { ...VALID_FLAGS, session: "s-1" } },
      ctx(tmpDir),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.id).toBe("F-0001");
    const [file] = await recordFiles(tmpDir);
    expect(file).toBe("F-0001.yaml");
    const rec = YAML.parse(
      await fs.readFile(path.join(tmpDir, FRICTION_DIR, "F-0001.yaml"), "utf8"),
    );
    expect(rec.id).toBe("F-0001");
    expect(rec.category).toBe("tooling");
    expect(rec.status).toBe("open");
    expect(rec.recurrences).toBe(0);
    expect(rec.session).toBe("s-1");
  });

  test("--recurrence-of increments the counter without a new id", async () => {
    await runFrictionAdd({ argv: [], flags: { ...VALID_FLAGS, session: "s-1" } }, ctx(tmpDir));
    const bump = await runFrictionAdd(
      { argv: [], flags: { "recurrence-of": "F-0001" } },
      ctx(tmpDir),
    );
    expect(bump.exitCode).toBe(0);
    expect(bump.data?.recurrences).toBe(1);
    const recs = await loadFrictions(tmpDir, ambientIo);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.recurrences).toBe(1);
  });
});

describe("friction.add — concurrent ids (AC-2)", () => {
  test("two worktrees of one repo allocate different ids", async () => {
    const primary = await initRepo({ prefix: "friction-add-", branch: "develop" });
    const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "friction-add-wt-")), "wt");
    const add = await gitExec(primary, ["worktree", "add", wt, "-b", "wt-branch"]);
    expect(add.exitCode).toBe(0);
    try {
      const [a, b] = await Promise.all([
        runFrictionAdd({ argv: [], flags: { ...VALID_FLAGS, session: "s-a" } }, ctx(primary)),
        runFrictionAdd({ argv: [], flags: { ...VALID_FLAGS, session: "s-b" } }, ctx(wt)),
      ]);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(a.data?.id).not.toBe(b.data?.id);
      expect(await recordFiles(primary)).toEqual([`${a.data?.id}.yaml`]);
      expect(await recordFiles(wt)).toEqual([`${b.data?.id}.yaml`]);
    } finally {
      await gitExec(primary, ["worktree", "remove", "--force", wt]);
      await fs.rm(primary, { recursive: true, force: true });
    }
  }, 30_000);
});
