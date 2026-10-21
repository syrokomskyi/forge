import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { rename as fsRename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runRfcIndexGenerate, __setParseRfcImplForTests } from "../index-graph.ts";
import { runRfcCreate } from "../list-create.ts";
import { __setRenameImplForTests } from "../../../../src/utils/fs-atomic.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../../src/types.ts";
import type { ReadAndParseRfcResult } from "../../frontmatter-io.ts";

/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1364: rfc.index.generate tolerates concurrent RFC file writes —
    bounded retry on parse failure, RFC-IDX-04 diagnostic on persistent
    failure, no index write over unreadable sources, atomic index and
    rfc.create writes.
  </purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1364: retry/RFC-IDX-04/atomic-write coverage via injected reader and rename seams.</item>
  <item>RFC-1364: robust rfc index generation — bounded retry, RFC-IDX-04, atomic writes</item>
</CHANGE_SUMMARY>
*/

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown>): ForgeCommandInput {
  return { commandName: "rfc.index.generate", flags } as unknown as ForgeCommandInput;
}

function parsedFixture(fileName: string, id: string): ReadAndParseRfcResult {
  return {
    fileName,
    parsed: {
      frontmatter: {
        id,
        title: `RFC ${id}`,
        status: "draft",
        kind: "command",
        scope: "workspace",
        createdAt: "2026-10-21",
        updatedAt: "2026-10-21",
        supersedes: [],
        amends: [],
        amendedBy: [],
        related: [],
      },
      body: "",
    },
  };
}

describe("rfc.index.generate — RFC-1364 concurrent-write robustness", () => {
  let tmpDir: string;
  let rfcDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-idx-1364-"));
    rfcDir = path.join(tmpDir, "docs", "rfcs");
    await fs.mkdir(rfcDir, { recursive: true });
    await fs.writeFile(
      path.join(rfcDir, "rfc-0001-stable.md"),
      '---\nid: RFC-0001\ntitle: "Stable"\nstatus: draft\nkind: command\nscope: workspace\ncreatedAt: 2026-10-21\nupdatedAt: 2026-10-21\n---\n\n# RFC-0001: Stable\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(rfcDir, "rfc-0002-flaky.md"),
      "placeholder — the injected reader seam decides what this parses to",
      "utf-8",
    );
  });

  afterEach(async () => {
    __setParseRfcImplForTests(undefined);
    __setRenameImplForTests(undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("AC-1: a file unparseable on the first read and valid on the second still writes the index", async () => {
    let flakyReads = 0;
    __setParseRfcImplForTests(async (_dir, fileName) => {
      if (fileName === "rfc-0002-flaky.md" && flakyReads++ === 0) {
        return { fileName, error: "YAML parse error: partial file" };
      }
      return parsedFixture(fileName, fileName === "rfc-0002-flaky.md" ? "RFC-0002" : "RFC-0001");
    });

    const result = await runRfcIndexGenerate(makeInput({ write: true }), makeContext(tmpDir));
    const data = result.data as { status: string; written?: string; count: number };
    expect(data.status).toBe("ok");
    expect(data.written).toBe(path.join("docs", "rfcs", "index.yaml"));
    expect(data.count).toBe(2);
    const index = await fs.readFile(path.join(rfcDir, "index.yaml"), "utf-8");
    expect(index).toContain("RFC-0002");
  });

  test("AC-2: a persistently unparseable file emits RFC-IDX-04 naming it and fails", async () => {
    __setParseRfcImplForTests(async (_dir, fileName) => ({
      fileName,
      error: "YAML parse error: partial file",
    }));

    const result = await runRfcIndexGenerate(makeInput({ write: true }), makeContext(tmpDir));
    expect(result.exitCode).toBe(1);
    const data = result.data as {
      status: string;
      violations: { rule: string; file: string; message: string }[];
    };
    expect(data.status).toBe("fail");
    expect(data.violations).toHaveLength(2);
    for (const v of data.violations) {
      expect(v.rule).toBe("RFC-IDX-04");
      expect(v.file).toMatch(/^docs\/rfcs\/rfc-\d{4}/);
      expect(v.message).toContain("YAML parse error");
    }
  });

  test("AC-3: RFC-IDX-04 leaves a previously written index.yaml byte-identical", async () => {
    const sentinel = "# sentinel index — must survive a failed regeneration\n";
    await fs.writeFile(path.join(rfcDir, "index.yaml"), sentinel, "utf-8");

    __setParseRfcImplForTests(async (_dir, fileName) => ({
      fileName,
      error: "YAML parse error: partial file",
    }));

    const result = await runRfcIndexGenerate(makeInput({ write: true }), makeContext(tmpDir));
    expect(result.exitCode).toBe(1);
    expect(await fs.readFile(path.join(rfcDir, "index.yaml"), "utf-8")).toBe(sentinel);
  });

  test("AC-4: rfc.create writes the new RFC through the atomic rename path", async () => {
    let renameCalls = 0;
    __setRenameImplForTests(async (from, to) => {
      renameCalls++;
      await fsRename(from, to);
    });

    const createInput = {
      commandName: "rfc.create",
      flags: { title: "Atomic RFC", kind: "command", scope: "workspace" },
    } as unknown as ForgeCommandInput;
    const result = await runRfcCreate(createInput, makeContext(tmpDir));
    expect((result.data as { id: string }).id).toBe("RFC-0003");
    expect(renameCalls).toBeGreaterThan(0);
  });
});
