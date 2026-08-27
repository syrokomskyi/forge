/*
<MODULE_CONTRACT>
<purpose>Validator unit tests — verify each ts.*.validate command returns correct results for empty and populated workspaces (RFC-0889).</purpose>
<keywords>test, validators, typescript, tsconfig, imports, phantom, exports, strict, barrel</keywords>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial validator unit tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runTsconfigValidate } from "../checks/tsconfig-validate.ts";
import { runImportBoundariesValidate } from "../checks/import-boundaries-validate.ts";
import { runPhantomDepsValidate } from "../checks/phantom-deps-validate.ts";
import { runPackageExportsValidate } from "../checks/package-exports-validate.ts";
import { runStrictModeValidate } from "../checks/strict-mode-validate.ts";
import { runBarrelValidate } from "../checks/barrel-validate.ts";

describe("ts.tsconfig.validate", () => {
  it("returns pass on empty workspace (no packages directory)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-empty-"));
    try {
      const result = await runTsconfigValidate(tmp);
      expect(result.data?.status).toBe("pass");
      expect(result.data?.diagnostics).toHaveLength(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns fail when tsconfig.base.json is missing but packages exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-nobase-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg"), { recursive: true });
      const result = await runTsconfigValidate(tmp);
      expect(result.data?.status).toBe("fail");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns fail when strict is false in base config", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-nostrict-"));
    try {
      await writeFile(
        join(tmp, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: { strict: false, moduleResolution: "Bundler", target: "ES2022" },
        }),
      );
      const result = await runTsconfigValidate(tmp);
      expect(result.data?.status).toBe("fail");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-TSCONFIG-02")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns pass when base config has strict:true and no per-package configs", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-valid-"));
    try {
      await writeFile(
        join(tmp, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: { strict: true, moduleResolution: "Bundler", target: "ES2022" },
        }),
      );
      const result = await runTsconfigValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ts.import.boundaries.validate", () => {
  it("returns pass on empty workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-imp-empty-"));
    try {
      const result = await runImportBoundariesValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns fail when packages file imports from apps", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-imp-violation-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "src", "index.ts"),
        'import { foo } from "apps/my-app/src/foo";',
      );
      const result = await runImportBoundariesValidate(tmp);
      expect(result.data?.status).toBe("fail");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-IMPORT-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns pass when packages file has no boundary violations", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-imp-clean-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "src", "index.ts"),
        'import { foo } from "./foo";',
      );
      const result = await runImportBoundariesValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ts.phantom.deps.validate", () => {
  it("returns pass on empty workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-phantom-empty-"));
    try {
      const result = await runPhantomDepsValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns fail when import is not in dependencies", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-phantom-violation-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "package.json"),
        JSON.stringify({ name: "my-pkg", dependencies: {} }),
      );
      await writeFile(
        join(tmp, "packages", "my-pkg", "src", "index.ts"),
        'import { z } from "zod";',
      );
      const result = await runPhantomDepsValidate(tmp);
      expect(result.data?.status).toBe("fail");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-PHANTOM-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns pass when import is in dependencies", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-phantom-clean-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "package.json"),
        JSON.stringify({ name: "my-pkg", dependencies: { zod: "^3.0.0" } }),
      );
      await writeFile(
        join(tmp, "packages", "my-pkg", "src", "index.ts"),
        'import { z } from "zod";',
      );
      const result = await runPhantomDepsValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ts.package.exports.validate", () => {
  it("returns pass on empty workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exports-empty-"));
    try {
      const result = await runPackageExportsValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns fail when exports entry points to non-existent file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exports-violation-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "package.json"),
        JSON.stringify({
          name: "my-pkg",
          exports: {
            ".": "./src/index.ts",
          },
        }),
      );
      const result = await runPackageExportsValidate(tmp);
      expect(result.data?.status).toBe("fail");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-EXPORTS-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns pass when exports entry points to existing file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exports-clean-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(join(tmp, "packages", "my-pkg", "src", "index.ts"), "export {}");
      await writeFile(
        join(tmp, "packages", "my-pkg", "package.json"),
        JSON.stringify({
          name: "my-pkg",
          exports: {
            ".": "./src/index.ts",
          },
        }),
      );
      const result = await runPackageExportsValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ts.strict.mode.validate", () => {
  it("returns pass on empty workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-strict-empty-"));
    try {
      const result = await runStrictModeValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns warn when unescaped any is found", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-strict-any-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(join(tmp, "packages", "my-pkg", "src", "index.ts"), "const x: any = 42;");
      const result = await runStrictModeValidate(tmp);
      expect(result.data?.status).toBe("warn");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-STRICT-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ts.barrel.validate", () => {
  it("returns pass on empty workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-barrel-empty-"));
    try {
      const result = await runBarrelValidate(tmp);
      expect(result.data?.status).toBe("pass");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns warn when barrel re-exports Node-only module", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-barrel-violation-"));
    try {
      await mkdir(join(tmp, "packages", "my-pkg", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "my-pkg", "src", "index.ts"),
        'export { readFile } from "node:fs/promises";',
      );
      const result = await runBarrelValidate(tmp);
      expect(result.data?.status).toBe("warn");
      expect(result.data?.diagnostics.some((d) => d.ruleId === "TS-BARREL-01")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
