/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for buildWorkspaceModel — glob expansion, exclusion
sets, symlink skip, and AST fact extraction per kind (RFC-1099).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: initial model tests at the public buildWorkspaceModel seam.</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceModel } from "./workspace-model.ts";

let root: string;

function writePkg(dir: string, name: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, dir, "package.json"),
    JSON.stringify({ name, dependencies: { react: "^19" } }),
  );
}

function writeSrc(dir: string, file: string, content: string): void {
  const full = join(root, dir, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-model-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildWorkspaceModel", () => {
  it("scans services/* packages by default", async () => {
    writePkg("services/api", "@svc/api");
    writeSrc("services/api", "src/index.ts", "export const x = 1;\n");

    const model = await buildWorkspaceModel(root);
    expect(model.packages.map((p) => p.dir)).toContain("services/api");
  });

  it("excludes node_modules, dist, .turbo and test files from parsing but records them in existingFiles", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc("packages/a", "src/index.ts", "export const x = 1;\n");
    writeSrc("packages/a", "src/index.test.ts", "import { x } from \"./index\";\n");
    writeSrc("packages/a", "dist/bundle.ts", "export const y = 2;\n");
    writeSrc("packages/a", ".turbo/cache.ts", "export const z = 3;\n");
    writeSrc("packages/a", "node_modules/dep/index.ts", "export const w = 4;\n");

    const model = await buildWorkspaceModel(root);
    const pkg = model.packages[0]!;
    const parsed = pkg.sourceFiles.map((f) => f.path);
    expect(parsed).toEqual(["packages/a/src/index.ts"]);
    // existingFiles records everything except node_modules (never descended)
    expect(pkg.existingFiles.has("packages/a/dist/bundle.ts")).toBe(true);
    expect(pkg.existingFiles.has("packages/a/.turbo/cache.ts")).toBe(true);
    expect(pkg.existingFiles.has("packages/a/node_modules/dep/index.ts")).toBe(false);
  });

  it("skips symlinked directories", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc("packages/a", "src/index.ts", "export const x = 1;\n");
    writePkg("packages/b", "@pkg/b");
    writeSrc("packages/b", "src/index.ts", "export const y = 2;\n");
    symlinkSync(join(root, "packages/b"), join(root, "packages/a/link"), "dir");

    const model = await buildWorkspaceModel(root);
    const pkgA = model.packages.find((p) => p.dir === "packages/a")!;
    expect(pkgA.sourceFiles.map((f) => f.path)).toEqual(["packages/a/src/index.ts"]);
  });

  it("extracts import kinds: static, type-only, side-effect, dynamic, require", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc(
      "packages/a",
      "src/index.ts",
      [
        'import { x } from "react";',
        'import type { T } from "./types";',
        'import "reflect-metadata";',
        'const m = await import("./lazy");',
        'const r = require("./cjs");',
      ].join("\n"),
    );

    const model = await buildWorkspaceModel(root);
    const file = model.packages[0]!.sourceFiles[0]!;
    const kinds = file.imports.map((i) => [i.specifier, i.kind]);
    expect(kinds).toEqual([
      ["react", "static"],
      ["./types", "type-only"],
      ["reflect-metadata", "side-effect"],
      ["./lazy", "dynamic"],
      ["./cjs", "require"],
    ]);
  });

  it("extracts reExports from export ... from", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc("packages/a", "src/index.ts", 'export { x } from "./mod";\nexport * from "./all";\n');

    const model = await buildWorkspaceModel(root);
    const file = model.packages[0]!.sourceFiles[0]!;
    expect(file.reExports.map((r) => r.specifier)).toEqual(["./mod", "./all"]);
  });

  it("extracts anyRefs for annotations and as-casts", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc(
      "packages/a",
      "src/index.ts",
      "const a: any = 1;\nconst b = foo as any;\n",
    );

    const model = await buildWorkspaceModel(root);
    const file = model.packages[0]!.sourceFiles[0]!;
    expect(file.anyRefs.map((r) => r.kind)).toEqual(["annotation", "as-cast"]);
  });

  it("marks @ts-ignore justified by trailing text or a leading comment", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc(
      "packages/a",
      "src/index.ts",
      [
        "// @ts-ignore — legacy API shape",
        "const a = bad();",
        "// reason: upstream types are wrong",
        "// @ts-ignore",
        "const b = bad();",
        "// @ts-ignore",
        "const c = bad();",
      ].join("\n"),
    );

    const model = await buildWorkspaceModel(root);
    const file = model.packages[0]!.sourceFiles[0]!;
    expect(file.suppressions.map((s) => s.justified)).toEqual([true, true, false]);
  });

  it("extracts exportedFunctions with hasReturnType and paramsTyped", async () => {
    writePkg("packages/a", "@pkg/a");
    writeSrc(
      "packages/a",
      "src/index.ts",
      [
        "export function typed(a: number): string { return String(a); }",
        "export function untyped(a: number) { return a; }",
        "export const arrow = (x: number): number => x;",
      ].join("\n"),
    );

    const model = await buildWorkspaceModel(root);
    const fns = model.packages[0]!.sourceFiles[0]!.exportedFunctions;
    expect(fns.map((f) => [f.name, f.hasReturnType, f.paramsTyped])).toEqual([
      ["typed", true, true],
      ["untyped", false, true],
      ["arrow", true, true],
    ]);
  });

  it("reads the workspace-root tsconfig.base.json into baseTsconfig", async () => {
    writeFileSync(
      join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writePkg("packages/a", "@pkg/a");

    const model = await buildWorkspaceModel(root);
    expect(model.baseTsconfig?.compilerOptions?.strict).toBe(true);
  });

  it("honours --globs override", async () => {
    writePkg("libs/x", "@lib/x");
    writeSrc("libs/x", "src/index.ts", "export const x = 1;\n");
    writePkg("packages/a", "@pkg/a");

    const model = await buildWorkspaceModel(root, ["libs/*"]);
    expect(model.packages.map((p) => p.dir)).toEqual(["libs/x"]);
  });
});
