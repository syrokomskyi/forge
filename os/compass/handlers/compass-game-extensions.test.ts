/*
<MODULE_CONTRACT>
<purpose>Unit tests for Compass game file extension discovery and comment-syntax validation.
Verifies that .cs, .tscn, .tres, .gd files are discovered by createCompassInventoryEntries
and that checkCommentSyntax correctly validates comment prefixes for each file type.</purpose>
<non-goals>
  <item>Do not test compass.validate end-to-end — that is covered by existing tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial: test game extension discovery and comment-syntax validation for .cs, .gd, .tscn, .tres files.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompassInventoryEntries } from "./compass-inventory.ts";
import { runCompassValidation } from "./compass-inventory-handler.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
  };
}

const emptyInput: ForgeCommandInput = { argv: [], flags: {} };

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "compass-game-ext-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("createCompassInventoryEntries discovers .cs files", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Player.cs"),
    "namespace Game { class Player {} }\n",
    "utf8",
  );

  const entries = await createCompassInventoryEntries(tempDir, emptyInput);
  const csEntry = entries.find((e) => e.path.endsWith(".cs"));
  expect(csEntry).toBeDefined();
  expect(csEntry?.extension).toBe(".cs");
});

test("createCompassInventoryEntries discovers .gd files", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Player.gd"),
    "extends Node2D\n",
    "utf8",
  );

  const entries = await createCompassInventoryEntries(tempDir, emptyInput);
  const gdEntry = entries.find((e) => e.path.endsWith(".gd"));
  expect(gdEntry).toBeDefined();
  expect(gdEntry?.extension).toBe(".gd");
});

test("createCompassInventoryEntries discovers .tscn files", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Scene.tscn"),
    "[gd_scene]\n",
    "utf8",
  );

  const entries = await createCompassInventoryEntries(tempDir, emptyInput);
  const tscnEntry = entries.find((e) => e.path.endsWith(".tscn"));
  expect(tscnEntry).toBeDefined();
  expect(tscnEntry?.extension).toBe(".tscn");
});

test("createCompassInventoryEntries discovers .tres files", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Material.tres"),
    "[gd_resource]\n",
    "utf8",
  );

  const entries = await createCompassInventoryEntries(tempDir, emptyInput);
  const tresEntry = entries.find((e) => e.path.endsWith(".tres"));
  expect(tresEntry).toBeDefined();
  expect(tresEntry?.extension).toBe(".tres");
});

test("compass.validate emits COMPASS-SYNTAX-01 for .gd file with wrong comment syntax", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Player.gd"),
    `/* <MODULE_CONTRACT>
<purpose>Player movement and input handling logic for the game</purpose>
<non-goals>
  <item>Do not handle combat logic here</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial creation</item>
</CHANGE_SUMMARY>
*/
extends Node2D
`,
    "utf8",
  );

  const result = await runCompassValidation(emptyInput, makeContext(tempDir));
  const syntaxDiag = result.data?.diagnostics.find((d) => d.ruleId === "COMPASS-SYNTAX-01");
  expect(syntaxDiag).toBeDefined();
  expect(syntaxDiag?.file).toContain(".gd");
});

test("compass.validate does not emit COMPASS-SYNTAX-01 for .gd file with correct # comment syntax", async () => {
  await mkdir(join(tempDir, "packages", "my-game", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-game", "src", "Player.gd"),
    `# <MODULE_CONTRACT>
# <purpose>Player movement and input handling logic for the game</purpose>
# <non-goals>
#   <item>Do not handle combat logic here</item>
# </non-goals>
# </MODULE_CONTRACT>
# <CHANGE_SUMMARY>
#   <item>Initial creation</item>
# </CHANGE_SUMMARY>
extends Node2D
`,
    "utf8",
  );

  const result = await runCompassValidation(emptyInput, makeContext(tempDir));
  const syntaxDiag = result.data?.diagnostics.find((d) => d.ruleId === "COMPASS-SYNTAX-01");
  expect(syntaxDiag).toBeUndefined();
});
