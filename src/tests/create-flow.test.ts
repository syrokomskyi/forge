/*
<MODULE_CONTRACT>
<purpose>RFC-1500 step 2 — forge.create adopts the fixed branch model:
one scaffold commit on main, then flow.install in process. AC-1 (develop +
main, HEAD on develop), AC-2 (annotated v0.1.0 release tag), AC-3
(--no-flow leaves no commit).</purpose>
<non-goals>
  <item>Not a flow.install contract test — install internals are covered by os/flow tests; this file pins the create composition only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1500: step 2 — create-flow adoption tests</item>
  <item>RFC-1500: step 2 — forge.create adopts the fixed branch model</item>
  <item>RFC-1500: link branch-model guide in committed NEXT_STEPS.md (review r1)</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { runCreate } from "../onboarding/create.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "create-flow-test-"));
  // A bare `.git` is the only tolerated pre-existing entry; init here so the
  // fixture can carry a local identity before runCreate commits.
  git(tempDir, ["init", "--initial-branch=main"]);
  git(tempDir, ["config", "user.name", "Flow Test"]);
  git(tempDir, ["config", "user.email", "flow-test@example.invalid"]);
});

// rm of a scaffolded node_modules is minutes-slow on Windows — the 10s
// default hook budget cannot hold it.
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
}, 180000);

describe("RFC-1500: forge.create adopts the fixed branch model", () => {
  test("AC-1: create leaves develop + main with the primary on develop", async () => {
    const result = await runCreate(
      { argv: [], flags: { "in-place": true, profile: "typescript", name: "my-project" } },
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.flow).toMatchObject({ status: "adopted" });

    const branches = git(tempDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n");
    expect(branches).toContain("develop");
    expect(branches).toContain("main");
    expect(git(tempDir, ["symbolic-ref", "--short", "-q", "HEAD"])).toBe("develop");

    // RFC-1500 step 5: the committed NEXT_STEPS.md links the consumer guide.
    expect(git(tempDir, ["show", "main:NEXT_STEPS.md"])).toContain("branch-model.md");
  }, 120000);

  test("AC-2: create leaves an annotated v0.1.0 tag with the release-tag schema line", async () => {
    const result = await runCreate(
      { argv: [], flags: { "in-place": true, profile: "typescript", name: "my-project" } },
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);

    const out = git(tempDir, [
      "for-each-ref",
      "refs/tags/v0.1.0",
      "--format=%(objecttype) %(contents)",
    ]);
    expect(out.startsWith("tag ")).toBe(true);
    expect(out).toContain("schema: forge/release-tag@1");
  }, 120000);

  test("AC-3: --no-flow leaves no commit", async () => {
    const result = await runCreate(
      {
        argv: [],
        flags: { "in-place": true, "no-flow": true, profile: "typescript", name: "my-project" },
      },
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.flow).toMatchObject({ status: "skipped", reason: "no-flow-flag" });

    expect(git(tempDir, ["rev-list", "--all", "--count"])).toBe("0");
  }, 120000);
});
