/*
Inert ignore-rule exclusion — a `.gitignore` inside an ignored directory
(node_modules/npm-package artifact) is never read by git and must not count
as session-authored dirt (FLOW-INT-01 false positive hit 2026-11-25 in the
werkstatt evidence-mirror integrate). A root-level untracked `.gitignore`
stays blocking dirt — the CX-142 protection is preserved.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionIgnoreRulePaths } from "../src/utils/verifier-git.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function trackedPaths(paths: string[], root: string): Promise<Set<string> | null> {
  void root;
  // Test simplification: only the root .gitignore is committed in the fixture.
  return new Set(paths.filter((p) => p === ".gitignore"));
}

describe("sessionIgnoreRulePaths inert exclusion", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ignore-rules-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ignores .gitignore files inside ignored directories (npm artifact case)", async () => {
    mkdirSync(join(dir, "node_modules/some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules/some-pkg/.gitignore"), "dist/\n");
    const result = await sessionIgnoreRulePaths(dir, trackedPaths);
    expect(result).toEqual([]);
  });

  it("still flags a root-level untracked .gitignore as session-authored (CX-142)", async () => {
    // Root .gitignore is tracked in fixture; simulate session rewrite by adding a second rule file in a visible subdir.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/.gitignore"), "payload.txt\n");
    const result = await sessionIgnoreRulePaths(dir, trackedPaths);
    expect(result).toEqual(["src/.gitignore"]);
  });

  it("mixed: inert node_modules rule excluded, visible rule still flagged", async () => {
    mkdirSync(join(dir, "node_modules/some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules/some-pkg/.gitignore"), "dist/\n");
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools/.gitignore"), "x\n");
    const result = await sessionIgnoreRulePaths(dir, trackedPaths);
    expect(result).toEqual(["tools/.gitignore"]);
  });
});
