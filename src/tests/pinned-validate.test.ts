import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPinnedValidate } from "../../os/core/handlers/pinned-validate.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-pinned-validate-test-"));
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

function makeInput(): ForgeCommandInput {
  return { argv: [], flags: {} };
}

async function git(dir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

/**
 * Scaffold a git repo with a committed pinned.yaml protecting docs/rfcs/
 * and one committed RFC file. Returns the repo dir.
 */
async function makeRepo(): Promise<string> {
  const dir = await makeTempDir();
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await mkdir(join(dir, ".forge"), { recursive: true });
  await writeFile(
    join(dir, ".forge", "pinned.yaml"),
    "pinned:\n  - path: docs/rfcs/\n    mode: protect\n    reason: RFC directory\n",
  );
  await mkdir(join(dir, "docs", "rfcs"), { recursive: true });
  await writeFile(join(dir, "docs", "rfcs", "rfc-0001.md"), "# RFC 1\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("runPinnedValidate", () => {
  test("passes for intra-directory move inside a pinned dir (docs.archive)", async () => {
    const dir = await makeRepo();
    try {
      // Simulate docs.archive: docs/rfcs/rfc-0001.md → docs/rfcs/archive/implemented/rfc-0001.md
      await mkdir(join(dir, "docs", "rfcs", "archive", "implemented"), { recursive: true });
      await git(dir, ["mv", "docs/rfcs/rfc-0001.md", "docs/rfcs/archive/implemented/rfc-0001.md"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("pass");
      expect(result.data?.violations).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags move out of a pinned dir", async () => {
    const dir = await makeRepo();
    try {
      await mkdir(join(dir, "docs", "other"), { recursive: true });
      await git(dir, ["mv", "docs/rfcs/rfc-0001.md", "docs/other/rfc-0001.md"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("fail");
      expect(result.data?.violations.length).toBeGreaterThan(0);
      expect(
        result.data?.violations.some(
          (v) => v.path === "docs/rfcs/rfc-0001.md" && v.operation === "move",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags move into a pinned dir", async () => {
    const dir = await makeRepo();
    try {
      // Source must be committed first — otherwise git records the staged
      // result as A (add), not R (rename).
      await writeFile(join(dir, "incoming.md"), "# incoming\n");
      await git(dir, ["add", "incoming.md"]);
      await git(dir, ["commit", "-m", "add incoming"]);
      await git(dir, ["mv", "incoming.md", "docs/rfcs/incoming.md"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("fail");
      expect(
        result.data?.violations.some(
          (v) => v.path === "docs/rfcs/incoming.md" && v.operation === "move",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags delete of a pinned file", async () => {
    const dir = await makeRepo();
    try {
      await git(dir, ["rm", "docs/rfcs/rfc-0001.md"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("fail");
      expect(
        result.data?.violations.some(
          (v) => v.path === "docs/rfcs/rfc-0001.md" && v.operation === "delete",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
