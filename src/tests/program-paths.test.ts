/*
<MODULE_CONTRACT>
<purpose>Unit tests for program packet path matching utilities — verify
cross-platform glob matching, symlink safety, and forbidden path detection
(RFC-0856).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial path matching tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  pathMatchesGlob,
  isPathAllowed,
  isPathForbidden,
  normalizePath,
} from "../../os/program/discovery.ts";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("packages\\forge\\foo.ts")).toBe("packages/forge/foo.ts");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalizePath("packages/forge/foo.ts")).toBe("packages/forge/foo.ts");
  });
});

describe("pathMatchesGlob", () => {
  it("matches exact path", () => {
    expect(pathMatchesGlob("packages/forge/foo.ts", "packages/forge/foo.ts")).toBe(true);
  });

  it("does not match different path", () => {
    expect(pathMatchesGlob("packages/forge/bar.ts", "packages/forge/foo.ts")).toBe(false);
  });

  it("matches /** glob prefix", () => {
    expect(pathMatchesGlob("packages/forge/os/program/foo.ts", "packages/forge/**")).toBe(true);
  });

  it("matches /** glob exact prefix", () => {
    expect(pathMatchesGlob("packages/forge", "packages/forge/**")).toBe(true);
  });

  it("does not match /** glob for different prefix", () => {
    expect(pathMatchesGlob("packages/ui/foo.ts", "packages/forge/**")).toBe(false);
  });

  it("matches single * wildcard", () => {
    expect(pathMatchesGlob("packages/forge/foo.ts", "packages/forge/*.ts")).toBe(true);
  });

  it("does not match * across directories", () => {
    expect(pathMatchesGlob("packages/forge/os/foo.ts", "packages/forge/*.ts")).toBe(false);
  });

  it("matches ** across multiple directories", () => {
    expect(pathMatchesGlob("a/b/c/d/e.ts", "a/**")).toBe(true);
  });
});

describe("isPathAllowed", () => {
  const allowed = ["packages/forge/**", "docs/plans/**", ".gitignore"];

  it("allows path matching a glob", () => {
    expect(isPathAllowed("packages/forge/os/program/schemas.ts", allowed)).toBe(true);
  });

  it("allows exact match", () => {
    expect(isPathAllowed(".gitignore", allowed)).toBe(true);
  });

  it("rejects path not matching any glob", () => {
    expect(isPathAllowed("packages/ui/foo.ts", allowed)).toBe(false);
  });

  it("handles Windows-style paths", () => {
    expect(isPathAllowed("packages\\forge\\foo.ts", allowed)).toBe(true);
  });
});

describe("isPathForbidden", () => {
  const forbidden = ["missions/**", ".git/**", "../systems-cache/**"];

  it("detects forbidden path", () => {
    expect(isPathForbidden("missions/foo/workpiece.ts", forbidden)).toBe(true);
  });

  it("allows non-forbidden path", () => {
    expect(isPathForbidden("packages/forge/foo.ts", forbidden)).toBe(false);
  });

  it("detects .git directory", () => {
    expect(isPathForbidden(".git/HEAD", forbidden)).toBe(true);
  });
});
