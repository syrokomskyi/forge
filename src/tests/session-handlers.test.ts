import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeFlagValue } from "../../src/types.ts";
import { runSessionSave } from "../../os/session/handlers/save.ts";
import { runSessionArchive } from "../../os/session/handlers/archive.ts";
import { runSessionValidate } from "../../os/session/handlers/validate.ts";
import { runSessionList } from "../../os/session/handlers/list.ts";
import type {
  SessionSaveResult,
  SessionArchiveResult,
  SessionValidationResult,
  SessionListResult,
} from "../../os/session/types.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-session-test-"));
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

const SAMPLE_ATIF = `2026-07-26T12:04:00+02:00
User: Let's implement RFC-0537 for session documentation.
Assistant: I'll start by creating the types and handlers.
User: Run rfc.validate to check the RFC.
Assistant: Done. The RFC is valid.
Commit: a3f2c1d implemented session save handler.
Files: packages/forge/os/session/handlers/save.ts
Commands: session.save, session.archive, rfc.validate`;

describe("session.save", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/sessions/.raw"), { recursive: true });
    await mkdir(join(dir, "docs/sessions/archive"), { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("converts raw ATIF file to structured markdown", async () => {
    const rawPath = join(dir, "docs/sessions/.raw", "2026-07-26-session.atif");
    await writeFile(rawPath, SAMPLE_ATIF, "utf-8");

    const result = await runSessionSave(makeInput(), makeContext(dir));
    const data = result.data as SessionSaveResult & { skipped: unknown[] };

    expect(data.command).toBe("session.save");
    expect(data.status).toBe("ok");
    expect(data.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(data.file).toContain("docs/sessions/");
    expect(data.file).toMatch(/\.md$/);
    expect(data.rawDeleted).toBe(true);
    expect(data.types.length).toBeGreaterThan(0);
    expect(data.extractedMetadata.relatedRfcs).toContain("RFC-0537");
    expect(data.extractedMetadata.commands).toContain("session.save");

    const mdContent = await readFile(join(dir, data.file), "utf-8");
    expect(mdContent).toContain("---");
    expect(mdContent).toContain("## Transcript");
    expect(mdContent).toContain(`id: ${data.id}`);
  });

  test("is idempotent — same raw file produces same output, skips on second run", async () => {
    const rawPath = join(dir, "docs/sessions/.raw", "2026-07-26-session-2.atif");
    await writeFile(rawPath, SAMPLE_ATIF, "utf-8");

    const result1 = await runSessionSave(makeInput({ "keep-raw": true }), makeContext(dir));
    const data1 = result1.data as SessionSaveResult & { skipped: unknown[] };
    expect(data1.id).toBeDefined();

    const result2 = await runSessionSave(makeInput({ "keep-raw": true }), makeContext(dir));
    const data2 = result2.data as SessionSaveResult & { skipped: unknown[] };
    expect(data2.skipped.length).toBeGreaterThan(0);
    expect(data2.skipped[0]).toHaveProperty("reason", "already converted");
  });

  test("no raw files — exit zero with summary", async () => {
    const emptyDir = await makeTempDir();
    try {
      await mkdir(join(emptyDir, "docs/sessions/.raw"), { recursive: true });
      const result = await runSessionSave(makeInput(), makeContext(emptyDir));
      expect(result.summary).toContain("No raw files");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("--raw-file not found — throws error", async () => {
    await expect(
      runSessionSave(makeInput({ "raw-file": "nonexistent.atif" }), makeContext(dir)),
    ).rejects.toThrow("Raw file not found");
  });

  test("--dry-run does not write files", async () => {
    const dryDir = await makeTempDir();
    try {
      await mkdir(join(dryDir, "docs/sessions/.raw"), { recursive: true });
      const rawPath = join(dryDir, "docs/sessions/.raw", "test-dry.atif");
      await writeFile(rawPath, "test content", "utf-8");

      const ctx = makeContext(dryDir);
      ctx.dryRun = true;
      const result = await runSessionSave(makeInput(), ctx);
      const data = result.data as SessionSaveResult;
      expect(data.dryRun).toBe(true);

      const sessionsDir = join(dryDir, "docs/sessions");
      const files = await readdir(sessionsDir).catch(() => []);
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      expect(mdFiles.length).toBe(0);
    } finally {
      await rm(dryDir, { recursive: true, force: true });
    }
  });
});

describe("session.archive", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/sessions/archive"), { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("moves old session to archive/", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldId = `2026-07-16-12-00-00-aaaaaa`;
    const oldFile = join(dir, "docs/sessions", `${oldId}.md`);
    const content = `---
id: ${oldId}
date: "${oldDate.toISOString()}"
types: [implementation]
summary: "Old session"
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${oldId}

## Transcript

Old content.
`;
    await writeFile(oldFile, content, "utf-8");

    const result = await runSessionArchive(makeInput({ "max-age-days": "7" }), makeContext(dir));
    const data = result.data as SessionArchiveResult;

    expect(data.command).toBe("session.archive");
    expect(data.moved.length).toBe(1);
    expect(data.moved[0]!.direction).toBe("into-archive");
    expect(data.moved[0]!.id).toBe(oldId);
  });

  test("skips young session", async () => {
    const youngId = `2026-07-25-12-00-00-bbbbbb`;
    const youngDate = new Date();
    youngDate.setDate(youngDate.getDate() - 1);
    const youngFile = join(dir, "docs/sessions", `${youngId}.md`);
    const content = `---
id: ${youngId}
date: "${youngDate.toISOString()}"
types: [freeform]
summary: "Young session"
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${youngId}

## Transcript

Young content.
`;
    await writeFile(youngFile, content, "utf-8");

    const result = await runSessionArchive(makeInput({ "max-age-days": "7" }), makeContext(dir));
    const data = result.data as SessionArchiveResult;

    const youngMove = data.moved.find((m) => m.id === youngId);
    expect(youngMove).toBeUndefined();
  });

  test("bidirectional — moves young archived file back", async () => {
    const archivedId = `2026-07-25-12-00-00-cccccc`;
    const archivedDate = new Date();
    archivedDate.setDate(archivedDate.getDate() - 1);
    const archFile = join(dir, "docs/sessions/archive", `${archivedId}.md`);
    const content = `---
id: ${archivedId}
date: "${archivedDate.toISOString()}"
types: [freeform]
summary: "Archived young session"
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${archivedId}

## Transcript

Content.
`;
    await writeFile(archFile, content, "utf-8");

    const result = await runSessionArchive(makeInput({ "max-age-days": "7" }), makeContext(dir));
    const data = result.data as SessionArchiveResult;

    const move = data.moved.find((m) => m.id === archivedId);
    expect(move).toBeDefined();
    expect(move!.direction).toBe("out-of-archive");
  });

  test("invalid --max-age-days throws", async () => {
    await expect(
      runSessionArchive(makeInput({ "max-age-days": "0" }), makeContext(dir)),
    ).rejects.toThrow("Invalid --max-age-days");
  });
});

describe("session.validate", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/sessions"), { recursive: true });
    await mkdir(join(dir, "docs/rfcs"), { recursive: true });

    const rfcContent = `---
id: RFC-0537
title: Test RFC
status: accepted
---

# RFC-0537

Test content.
`;
    await writeFile(join(dir, "docs/rfcs", "rfc-0537-test.md"), rfcContent, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("passes for valid session file", async () => {
    const validId = "2026-07-26-12-00-00-dddddd";
    const content = `---
id: ${validId}
date: "2026-07-26T12:00:00+02:00"
types: [implementation]
summary: "Valid session"
relatedRfcs: [RFC-0537]
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${validId}

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions", `${validId}.md`), content, "utf-8");

    const result = await runSessionValidate(makeInput(), makeContext(dir));
    const data = result.data as SessionValidationResult;

    expect(data.status).toBe("pass");
    const errors = data.violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("SES-01: missing required field", async () => {
    const badId = "2026-07-26-12-00-00-eeeeee";
    const content = `---
id: ${badId}
date: "2026-07-26T12:00:00+02:00"
---

# Session: ${badId}

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions", `${badId}.md`), content, "utf-8");

    const result = await runSessionValidate(makeInput(), makeContext(dir));
    const data = result.data as SessionValidationResult;

    const ses01 = data.violations.filter((v) => v.rule === "SES-01" && v.severity === "error");
    expect(ses01.length).toBeGreaterThan(0);
    expect(ses01.some((v) => v.message.includes("types"))).toBe(true);
  });

  test("SES-02: id does not match filename", async () => {
    const fileName = "2026-07-26-12-00-00-ffffff";
    const content = `---
id: wrong-id
date: "2026-07-26T12:00:00+02:00"
types: [freeform]
summary: ""
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: wrong-id

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions", `${fileName}.md`), content, "utf-8");

    const result = await runSessionValidate(makeInput(), makeContext(dir));
    const data = result.data as SessionValidationResult;

    const ses02 = data.violations.filter((v) => v.rule === "SES-02");
    expect(ses02.length).toBe(1);
  });

  test("SES-03: relatedRfcs references non-existent RFC", async () => {
    const badId = "2026-07-26-12-00-00-111111";
    const content = `---
id: ${badId}
date: "2026-07-26T12:00:00+02:00"
types: [freeform]
summary: ""
relatedRfcs: [RFC-9999]
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${badId}

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions", `${badId}.md`), content, "utf-8");

    const result = await runSessionValidate(makeInput(), makeContext(dir));
    const data = result.data as SessionValidationResult;

    const ses03 = data.violations.filter((v) => v.rule === "SES-03");
    expect(ses03.length).toBe(1);
  });

  test("no session files — exit zero", async () => {
    const emptyDir = await makeTempDir();
    try {
      await mkdir(join(emptyDir, "docs/sessions"), { recursive: true });
      const result = await runSessionValidate(makeInput(), makeContext(emptyDir));
      expect(result.summary).toContain("No session files");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("session.list", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/sessions"), { recursive: true });
    await mkdir(join(dir, "docs/sessions/archive"), { recursive: true });

    const session1Id = "2026-07-26-12-00-00-222222";
    const session1 = `---
id: ${session1Id}
date: "2026-07-26T12:00:00+02:00"
types: [implementation, grilling]
summary: "Session 1"
relatedRfcs: [RFC-0537]
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${session1Id}

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions", `${session1Id}.md`), session1, "utf-8");

    const session2Id = "2026-07-20-12-00-00-333333";
    const session2 = `---
id: ${session2Id}
date: "2026-07-20T12:00:00+02:00"
types: [mission]
summary: "Session 2"
relatedRfcs: []
relatedArtifacts: []
decisions: []
commits: []
files: []
commands: []
---

# Session: ${session2Id}

## Transcript

Content.
`;
    await writeFile(join(dir, "docs/sessions/archive", `${session2Id}.md`), session2, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("lists all sessions including archived", async () => {
    const result = await runSessionList(makeInput(), makeContext(dir));
    const data = result.data as SessionListResult;

    expect(data.count).toBe(2);
    const archived = data.sessions.find((s) => s.archived);
    expect(archived).toBeDefined();
    const active = data.sessions.find((s) => !s.archived);
    expect(active).toBeDefined();
  });

  test("filter by RFC", async () => {
    const result = await runSessionList(makeInput({ rfc: "RFC-0537" }), makeContext(dir));
    const data = result.data as SessionListResult;

    expect(data.count).toBe(1);
    expect(data.sessions[0]!.relatedRfcs).toContain("RFC-0537");
  });

  test("filter by type", async () => {
    const result = await runSessionList(makeInput({ type: "mission" }), makeContext(dir));
    const data = result.data as SessionListResult;

    expect(data.count).toBe(1);
    expect(data.sessions[0]!.types).toContain("mission");
  });

  test("invalid date format throws", async () => {
    await expect(
      runSessionList(makeInput({ "date-from": "invalid" }), makeContext(dir)),
    ).rejects.toThrow("Invalid --date-from format");
  });
});
