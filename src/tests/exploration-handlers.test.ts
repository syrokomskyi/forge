import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeFlagValue } from "../../src/types.ts";
import { runExplorationList } from "../../os/exploration/handlers/list.ts";
import { runExplorationShow } from "../../os/exploration/handlers/show.ts";
import { runExplorationArchive } from "../../os/exploration/handlers/archive.ts";
import type {
  ExplorationListResult,
  ExplorationShowResult,
  ExplorationArchiveResult,
} from "../../os/exploration/types.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-exploration-test-"));
}

function makeInput(flags: Record<string, ForgeFlagValue> = {}): ForgeCommandInput {
  return { argv: [], flags };
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

const SAMPLE_NOTE = `---
id: self-hosted-fonts
title: "Self-hosted fonts vs CDN"
createdAt: 2026-08-06
status: open
related: []
---

# Exploration: Self-hosted fonts vs CDN

## Idea

Should we self-host fonts or keep using the CDN?

## Options

### Option 1: Self-host
- **Approach:** Download fonts and serve locally.
- **Trade-offs:** More bandwidth, better privacy.

### Option 2: Keep CDN
- **Approach:** Continue using Google Fonts CDN.
- **Trade-offs:** Less control, faster initial load.
`;

const ARCHIVED_NOTE = `---
id: old-idea
title: "Old idea that was explored"
createdAt: 2026-07-01
status: archived
related: [RFC-0700]
---

# Exploration: Old idea

Already archived.
`;

describe("exploration.list", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/explorations"), { recursive: true });
    await writeFile(join(dir, "docs/explorations/self-hosted-fonts.md"), SAMPLE_NOTE, "utf-8");
    await writeFile(join(dir, "docs/explorations/old-idea.md"), ARCHIVED_NOTE, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("lists all exploration notes", async () => {
    const result = await runExplorationList(makeInput(), makeContext(dir));
    const data = result.data as ExplorationListResult;

    expect(data.command).toBe("exploration.list");
    expect(data.status).toBe("ok");
    expect(data.count).toBe(2);
    expect(data.explorations).toHaveLength(2);

    const ids = data.explorations.map((e) => e.id).sort();
    expect(ids).toEqual(["old-idea", "self-hosted-fonts"]);
  });

  test("filters by status", async () => {
    const result = await runExplorationList(makeInput({ status: "archived" }), makeContext(dir));
    const data = result.data as ExplorationListResult;

    expect(data.count).toBe(1);
    expect(data.explorations[0]!.id).toBe("old-idea");
    expect(data.explorations[0]!.status).toBe("archived");
  });

  test("returns empty list when directory does not exist", async () => {
    const emptyDir = await makeTempDir();
    try {
      const result = await runExplorationList(makeInput(), makeContext(emptyDir));
      const data = result.data as ExplorationListResult;

      expect(data.command).toBe("exploration.list");
      expect(data.status).toBe("ok");
      expect(data.count).toBe(0);
      expect(data.explorations).toEqual([]);
      expect(result.exitCode).toBeUndefined();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("exploration.show", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/explorations"), { recursive: true });
    await writeFile(join(dir, "docs/explorations/self-hosted-fonts.md"), SAMPLE_NOTE, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("shows the full content of an exploration note", async () => {
    const result = await runExplorationShow(
      makeInput({ id: "self-hosted-fonts" }),
      makeContext(dir),
    );
    const data = result.data as ExplorationShowResult;

    expect(data.command).toBe("exploration.show");
    expect(data.status).toBe("ok");
    expect(data.note.id).toBe("self-hosted-fonts");
    expect(data.note.title).toBe("Self-hosted fonts vs CDN");
    expect(data.note.status).toBe("open");
    expect(data.note.createdAt).toBe("2026-08-06");
    expect(data.note.related).toEqual([]);
    expect(data.note.body).toContain("# Exploration: Self-hosted fonts vs CDN");
  });

  test("returns exit code 1 when slug not found", async () => {
    const result = await runExplorationShow(makeInput({ id: "nonexistent" }), makeContext(dir));
    const data = result.data as ExplorationShowResult;

    expect(data.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  test("returns exit code 1 when --id is missing", async () => {
    const result = await runExplorationShow(makeInput(), makeContext(dir));
    const data = result.data as ExplorationShowResult;

    expect(data.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });
});

describe("exploration.archive", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "docs/explorations"), { recursive: true });
    await writeFile(join(dir, "docs/explorations/self-hosted-fonts.md"), SAMPLE_NOTE, "utf-8");
    await writeFile(join(dir, "docs/explorations/old-idea.md"), ARCHIVED_NOTE, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("transitions status from open to archived", async () => {
    const result = await runExplorationArchive(
      makeInput({ id: "self-hosted-fonts" }),
      makeContext(dir),
    );
    const data = result.data as ExplorationArchiveResult;

    expect(data.command).toBe("exploration.archive");
    expect(data.status).toBe("ok");
    expect(data.id).toBe("self-hosted-fonts");
    expect(data.previousStatus).toBe("open");
    expect(data.newStatus).toBe("archived");

    const content = await readFile(join(dir, "docs/explorations/self-hosted-fonts.md"), "utf-8");
    expect(content).toContain("status: archived");
  });

  test("adds RFC id to related field", async () => {
    const result = await runExplorationArchive(
      makeInput({ id: "self-hosted-fonts", rfc: "RFC-0710" }),
      makeContext(dir),
    );
    const data = result.data as ExplorationArchiveResult;

    expect(data.related).toContain("RFC-0710");

    const content = await readFile(join(dir, "docs/explorations/self-hosted-fonts.md"), "utf-8");
    expect(content).toContain("RFC-0710");
  });

  test("is idempotent when already archived", async () => {
    const result = await runExplorationArchive(makeInput({ id: "old-idea" }), makeContext(dir));
    const data = result.data as ExplorationArchiveResult;

    expect(data.status).toBe("ok");
    expect(data.previousStatus).toBe("archived");
    expect(data.newStatus).toBe("archived");
    expect(result.exitCode).toBe(0);
  });

  test("returns exit code 1 when slug not found", async () => {
    const result = await runExplorationArchive(makeInput({ id: "nonexistent" }), makeContext(dir));
    const data = result.data as ExplorationArchiveResult;

    expect(data.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  test("returns exit code 1 when --id is missing", async () => {
    const result = await runExplorationArchive(makeInput(), makeContext(dir));
    const data = result.data as ExplorationArchiveResult;

    expect(data.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  test("rejects invalid slug (non-kebab-case)", async () => {
    const result = await runExplorationArchive(
      makeInput({ id: "Invalid_Slug!" }),
      makeContext(dir),
    );
    const data = result.data as ExplorationArchiveResult;

    expect(data.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });
});
