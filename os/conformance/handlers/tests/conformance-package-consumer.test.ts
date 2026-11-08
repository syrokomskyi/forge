/*
<MODULE_CONTRACT>
<purpose>Prove RFC-1539 package consumers: consumer.package runs the installed validator bin, never self-skips, and forge.conformance.validate enforces CONF-07/08/09.</purpose>
<non-goals><item>Do not re-test the RFC-1365 root-form legs (conformance.test.ts owns them).</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1539: package consumer tests</item>
  <item>RFC-1539: package-sourced specs and published consumer validators in Forge</item>
  <item>RFC-1539: amend dna-55 and dna-115 for published spec packages

Guides, fo-spec-ingest routing, command descriptions and regenerated command docs, remediation entries for SPEC-15..18 and CONF-07..09; resyncs the stale .agents fo-system-dispatch mirror (ADR-0126 source line).</item>
</CHANGE_SUMMARY>
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runProducerConformance,
  type ContractProducerDecl,
} from "../../../../src/conformance/index.ts";
import { runConformanceValidate } from "../conformance-validate.ts";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

const NODE = process.execPath;
const PKG = "@acme/intake-validator";
const EMIT = `require("node:fs").writeFileSync(require("node:path").join(process.argv[1],"bundle.txt"),"x")`;

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "conformance-pkg-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function ctx(): ForgeRuntimeContext {
  const noop = () => {};
  return {
    workspaceRoot: ws,
    dryRun: false,
    outputFormat: "json",
    logger: { section: noop, info: noop, warn: noop, error: noop, success: noop },
  } as ForgeRuntimeContext;
}

/** Install a fake validator package with an `intake-validate` bin that exits `code` when bundle.txt exists. */
function installValidator(opts: { conformanceValidator?: boolean; bin?: boolean } = {}): void {
  const dir = join(ws, "node_modules", ...PKG.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: PKG,
      version: "1.0.0",
      ...(opts.conformanceValidator ? { forge: { conformanceValidator: true } } : {}),
    }),
  );
  if (opts.bin === false) return;
  const binDir = join(ws, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "intake-validate");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${NODE}" -e 'const f=require("node:path").join(process.argv.at(-1),"bundle.txt");process.exit(require("node:fs").existsSync(f)?0:4)' -- "$2"\n`,
  );
  chmodSync(bin, 0o755);
}

function rootManifest(devDependencies: Record<string, string>): void {
  writeFileSync(
    join(ws, "package.json"),
    JSON.stringify({ name: "producer", private: true, devDependencies }),
  );
}

function packageDecl(): ContractProducerDecl {
  return {
    id: "intake",
    emit: { argv: [NODE, "-e", EMIT, "{bundle}"] },
    consumer: { package: PKG, validator: { argv: ["intake-validate", "--bundle", "{bundle}"] } },
    test: "conformance.test.ts",
  };
}

function writeForgeYaml(consumerYaml: string): void {
  writeFileSync(
    join(ws, "forge.yaml"),
    `schema: forge/config@1
project:
  name: producer
paths: {}
contractProducers:
  - id: intake
    emit:
      argv: ["${NODE}", "-e", "1", "{bundle}"]
    consumer:
${consumerYaml}
      validator:
        argv: ["intake-validate", "--bundle", "{bundle}"]
    test: conformance.test.ts
`,
  );
}

describe("runProducerConformance — consumer.package (RFC-1539)", () => {
  it("AC-10: runs the installed validator bin and passes", async () => {
    installValidator();
    const verdict = await runProducerConformance(packageDecl(), { repoRoot: ws });
    expect(verdict.status).toBe("pass");
    expect(verdict.legs.map((l) => [l.leg, l.status])).toEqual([
      ["emit", "pass"],
      ["consumer", "pass"],
    ]);
  });

  it("a failing validator fails the consumer leg", async () => {
    installValidator();
    const d = packageDecl();
    d.emit = {
      argv: [
        NODE,
        "-e",
        `require("node:fs").writeFileSync(require("node:path").join(process.argv[1],"other.txt"),"x")`,
        "{bundle}",
      ],
    };
    const verdict = await runProducerConformance(d, { repoRoot: ws });
    expect(verdict).toMatchObject({ status: "fail", failedLeg: "consumer" });
  });

  it("AC-11: an absent package fails and never reports skipped", async () => {
    const verdict = await runProducerConformance(packageDecl(), { repoRoot: ws });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedLeg).toBe("consumer");
    expect(verdict.legs.some((l) => l.status === "skip")).toBe(false);
    expect(verdict.diagnostics.join(" ")).toContain("never self-skips");
  });
});

describe("forge.conformance.validate — CONF-07/08/09 (RFC-1539)", () => {
  const codes = async () =>
    (
      (await runConformanceValidate({ argv: [], flags: {} }, ctx())).data as {
        diagnostics: { ruleId: string; severity: string }[];
      }
    ).diagnostics;

  it("AC-12: CONF-07 fails a range-pinned consumer package", async () => {
    installValidator();
    rootManifest({ [PKG]: "^1.0.0" });
    writeForgeYaml(`      package: "${PKG}"`);
    expect(await codes()).toContainEqual(
      expect.objectContaining({ ruleId: "CONF-07", severity: "error" }),
    );
  });

  it("an exact pin with an installed bin raises neither CONF-07 nor CONF-08", async () => {
    installValidator();
    rootManifest({ [PKG]: "1.0.0" });
    writeForgeYaml(`      package: "${PKG}"`);
    const ids = (await codes()).map((d) => d.ruleId);
    expect(ids).not.toContain("CONF-07");
    expect(ids).not.toContain("CONF-08");
  });

  it("AC-13: CONF-08 fails an uninstalled package", async () => {
    rootManifest({ [PKG]: "1.0.0" });
    writeForgeYaml(`      package: "${PKG}"`);
    expect(await codes()).toContainEqual(
      expect.objectContaining({ ruleId: "CONF-08", severity: "error" }),
    );
  });

  it("AC-13: CONF-08 fails an installed package without the argv[0] bin", async () => {
    installValidator({ bin: false });
    rootManifest({ [PKG]: "1.0.0" });
    writeForgeYaml(`      package: "${PKG}"`);
    expect(await codes()).toContainEqual(expect.objectContaining({ ruleId: "CONF-08" }));
  });

  it("AC-14: CONF-09 warns on consumer.root while a published conformance validator is installed", async () => {
    installValidator({ conformanceValidator: true });
    rootManifest({ [PKG]: "1.0.0" });
    mkdirSync(join(ws, "consumer"));
    writeForgeYaml(`      root: ./consumer`);
    expect(await codes()).toContainEqual(
      expect.objectContaining({ ruleId: "CONF-09", severity: "warning" }),
    );
  });

  it("no CONF-09 for consumer.root without a published validator", async () => {
    installValidator();
    rootManifest({ [PKG]: "1.0.0" });
    mkdirSync(join(ws, "consumer"));
    writeForgeYaml(`      root: ./consumer`);
    expect((await codes()).map((d) => d.ruleId)).not.toContain("CONF-09");
  });
});
