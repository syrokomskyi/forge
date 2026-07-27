import { test, expect, describe } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeFlagValue } from "../../src/types.ts";
import { runSessionSave } from "../../os/session/handlers/save.ts";
import { runSessionArchive } from "../../os/session/handlers/archive.ts";
import { runSessionValidate } from "../../os/session/handlers/validate.ts";
import type {
  SessionSaveResult,
  SessionArchiveResult,
  SessionValidationResult,
} from "../../os/session/types.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-session-pbt-"));
}

function makeInput(
  flags: Record<string, ForgeFlagValue> = {},
  args: string[] = [],
): ForgeCommandInput {
  return { argv: [], args, flags };
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      section: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

describe("PBT: session.save idempotency", () => {
  test("calling session.save twice on the same raw file yields the same .md id", async () => {
    await fc.asyncProperty(
      fc.string({ minLength: 10, maxLength: 1000 }).filter((s) => s.trim().length > 0),
      async (rawContent: string) => {
        const dir = await makeTempDir();
        try {
          await mkdir(join(dir, "docs/sessions/.raw"), { recursive: true });
          const rawPath = join(dir, "docs/sessions/.raw", "test.atif");
          await writeFile(rawPath, rawContent, "utf-8");

          const result1 = await runSessionSave(makeInput({ "keep-raw": true }), makeContext(dir));
          const data1 = result1.data as SessionSaveResult;
          expect(data1.id).toBeDefined();
          expect(data1.id.length).toBeGreaterThan(0);

          const result2 = await runSessionSave(makeInput({ "keep-raw": true }), makeContext(dir));
          const data2 = result2.data as SessionSaveResult & { skipped: unknown[] };

          expect(data2.skipped.length).toBeGreaterThan(0);
          expect(data2.skipped[0]).toHaveProperty("reason", "already converted");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  }, 60000);
});

describe("PBT: session.archive bidirectional behavior", () => {
  test("archive then unarchive returns file to original state", async () => {
    await fc.asyncProperty(fc.integer({ min: 1, max: 30 }), async (ageDays: number) => {
      const dir = await makeTempDir();
      try {
        await mkdir(join(dir, "docs/sessions/archive"), { recursive: true });

        const sessionId = "2026-07-01-12-00-00-pbt001";
        const sessionDate = new Date();
        sessionDate.setDate(sessionDate.getDate() - ageDays);
        const content = `---
id: ${sessionId}
date: "${sessionDate.toISOString()}"
types: [freeform]
summary: "PBT test"
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${sessionId}

## Transcript

Content.
`;
        await writeFile(join(dir, "docs/sessions", `${sessionId}.md`), content, "utf-8");

        if (ageDays > 7) {
          const archResult = await runSessionArchive(
            makeInput({ "max-age-days": "7" }),
            makeContext(dir),
          );
          const archData = archResult.data as SessionArchiveResult;
          expect(archData.moved.find((m) => m.id === sessionId)).toBeDefined();

          const unarchResult = await runSessionArchive(
            makeInput({ "max-age-days": "30" }),
            makeContext(dir),
          );
          const unarchData = unarchResult.data as SessionArchiveResult;
          expect(
            unarchData.moved.find((m) => m.id === sessionId && m.direction === "out-of-archive"),
          ).toBeDefined();

          await expect(
            access(join(dir, "docs/sessions", `${sessionId}.md`)),
          ).resolves.toBeUndefined();
        } else {
          const archResult = await runSessionArchive(
            makeInput({ "max-age-days": "7" }),
            makeContext(dir),
          );
          const archData = archResult.data as SessionArchiveResult;
          expect(archData.moved.find((m) => m.id === sessionId)).toBeUndefined();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }, 60000);
});

describe("Integration: end-to-end flow", () => {
  test("raw file → session.save → .md → session.validate → session.archive", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "docs/sessions/.raw"), { recursive: true });
      await mkdir(join(dir, "docs/sessions/archive"), { recursive: true });
      await mkdir(join(dir, "docs/rfcs"), { recursive: true });

      const rfcContent = `---
id: RFC-0537
title: Test
status: accepted
---

# RFC-0537
`;
      await writeFile(join(dir, "docs/rfcs", "rfc-0537-test.md"), rfcContent, "utf-8");

      const rawContent = `2026-01-01T12:00:00Z
User: Implement RFC-0537
Assistant: Done. session.save and session.archive are ready.
Commands: session.save, session.archive`;
      await writeFile(join(dir, "docs/sessions/.raw", "integration.atif"), rawContent, "utf-8");

      const saveResult = await runSessionSave(makeInput(), makeContext(dir));
      const saveData = saveResult.data as SessionSaveResult;
      expect(saveData.id).toBeDefined();
      expect(saveData.rawDeleted).toBe(true);

      const validateResult = await runSessionValidate(makeInput(), makeContext(dir));
      const validateData = validateResult.data as SessionValidationResult;
      const errors = validateData.violations.filter((v) => v.severity === "error");
      expect(errors.length).toBe(0);

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const mdPath = join(dir, saveData.file);
      let mdContent = await readFile(mdPath, "utf-8");
      mdContent = mdContent.replace(/date: ".*"/, `date: "${oldDate.toISOString()}"`);
      await writeFile(mdPath, mdContent, "utf-8");

      const archiveResult = await runSessionArchive(
        makeInput({ "max-age-days": "7" }),
        makeContext(dir),
      );
      const archiveData = archiveResult.data as SessionArchiveResult;
      expect(archiveData.moved.length).toBe(1);
      expect(archiveData.moved[0]!.id).toBe(saveData.id);
      expect(archiveData.moved[0]!.direction).toBe("into-archive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
