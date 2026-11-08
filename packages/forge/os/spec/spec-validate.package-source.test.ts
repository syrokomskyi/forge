/*
<MODULE_CONTRACT>
<purpose>Prove RFC-1539 package-sourced specs: specPackages[] resolution, SPEC-01 on installed files, amendment rules skipped, SPEC-15..18, spec.status source reporting.</purpose>
<non-goals><item>Do not re-test the vendored rule set (spec-validate.test.ts owns it).</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1539: package-sourced spec tests</item>
  <item>RFC-1539: package-sourced specs and published consumer validators in Forge</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeRuntimeContext } from "../../src/types.ts";
import { byteHash } from "../../src/utils/hash.ts";
import { runSpecValidate } from "./spec-validate.ts";
import { runSpecStatus } from "./spec-status.ts";
import { listSpecSources, resolveSpecSource } from "../../src/spec/resolve-spec-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const PKG = "@acme/demo-spec";
const README = "# Demo spec\n";

function forgeSpec(version: string): string {
  return `schema: forge/spec@1
id: demo-spec-v${version}
title: Demo
version: ${version}
status: accepted
reviewers: []
sourceNote: test fixture
vendoredAt: 2026-11-08
documents: {}
decisions: []
rfcs: []
waves: []
`;
}

async function writeSpecDir(dir: string, version: string, readme = README): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "forge-spec.yaml"), forgeSpec(version));
  await fs.writeFile(path.join(dir, "README.md"), readme);
  await fs.writeFile(
    path.join(dir, "integrity.yaml"),
    `schema: forge/spec-integrity@1\nfiles:\n  "README.md": ${byteHash(README)}\n`,
  );
}

async function workspace(opts: {
  pin?: string | null;
  install?: boolean;
  declare?: string;
  vendored?: string;
  tamper?: boolean;
} = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spec-pkg-"));
  roots.push(root);
  const declare =
    opts.declare ?? `specPackages:\n  - id: demo-spec\n    package: "${PKG}"\n`;
  await fs.writeFile(
    path.join(root, "forge.yaml"),
    `schema: forge/config@1\nproject:\n  name: ws\n  consumer: werkstatt\npaths: {}\n${declare}`,
  );
  const pin = opts.pin === undefined ? "0.1.9" : opts.pin;
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "ws", private: true, dependencies: pin === null ? {} : { [PKG]: pin } }),
  );
  if (opts.install !== false) {
    const dir = path.join(root, "node_modules", ...PKG.split("/"));
    await writeSpecDir(dir, "0.1.9", opts.tamper ? "# tampered\n" : README);
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: PKG, version: "0.1.9" }));
  }
  if (opts.vendored) {
    await writeSpecDir(path.join(root, "docs/specs", `demo-spec-v${opts.vendored}`), opts.vendored);
  }
  return root;
}

function ctx(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    dryRun: false,
    outputFormat: "json",
    logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
  } as ForgeRuntimeContext;
}

const rules = (r: Awaited<ReturnType<typeof runSpecValidate>>) =>
  r.data!.specs.flatMap((s) => s.violations.map((v) => v.rule));

describe("resolver (RFC-1539)", () => {
  it("AC-1: resolves a declared package as <id>-v<installed version>", async () => {
    const root = await workspace();
    const source = resolveSpecSource(root, "demo-spec");
    expect(source).toMatchObject({ kind: "package", specId: "demo-spec-v0.1.9", package: PKG, version: "0.1.9" });
    expect(resolveSpecSource(root, "demo-spec-v0.1.9").kind).toBe("package");
  });

  it("refuses a spec id whose version differs from the installed package", async () => {
    const root = await workspace();
    expect(() => resolveSpecSource(root, "demo-spec-v0.1.5")).toThrow(/installed version is demo-spec-v0.1.9/);
  });

  it("AC-2: a duplicate specPackages id fails with SPEC-18", async () => {
    const root = await workspace({
      declare: `specPackages:\n  - id: demo-spec\n    package: "${PKG}"\n  - id: demo-spec\n    package: "${PKG}"\n`,
    });
    expect(listSpecSources(root).diagnostics.map((d) => d.rule)).toContain("SPEC-18");
  });
});

describe("spec.validate over package sources (RFC-1539)", () => {
  it("AC-3: validates an installed package and reports its source", async () => {
    const root = await workspace();
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(root));
    expect(result.exitCode).toBe(0);
    const spec = result.data!.specs.find((s) => s.id === "demo-spec-v0.1.9")!;
    expect(spec.source).toEqual({ kind: "package", package: PKG, version: "0.1.9" });
    expect(spec.violations).toEqual([]);
  });

  it("AC-4: SPEC-01 detects a tampered file inside the installed package", async () => {
    const root = await workspace({ tamper: true });
    const result = await runSpecValidate({ argv: [], flags: { spec: "demo-spec-v0.1.9" } }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(rules(result)).toContain("SPEC-01");
  });

  it("AC-5: amendment rules do not run for a package-sourced spec", async () => {
    const root = await workspace();
    const dir = path.join(root, "node_modules", ...PKG.split("/"), "amendments");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AMD-001.yaml"), "not: [valid amendment");
    const result = await runSpecValidate({ argv: [], flags: { spec: "demo-spec-v0.1.9" } }, ctx(root));
    expect(rules(result).filter((r) => /SPEC-(0[89]|1[01]|14)/.test(r))).toEqual([]);
  });

  it("AC-6: SPEC-15 warns for a vendored copy of a declared spec package", async () => {
    const root = await workspace({ vendored: "0.1.5" });
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(root));
    const vendored = result.data!.specs.find((s) => s.id === "demo-spec-v0.1.5")!;
    expect(vendored.source).toEqual({ kind: "vendored" });
    expect(vendored.violations).toContainEqual(expect.objectContaining({ rule: "SPEC-15", severity: "warning" }));
    expect(result.exitCode).toBe(0);
  });

  it("AC-7: SPEC-16 fails for a declared package that is not installed", async () => {
    const root = await workspace({ install: false });
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(rules(result)).toContain("SPEC-16");
  });

  it("AC-8: SPEC-17 fails for a range-pinned spec package", async () => {
    for (const pin of ["^0.1.9", "~0.1.9", "*", "latest"]) {
      const root = await workspace({ pin });
      const result = await runSpecValidate({ argv: [], flags: {} }, ctx(root));
      expect(rules(result), pin).toContain("SPEC-17");
    }
  });

  it("--spec naming another version of a package-sourced spec fails with the installed version", async () => {
    const root = await workspace({ vendored: "0.1.5" });
    const result = await runSpecValidate({ argv: [], flags: { spec: "demo-spec-v0.1.5" } }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("installed version is demo-spec-v0.1.9");
  });
});

describe("spec.status over package sources (RFC-1539)", () => {
  it("AC-9: reports source.kind for every spec", async () => {
    const root = await workspace({ vendored: "0.1.5" });
    const result = await runSpecStatus({ argv: [], flags: {} }, ctx(root));
    const kinds = Object.fromEntries(
      (result.data as { specs: { id: string; source: { kind: string } }[] }).specs.map((s) => [s.id, s.source.kind]),
    );
    expect(kinds).toEqual({ "demo-spec-v0.1.5": "vendored", "demo-spec-v0.1.9": "package" });
  });
});
