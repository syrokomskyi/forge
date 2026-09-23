/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1139 AC-1: the next-steps hint printed by rfc.create must be an
    executable command — correct binary (werkstatt, not forge), correct
    subcommand (run), and correct flags (--id, not --file).
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runRfcCreate } from "./handlers/list-create.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

const RFC_DIR = "docs/rfcs";

const TEMPLATE = `---
id: RFC-0000
title: "Template"
status: draft
kind: command
scope: workspace
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
satisfies: []
---

# RFC-0000: Template
`;

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

function makeInput(flags: Record<string, unknown>): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

describe("rfc.create — RFC-1139 next-steps hint accuracy", () => {
  let root: string;
  let rfcDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-hint-"));
    rfcDir = path.join(root, RFC_DIR);
    await fs.mkdir(rfcDir, { recursive: true });
    await fs.writeFile(path.join(rfcDir, "rfc-0000-template.md"), TEMPLATE, "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("AC-1: next-steps hint is an executable werkstatt command with --id", async () => {
    const result = await runRfcCreate(
      makeInput({ title: "Hint Test", kind: "command", scope: "workspace" }),
      makeContext(root),
    );

    const steps = result.nextSteps ?? [];
    expect(steps.length).toBeGreaterThan(0);

    for (const step of steps) {
      const match = step.action.match(/pnpm exec (\S+) run ([\w.]+)/);
      expect(match, `hint "${step.action}" must contain a runnable command`).not.toBeNull();
      const [, binary, command] = match!;
      // forge has no `run` subcommand — werkstatt does
      expect(binary).toBe("werkstatt");
      expect(command).toBe("rfc.validate");
      // rfc.validate takes --id, not --file
      expect(step.action).toContain("--id RFC-");
      expect(step.action).not.toContain("--file");
    }
  });
});
