/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1139 AC-4: read-only commands must not write to the working tree —
    no ambient regeneration of tracked generated files as a side effect.
    Guards against future read-path writers.
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runRfcList } from "./handlers/list-create.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

function makeContext(root: string): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    logger: {
      info() {},
      warn() {},
      error() {},
      success() {},
      section() {},
      getEvents: () => [],
    },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        snapshot.set(path.relative(root, full), await fs.readFile(full, "utf8"));
      }
    }
  }
  await walk(root);
  return snapshot;
}

describe("read-only commands — RFC-1139 no side-effect writes", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-readonly-"));
    const rfcDir = path.join(root, "docs", "rfcs");
    await fs.mkdir(rfcDir, { recursive: true });
    await fs.writeFile(
      path.join(rfcDir, "rfc-0001-test.md"),
      `---\nid: RFC-0001\ntitle: "Test"\nstatus: draft\n---\n\n# RFC-0001\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("AC-4: rfc.list leaves the working tree byte-identical", async () => {
    const before = await snapshotTree(root);
    const result = await runRfcList(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    const after = await snapshotTree(root);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, content] of before) {
      expect(after.get(file), `${file} modified by read-only command`).toBe(content);
    }
  });
});
