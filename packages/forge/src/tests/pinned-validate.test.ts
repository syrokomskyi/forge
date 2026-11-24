/*
<MODULE_CONTRACT>
<purpose>
Unit tests for pinned validate covering runPinnedValidate. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the pinned suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPinnedValidate } from "../../os/core/handlers/pinned-validate.ts";
import { isArchiveBlocked, loadPinnedManifest } from "../../os/core/handlers/pinned-check.ts";
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

  test("passes an intra-dir move reported as D+A (rename detection off)", async () => {
    const dir = await makeRepo();
    try {
      // A consumer's `diff.renames=false` (or a below-threshold similarity)
      // splits the move into D + A — same exemption as the R pair.
      await git(dir, ["config", "diff.renames", "false"]);
      await mkdir(join(dir, "docs", "rfcs", "archive", "implemented"), { recursive: true });
      await git(dir, ["mv", "docs/rfcs/rfc-0001.md", "docs/rfcs/archive/implemented/rfc-0001.md"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("pass");
      expect(result.data?.violations).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes an intra-dir move reported as D+M (destination already tracked)", async () => {
    const dir = await makeRepo();
    try {
      // docs/rfcs/archive/rfc-0001.md already exists in HEAD — git reports
      // `D docs/rfcs/rfc-0001.md` + `M docs/rfcs/archive/rfc-0001.md`, never R.
      await mkdir(join(dir, "docs", "rfcs", "archive"), { recursive: true });
      await writeFile(join(dir, "docs", "rfcs", "archive", "rfc-0001.md"), "# old\n");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "archive dir"]);
      await writeFile(join(dir, "docs", "rfcs", "archive", "rfc-0001.md"), "# RFC 1\n");
      await git(dir, ["rm", "docs/rfcs/rfc-0001.md"]);
      await git(dir, ["add", "-A"]);

      const result = await runPinnedValidate(makeInput(), makeContext(dir));
      expect(result.data?.status).toBe("pass");
      expect(result.data?.violations).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still flags a delete when the same-basename file lands outside the pinned dir", async () => {
    const dir = await makeRepo();
    try {
      await git(dir, ["config", "diff.renames", "false"]);
      await mkdir(join(dir, "docs", "other"), { recursive: true });
      await git(dir, ["mv", "docs/rfcs/rfc-0001.md", "docs/other/rfc-0001.md"]);

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

  test("still flags a bare delete with no same-basename counterpart", async () => {
    const dir = await makeRepo();
    try {
      await git(dir, ["config", "diff.renames", "false"]);
      // Delete + unrelated add under the same pinned dir — not a move.
      await git(dir, ["rm", "docs/rfcs/rfc-0001.md"]);
      await mkdir(join(dir, "docs", "rfcs"), { recursive: true });
      await writeFile(join(dir, "docs", "rfcs", "rfc-0002.md"), "# RFC 2\n");
      await git(dir, ["add", "-A"]);

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

describe("isArchiveBlocked (F-0004 archive opt-out)", () => {
  async function makeManifestRepo(entries: string): Promise<string> {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".forge"), { recursive: true });
    await writeFile(join(dir, ".forge", "pinned.yaml"), entries);
    return dir;
  }

  test("protect-pinned dir allows the intra-dir archive move (default contract)", async () => {
    const dir = await makeManifestRepo(
      "pinned:\n  - path: docs/rfcs/\n    mode: protect\n    reason: RFC directory\n",
    );
    try {
      const manifest = (await loadPinnedManifest(dir))!;
      expect(
        isArchiveBlocked(manifest, "docs/rfcs/rfc-1.md", "docs/rfcs/archive/rfc-1.md"),
      ).toBeNull();
      expect(
        isArchiveBlocked(manifest, "docs/rfcs/rfc-1.md", "docs/other/rfc-1.md"),
      )?.not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("archive: false blocks the intra-dir move entirely", async () => {
    const dir = await makeManifestRepo(
      "pinned:\n  - path: docs/rfcs/\n    mode: protect\n    reason: RFC directory\n    archive: false\n",
    );
    try {
      const manifest = (await loadPinnedManifest(dir))!;
      const blocked = isArchiveBlocked(
        manifest,
        "docs/rfcs/rfc-1.md",
        "docs/rfcs/archive/rfc-1.md",
      );
      expect(blocked).not.toBeNull();
      expect(blocked?.archive).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("freeze mode blocks the intra-dir move too", async () => {
    const dir = await makeManifestRepo(
      "pinned:\n  - path: docs/rfcs/\n    mode: freeze\n    reason: locked\n",
    );
    try {
      const manifest = (await loadPinnedManifest(dir))!;
      expect(
        isArchiveBlocked(manifest, "docs/rfcs/rfc-1.md", "docs/rfcs/archive/rfc-1.md"),
      ).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("non-pinned source is never blocked", async () => {
    const dir = await makeManifestRepo(
      "pinned:\n  - path: docs/rfcs/\n    mode: protect\n    reason: RFC directory\n    archive: false\n",
    );
    try {
      const manifest = (await loadPinnedManifest(dir))!;
      expect(isArchiveBlocked(manifest, "docs/other/x.md", "docs/rfcs/x.md")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-boolean archive value is malformed", async () => {
    const dir = await makeManifestRepo(
      "pinned:\n  - path: docs/rfcs/\n    mode: protect\n    reason: RFC directory\n    archive: never\n",
    );
    try {
      await expect(loadPinnedManifest(dir)).rejects.toThrow(/invalid archive/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session.archive with archive:false entries (F-0004)", () => {
  const SESSION_FM = (date: string) =>
    `---\nid: s-1\ndate: ${date}\ntype: session\n---\n\n# session\n`;

  test("docs.archive family skips files under archive:false dirs entirely", async () => {
    const { runSessionArchive } = await import("../../os/session/handlers/archive.ts");
    const dir = await makeTempDir();
    await mkdir(join(dir, ".forge"), { recursive: true });
    await writeFile(
      join(dir, ".forge", "pinned.yaml"),
      "pinned:\n  - path: docs/sessions/\n    mode: protect\n    reason: Session directory\n    archive: false\n",
    );
    await mkdir(join(dir, "docs", "sessions"), { recursive: true });
    await writeFile(
      join(dir, "docs", "sessions", "2020-01-01-00-00-00-aaaaaa.md"),
      SESSION_FM("2020-01-01"),
    );
    try {
      const result = await runSessionArchive(
        { argv: [], flags: { "max-age-days": "7" } },
        makeContext(dir),
      );
      expect(result.data?.moved).toHaveLength(0);
      expect(result.data?.skipped.some((s) => s.reason?.includes("pinned"))).toBe(true);
      // File stays in place — nothing was moved.
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(dir, "docs", "sessions", "2020-01-01-00-00-00-aaaaaa.md"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
