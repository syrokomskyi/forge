import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPinnedInit, DEFAULT_PINNED_ENTRIES } from "../../os/core/handlers/pinned-init.ts";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeFlagValue } from "../../src/types.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-pinned-init-test-"));
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

function makeInput(flags: Record<string, ForgeFlagValue> = {}): ForgeCommandInput {
  return { argv: [], flags };
}

describe("runPinnedInit", () => {
  test("creates manifest with default entries", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runPinnedInit(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("ok");
      expect(result.data?.manifestAction).toBe("created");
      expect(result.data?.entriesCount).toBe(DEFAULT_PINNED_ENTRIES.length);

      const manifestExists = existsSync(join(dir, ".forge", "pinned.yaml"));
      expect(manifestExists).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates .gitignore with audit log entry", async () => {
    const dir = await makeTempDir();
    try {
      await runPinnedInit(makeInput(), makeContext(dir));
      const gitignoreContent = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gitignoreContent).toContain(".forge/pinned-audit.log");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends audit log to existing .gitignore", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "node_modules/\ndist/\n");
      await runPinnedInit(makeInput(), makeContext(dir));
      const gitignoreContent = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gitignoreContent).toContain("node_modules/");
      expect(gitignoreContent).toContain(".forge/pinned-audit.log");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not duplicate audit log entry on re-run", async () => {
    const dir = await makeTempDir();
    try {
      await runPinnedInit(makeInput(), makeContext(dir));
      await runPinnedInit(makeInput(), makeContext(dir));
      const gitignoreContent = await readFile(join(dir, ".gitignore"), "utf8");
      const matches = gitignoreContent.match(/\.forge\/pinned-audit\.log/g);
      expect(matches).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges defaults with existing manifest entries", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".forge"), { recursive: true });
      await writeFile(
        join(dir, ".forge", "pinned.yaml"),
        "pinned:\n  - path: custom-file.md\n    mode: protect\n    reason: custom entry\n",
      );

      const result = await runPinnedInit(makeInput(), makeContext(dir));
      expect(result.data?.manifestAction).toBe("merged");
      expect(result.data?.entriesCount).toBe(DEFAULT_PINNED_ENTRIES.length + 1);

      const content = await readFile(join(dir, ".forge", "pinned.yaml"), "utf8");
      expect(content).toContain("custom-file.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips CI workflow when --ci not passed", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runPinnedInit(makeInput(), makeContext(dir));
      expect(result.data?.ciWorkflowAction).toBe("skipped");
      expect(existsSync(join(dir, ".github", "workflows", "pinned-check.yml"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates CI workflow when --ci passed", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runPinnedInit(makeInput({ ci: true }), makeContext(dir));
      expect(result.data?.ciWorkflowAction).toBe("created");
      expect(existsSync(join(dir, ".github", "workflows", "pinned-check.yml"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
