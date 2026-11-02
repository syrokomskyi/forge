/*
<MODULE_CONTRACT>
<purpose>RFC-1500 AC-4: every built-in stack profile ships the two flow
lifecycle hooks — hooks/integration-gate.sh and hooks/worktree-setup.sh —
as workspace.files entries whose contents are POSIX-sh scripts with a
shebang first line and a clean `sh -n` parse.</purpose>
<non-goals>
  <item>Not a gate-semantics test — the flow runner contract is covered by os/flow tests; this file pins the profile payload only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1500: step 1 — profile flow hooks contract test</item>
  <item>RFC-1500: step 1 — profile flow hooks</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listStackProfiles } from "../profiles/stack-profile.ts";

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const HOOK_PATHS = ["hooks/integration-gate.sh", "hooks/worktree-setup.sh"];

describe("RFC-1500: built-in profiles ship flow hooks (AC-4)", () => {
  const profiles = listStackProfiles(FORGE_ROOT);

  it("loads at least the six built-in profiles", () => {
    const ids = profiles.map((p) => p.id);
    for (const expected of [
      "typescript",
      "phaser-game",
      "godot-game",
      "knowledge",
      "forge-shell",
      "site-workshop",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  for (const profile of profiles) {
    describe(`profile ${profile.id}`, () => {
      const files = profile.workspace.files;
      const paths = files.map((f) => f.path);

      it("declares both hook files in workspace.files", () => {
        for (const hookPath of HOOK_PATHS) {
          expect(paths).toContain(hookPath);
        }
      });

      for (const hookPath of HOOK_PATHS) {
        it(`${hookPath} starts with #!/bin/sh and parses with sh -n`, async () => {
          const entry = files.find((f) => f.path === hookPath);
          expect(entry).toBeDefined();
          const content = entry!.content;
          expect(content.startsWith("#!/bin/sh")).toBe(true);

          const dir = await mkdtemp(join(tmpdir(), "flow-hook-"));
          try {
            const scriptPath = join(dir, "hook.sh");
            await writeFile(scriptPath, content, "utf8");
            // sh -n parses without executing — a syntax failure exits non-zero.
            execFileSync("sh", ["-n", scriptPath], { stdio: "pipe" });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        });
      }
    });
  }
});
