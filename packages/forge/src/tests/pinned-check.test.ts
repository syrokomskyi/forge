import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPinnedManifest,
  isPinned,
  checkFilesForPinned,
  PinnedManifestMalformedError,
} from "../../os/core/handlers/pinned-check.ts";
import type { PinnedManifest } from "../../os/core/handlers/pinned-types.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-pinned-test-"));
}

describe("loadPinnedManifest", () => {
  test("returns null when manifest does not exist", async () => {
    const dir = await makeTempDir();
    try {
      const result = await loadPinnedManifest(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads valid manifest with entries", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".forge"), { recursive: true });
      await writeFile(
        join(dir, ".forge", "pinned.yaml"),
        "pinned:\n  - path: docs/rfcs/rfc-0000-template.md\n    mode: freeze\n    reason: RFC template\n  - path: forge.yaml\n    mode: protect\n    reason: Forge config\n",
      );
      const result = await loadPinnedManifest(dir);
      expect(result).not.toBeNull();
      expect(result!.pinned).toHaveLength(2);
      expect(result!.pinned[0]!.path).toBe("docs/rfcs/rfc-0000-template.md");
      expect(result!.pinned[0]!.mode).toBe("freeze");
      expect(result!.pinned[1]!.path).toBe("forge.yaml");
      expect(result!.pinned[1]!.mode).toBe("protect");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws PinnedManifestMalformedError for invalid YAML", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".forge"), { recursive: true });
      await writeFile(join(dir, ".forge", "pinned.yaml"), "pinned: [invalid yaml {{{");
      await expect(loadPinnedManifest(dir)).rejects.toThrow(PinnedManifestMalformedError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws PinnedManifestMalformedError when pinned array is missing", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".forge"), { recursive: true });
      await writeFile(join(dir, ".forge", "pinned.yaml"), "foo: bar\n");
      await expect(loadPinnedManifest(dir)).rejects.toThrow(PinnedManifestMalformedError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws PinnedManifestMalformedError for invalid mode", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".forge"), { recursive: true });
      await writeFile(
        join(dir, ".forge", "pinned.yaml"),
        "pinned:\n  - path: foo.md\n    mode: invalid\n    reason: test\n",
      );
      await expect(loadPinnedManifest(dir)).rejects.toThrow(PinnedManifestMalformedError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isPinned", () => {
  const manifest: PinnedManifest = {
    pinned: [
      { path: "docs/rfcs/rfc-0000-template.md", mode: "freeze", reason: "template" },
      { path: "docs/rfcs/", mode: "protect", reason: "RFC directory" },
    ],
  };

  test("exact match returns entry", () => {
    const entry = isPinned(manifest, "docs/rfcs/rfc-0000-template.md");
    expect(entry).not.toBeNull();
    expect(entry!.mode).toBe("freeze");
  });

  test("directory prefix match returns entry", () => {
    const entry = isPinned(manifest, "docs/rfcs/rfc-0733.md");
    expect(entry).not.toBeNull();
    expect(entry!.mode).toBe("protect");
  });

  test("non-matching path returns null", () => {
    const entry = isPinned(manifest, "docs/adrs/adr-0001.md");
    expect(entry).toBeNull();
  });

  test("path outside directory prefix does not match", () => {
    const entry = isPinned(manifest, "docs/rfcs-archive/old.md");
    expect(entry).toBeNull();
  });
});

describe("checkFilesForPinned", () => {
  const manifest: PinnedManifest = {
    pinned: [
      { path: "docs/rfcs/rfc-0000-template.md", mode: "freeze", reason: "template" },
      { path: "docs/rfcs/", mode: "protect", reason: "RFC directory" },
    ],
  };

  test("returns violations for pinned files", () => {
    const violations = checkFilesForPinned(manifest, [
      { relPath: "docs/rfcs/rfc-0000-template.md", operation: "delete" },
      { relPath: "docs/adrs/adr-0001.md", operation: "move" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe("docs/rfcs/rfc-0000-template.md");
    expect(violations[0]!.operation).toBe("delete");
  });

  test("returns empty array when no files are pinned", () => {
    const violations = checkFilesForPinned(manifest, [
      { relPath: "docs/adrs/adr-0001.md", operation: "move" },
      { relPath: "README.md", operation: "modify" },
    ]);
    expect(violations).toHaveLength(0);
  });
});
