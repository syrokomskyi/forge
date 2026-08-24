import { test, expect, describe } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBuiltInSpecs,
  loadContractRegistry,
  findApplicablePackSpecs,
  fileMatchesGlobs,
} from "../compass/contract-registry.ts";
import type { ForgeConfig } from "../config/forge-config.ts";

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "forge-contract-registry-"));
}

function writeManifest(packDir: string, content: string): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "forge.plugin.yaml"), content);
}

describe("contract-registry (RFC-0943)", () => {
  describe("getBuiltInSpecs", () => {
    test("returns MODULE_CONTRACT and CHANGE_SUMMARY as built-in specs", () => {
      const specs = getBuiltInSpecs();
      expect(specs).toHaveLength(2);
      expect(specs[0]!.blockId).toBe("module-contract");
      expect(specs[1]!.blockId).toBe("change-summary");
    });

    test("module-contract has purpose tag with minWords 10", () => {
      const specs = getBuiltInSpecs();
      const moduleContract = specs.find((s) => s.blockId === "module-contract");
      expect(moduleContract).toBeDefined();
      expect(moduleContract!.requiredTags).toBeDefined();
      const purposeTag = moduleContract!.requiredTags!.find((t) => t.name === "purpose");
      expect(purposeTag).toBeDefined();
      expect(purposeTag!.minWords).toBe(10);
    });
  });

  describe("fileMatchesGlobs", () => {
    test("matches a simple glob pattern", () => {
      expect(fileMatchesGlobs("packages/my-pack/src/index.ts", ["packages/my-pack/**/*.ts"])).toBe(true);
    });

    test("does not match when glob does not match", () => {
      expect(fileMatchesGlobs("packages/other-pack/src/index.ts", ["packages/my-pack/**/*.ts"])).toBe(false);
    });

    test("matches any of multiple globs", () => {
      expect(
        fileMatchesGlobs("services/my-service/src/index.ts", [
          "packages/**/*.ts",
          "services/**/*.ts",
        ]),
      ).toBe(true);
    });

    test("handles dot files with dot option", () => {
      expect(fileMatchesGlobs("packages/my-pack/.env.example", ["packages/**/*.example"])).toBe(true);
    });
  });

  describe("loadContractRegistry", () => {
    test("returns only built-in specs when no skillPacks declared", () => {
      const registry = loadContractRegistry("/nonexistent", undefined);
      expect(registry.builtIn).toHaveLength(2);
      expect(registry.pack).toHaveLength(0);
    });

    test("returns only built-in specs when skillPacks is empty", () => {
      const config: ForgeConfig = {
        schema: "forge/bindings@1",
        project: { name: "test", root: "." },
        bindings: undefined,
        skillPacks: [],
      } as unknown as ForgeConfig;
      const registry = loadContractRegistry("/nonexistent", config);
      expect(registry.pack).toHaveLength(0);
    });

    test("loads pack-declared blocks from forge.plugin.yaml", () => {
      const ws = makeTmpWorkspace();
      try {
        const packDir = join(ws, "my-pack");
        writeManifest(
          packDir,
          "id: my-pack\nversion: 1.0.0\nextensionPoints:\n  compass:\n    contract:\n      blocks:\n        - blockId: api-contract\n          requiredFor:\n            - \"packages/my-pack/**/*.ts\"\n          requiredTags:\n            - name: endpoints\n              minWords: 5\n",
        );

        const config: ForgeConfig = {
          schema: "forge/bindings@1",
          project: { name: "test", root: "." },
          bindings: undefined,
          skillPacks: [{ prefix: "my", dir: "my-pack" }],
        } as unknown as ForgeConfig;

        const registry = loadContractRegistry(ws, config);
        expect(registry.pack).toHaveLength(1);
        expect(registry.pack[0]!.blockId).toBe("api-contract");
        expect(registry.pack[0]!.packId).toBe("my-pack");
        expect(registry.pack[0]!.requiredTags).toEqual([{ name: "endpoints", minWords: 5 }]);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("throws on duplicate blockId across packs", () => {
      const ws = makeTmpWorkspace();
      try {
        writeManifest(
          join(ws, "pack-a"),
          "id: pack-a\nversion: 1.0.0\nextensionPoints:\n  compass:\n    contract:\n      blocks:\n        - blockId: shared-block\n          requiredFor:\n            - \"packages/**/*.ts\"\n",
        );
        writeManifest(
          join(ws, "pack-b"),
          "id: pack-b\nversion: 1.0.0\nextensionPoints:\n  compass:\n    contract:\n      blocks:\n        - blockId: shared-block\n          requiredFor:\n            - \"services/**/*.ts\"\n",
        );

        const config: ForgeConfig = {
          schema: "forge/bindings@1",
          project: { name: "test", root: "." },
          bindings: undefined,
          skillPacks: [
            { prefix: "a", dir: "pack-a" },
            { prefix: "b", dir: "pack-b" },
          ],
        } as unknown as ForgeConfig;

        expect(() => loadContractRegistry(ws, config)).toThrow(/COMPASS-PLUGIN-DUP-01/);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("skips packs with no extensionPoints", () => {
      const ws = makeTmpWorkspace();
      try {
        writeManifest(join(ws, "my-pack"), "id: my-pack\nversion: 1.0.0\n");

        const config: ForgeConfig = {
          schema: "forge/bindings@1",
          project: { name: "test", root: "." },
          bindings: undefined,
          skillPacks: [{ prefix: "my", dir: "my-pack" }],
        } as unknown as ForgeConfig;

        const registry = loadContractRegistry(ws, config);
        expect(registry.pack).toHaveLength(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("skips packs with empty blocks array", () => {
      const ws = makeTmpWorkspace();
      try {
        writeManifest(
          join(ws, "my-pack"),
          "id: my-pack\nversion: 1.0.0\nextensionPoints:\n  compass:\n    contract:\n      blocks: []\n",
        );

        const config: ForgeConfig = {
          schema: "forge/bindings@1",
          project: { name: "test", root: "." },
          bindings: undefined,
          skillPacks: [{ prefix: "my", dir: "my-pack" }],
        } as unknown as ForgeConfig;

        const registry = loadContractRegistry(ws, config);
        expect(registry.pack).toHaveLength(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("skips packs with missing manifest file", () => {
      const ws = makeTmpWorkspace();
      try {
        const config: ForgeConfig = {
          schema: "forge/bindings@1",
          project: { name: "test", root: "." },
          bindings: undefined,
          skillPacks: [{ prefix: "my", dir: "nonexistent-pack" }],
        } as unknown as ForgeConfig;

        const registry = loadContractRegistry(ws, config);
        expect(registry.pack).toHaveLength(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe("findApplicablePackSpecs", () => {
    test("returns specs whose requiredFor globs match the file path", () => {
      const registry = {
        builtIn: getBuiltInSpecs(),
        pack: [
          {
            blockId: "api-contract",
            requiredFor: ["packages/my-pack/**/*.ts"],
            requiredTags: [],
            packId: "my-pack",
          },
          {
            blockId: "service-contract",
            requiredFor: ["services/**/*.ts"],
            requiredTags: [],
            packId: "other-pack",
          },
        ],
      };

      const applicable = findApplicablePackSpecs(registry, "packages/my-pack/src/index.ts");
      expect(applicable).toHaveLength(1);
      expect(applicable[0]!.blockId).toBe("api-contract");
    });

    test("returns empty array when no specs match", () => {
      const registry = {
        builtIn: getBuiltInSpecs(),
        pack: [
          {
            blockId: "api-contract",
            requiredFor: ["packages/my-pack/**/*.ts"],
            requiredTags: [],
            packId: "my-pack",
          },
        ],
      };

      const applicable = findApplicablePackSpecs(registry, "packages/other-pack/src/index.ts");
      expect(applicable).toHaveLength(0);
    });

    test("returns empty array when registry has no pack specs", () => {
      const registry = {
        builtIn: getBuiltInSpecs(),
        pack: [],
      };

      const applicable = findApplicablePackSpecs(registry, "packages/my-pack/src/index.ts");
      expect(applicable).toHaveLength(0);
    });
  });
});
