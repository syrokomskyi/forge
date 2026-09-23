import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runRfcCreate } from "./handlers/list-create.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1138 AC-5: concurrent rfc.create invocations must produce distinct
    RFC ids — the wx (exclusive-create) write + bounded retry on EEXIST
    replaces the old scan-then-write race.
  </purpose>
</MODULE_CONTRACT>
*/

const RFC_TEMPLATE = `---
id: RFC-0000
title: "TEMPLATE"
kind: command
scope: workspace
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
satisfies: []
---

# RFC-0000: TEMPLATE
`;

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

function makeInput(title: string): ForgeCommandInput {
  return {
    commandName: "rfc.create",
    // kind "command" avoids the post-cutoff --satisfies requirement
    // (only architecture|contract require DNA ids).
    flags: { title, kind: "command", scope: "workspace" },
  } as unknown as ForgeCommandInput;
}

describe("rfc.create — RFC-1138 concurrent id allocation", () => {
  let tmpDir: string;
  let rfcDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-create-"));
    rfcDir = path.join(tmpDir, "docs", "rfcs");
    await fs.mkdir(rfcDir, { recursive: true });
    await fs.writeFile(path.join(rfcDir, "rfc-0000-template.md"), RFC_TEMPLATE, "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("AC-5: five concurrent creates produce five distinct ids", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        runRfcCreate(makeInput(`Concurrent RFC ${n}`), makeContext(tmpDir)),
      ),
    );

    const ids = results.map((r) => (r.data as { id: string }).id);
    expect(new Set(ids).size).toBe(5);

    const files = (await fs.readdir(rfcDir)).filter((f) => f.startsWith("rfc-") && f !== "rfc-0000-template.md");
    expect(files).toHaveLength(5);
  });

  test("AC-5: sequential creates still allocate monotonically", async () => {
    const first = await runRfcCreate(makeInput("First"), makeContext(tmpDir));
    const second = await runRfcCreate(makeInput("Second"), makeContext(tmpDir));

    const firstId = (first.data as { id: string }).id;
    const secondId = (second.data as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    expect(secondId > firstId).toBe(true);
  });

  test("AC-5: pre-existing highest id is respected after a collision", async () => {
    // Seed rfc-0001 so the first create takes 0002; a file racing in at 0002
    // forces the retry path to land on 0003.
    await fs.writeFile(path.join(rfcDir, "rfc-0001-seeded.md"), "---\nid: RFC-0001\n---\n", "utf-8");
    const winner = runRfcCreate(makeInput("Winner"), makeContext(tmpDir));
    // Interleave a manual claim at the id the scan will compute.
    const claim = (async () => {
      // Small delay so the create's scan completes first, then we steal 0002.
      await new Promise((r) => setTimeout(r, 5));
      await fs
        .writeFile(path.join(rfcDir, "rfc-0002-interloper.md"), "---\nid: RFC-0002\n---\n", {
          flag: "wx",
        })
        .catch(() => {});
    })();
    const [result] = await Promise.all([winner, claim]);

    const id = (result.data as { id: string }).id;
    // Either the create won 0002 (interloper lost the wx race) or it retried to 0003.
    expect(["RFC-0002", "RFC-0003"]).toContain(id);
    const files = (await fs.readdir(rfcDir)).filter((f) => f.startsWith("rfc-") && f !== "rfc-0000-template.md");
    // Seeded + interloper (if it won) + create output — never a silent overwrite.
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});
