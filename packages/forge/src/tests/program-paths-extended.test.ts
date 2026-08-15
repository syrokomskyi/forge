/*
<MODULE_CONTRACT>
<purpose>Extended path tests — symlinks, traversal, case-only paths, Windows
separators, deleted files, renames, generated files, and ecosystem.commit
split ranges (RFC-0856 AC-7).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial extended path tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  pathMatchesGlob,
  isPathAllowed,
  isPathForbidden,
  normalizePath,
} from "../../os/program/discovery.ts";

describe("path traversal safety", () => {
  it("rejects ../ in path against allowed glob", () => {
    const allowed = ["packages/forge/**"];
    expect(isPathAllowed("packages/forge/../../etc/passwd", allowed)).toBe(false);
  });

  it("rejects path starting with ../", () => {
    const forbidden = ["../systems-cache/**"];
    expect(isPathForbidden("../systems-cache/foo.ts", forbidden)).toBe(true);
  });

  it("does not allow traversal via .. to escape allowed directory", () => {
    const allowed = ["packages/forge/**"];
    // ../packages/forge/foo.ts resolves to packages/forge/foo.ts which IS allowed
    // But packages/forge/../../etc/passwd resolves to etc/passwd which is NOT allowed
    expect(isPathAllowed("packages/forge/../../etc/passwd", allowed)).toBe(false);
  });
});

describe("case-only paths", () => {
  it("treats different case as different path", () => {
    expect(pathMatchesGlob("Packages/Forge/foo.ts", "packages/forge/**")).toBe(false);
  });

  it("matches exact case", () => {
    expect(pathMatchesGlob("packages/forge/foo.ts", "packages/forge/**")).toBe(true);
  });
});

describe("Windows separators", () => {
  it("normalizes backslashes before matching", () => {
    expect(isPathAllowed("packages\\forge\\os\\program\\schemas.ts", ["packages/forge/**"])).toBe(
      true,
    );
  });

  it("normalizes backslashes in forbidden check", () => {
    expect(isPathForbidden("missions\\foo\\bar.ts", ["missions/**"])).toBe(true);
  });

  it("handles mixed separators", () => {
    expect(isPathAllowed("packages\\forge/os\\program/foo.ts", ["packages/forge/**"])).toBe(true);
  });
});

describe("deleted and renamed files", () => {
  it("deleted file path still matches glob", () => {
    // The path matching is purely string-based, so deleted files still match
    expect(isPathAllowed("packages/forge/deleted.ts", ["packages/forge/**"])).toBe(true);
  });

  it("renamed file old path matches if within allowed", () => {
    expect(isPathAllowed("packages/forge/old-name.ts", ["packages/forge/**"])).toBe(true);
  });

  it("renamed file new path outside allowed is rejected", () => {
    expect(isPathAllowed("packages/ui/new-name.ts", ["packages/forge/**"])).toBe(false);
  });
});

describe("generated files", () => {
  it("generated yaml matches glob", () => {
    expect(isPathAllowed("docs/command-manifest.generated.yaml", ["docs/**"])).toBe(true);
  });

  it("generated file in subdirectory matches", () => {
    expect(isPathAllowed("docs/plans/foo/completions/010.json", ["docs/plans/**"])).toBe(true);
  });
});

describe("ecosystem.commit split ranges", () => {
  it("files in different packages both match broad glob", () => {
    const allowed = ["packages/**"];
    expect(isPathAllowed("packages/forge/os/program/schemas.ts", allowed)).toBe(true);
    expect(isPathAllowed("packages/werkstatt/src/workshop/templates.ts", allowed)).toBe(true);
  });

  it("files in docs and packages match combined glob list", () => {
    const allowed = ["packages/**", "docs/**", ".gitignore"];
    expect(isPathAllowed("packages/forge/foo.ts", allowed)).toBe(true);
    expect(isPathAllowed("docs/rfcs/rfc-0856.md", allowed)).toBe(true);
    expect(isPathAllowed(".gitignore", allowed)).toBe(true);
    expect(isPathAllowed("tools/kernel.config.ts", allowed)).toBe(false);
  });
});

describe("edge cases", () => {
  it("empty string does not match any glob", () => {
    expect(pathMatchesGlob("", "packages/**")).toBe(false);
  });

  it("root path does not match subdirectory glob", () => {
    expect(pathMatchesGlob("/", "packages/**")).toBe(false);
  });

  it("glob without ** does not match subdirectories", () => {
    expect(pathMatchesGlob("packages/forge/os/foo.ts", "packages/forge/*.ts")).toBe(false);
  });

  it("exact file path matches exact glob", () => {
    expect(pathMatchesGlob("tools/kernel.config.ts", "tools/kernel.config.ts")).toBe(true);
  });
});
