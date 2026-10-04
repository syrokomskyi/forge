/*
<MODULE_CONTRACT>
<purpose>Unit tests for runRfcValidate flag handling — the --id guard that
rejects non-string values before file scanning.</purpose>
<non-goals>
  <item>Do not duplicate validate-rules coverage — V-rule behavior lives in validate-rules*.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial test — non-string --id (boolean/array from unvalidated flag input) throws a clear flag error instead of TypeError in rfcFileMatchesId.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRfcValidate } from "./validate.ts";
import type {
  ForgeCommandInput,
  ForgeFlagValue,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      section: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

describe("runRfcValidate --id flag guard", () => {
  test.each([
    ["boolean true", true],
    ["string array", ["rfc-0001", "rfc-0002"]],
  ])("non-string --id (%s) throws a clear error", async (_label, id) => {
    const dir = mkdtempSync(join(tmpdir(), "rfc-validate-id-"));
    try {
      const input: ForgeCommandInput = {
        argv: [],
        flags: { id: id as ForgeFlagValue },
      };
      await expect(runRfcValidate(input, makeContext(dir))).rejects.toThrow(
        'Flag "--id" for command "rfc.validate" requires a single string value.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing --id runs the all-files path without throwing the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rfc-validate-noid-"));
    try {
      const result = await runRfcValidate(
        { argv: [], flags: {} },
        makeContext(dir),
      );
      expect(result.data?.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
