/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac8-ac9-registry-reachability) — authored inside
rfc.verify.workspace by the clean-context verifier, not by the implementer.
Derives its expectation from the RFC text and the observable behavior of the
real handlers/runner it exercises.
</purpose>
<non-goals>
  <item>Do not treat as implementer-authored evidence — its expectationSource is independent.</item>
  <item>Do not edit to fit the code — a failure here is a counterexample, fix the implementation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 r1 verification: independent check ac8-ac9-registry-reachability.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-8 — "`proof.check` SHALL be registered in the kernel command
// registry." AC-9 — "`proof.check` SHALL be reachable (from a pipeline or a
// declared coverage entry)."
//
// Independent check: instantiate the real `createForgeFormalModule()` factory
// (the same call packages/forge/bin/cli.ts makes when building the operator
// registry — cli.ts loops `registry.registerCommand(cmd)` over
// module.commands), verify the command definition it contributes, then prove
// the kernel-host path: WORKSHOP_MODULE_MAP descriptor + the @warpgogol/forge
// package-exports resolution to the real module file. AC-9 is exercised for
// real: `rfc.acceptance.run` runs a `probe: proof` through the same shared
// `runProofCheck` the command uses, and the generated command manifest shows
// the declared coverage entry (operator).

import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { createForgeFormalModule } from "../../../formal/formal.module.ts";
import { runRfcAcceptanceRun } from "../../acceptance.ts";
import { runProofCheckCommand } from "../../../formal/handlers/proof-check.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import { ctx, exhaustiveSpec, EXPORT_ROOT, FORGE_ROOT, put, rfcMd } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

describe("AC-8: proof.check registered in the kernel command registry", () => {
  it("the forge-formal module contributes a real proof.check command definition", async () => {
    const mod = await createForgeFormalModule();
    expect(mod.name).toBe("forge-formal");
    const cmd = mod.commands.find((c) => c.name === "proof.check");
    expect(cmd).toBeDefined();
    // The registered definition is the real handler, not a stub.
    expect(cmd!.execute).toBe(runProofCheckCommand);
    expect(cmd!.flags?.["spec"]).toMatchObject({ kind: "string", required: true });
    // And the CLI registers every module command — verify that loop exists.
    const cli = readFileSync(join(FORGE_ROOT, "bin/cli.ts"), "utf8");
    expect(cli).toContain("createForgeFormalModule()");
    expect(cli).toMatch(
      /for \(const cmd of mod\.commands\)\s*\{[\s\S]*?registry\.registerCommand\(cmd\)/,
    );
  });

  it("kernel-host path: WORKSHOP_MODULE_MAP + package exports resolve the module", async () => {
    // werkstatt-engine is intentionally NOT a forge dependency — the
    // registration is verified on the module-map source text, same way the
    // cli.ts registration is verified above.
    const mapSrc = readFileSync(
      join(EXPORT_ROOT, "packages/werkstatt-engine/src/kernel/module-map.ts"),
      "utf8",
    );
    expect(mapSrc).toMatch(
      /"forge-formal"\s*:\s*forge\(\s*"os\/formal-module"\s*,\s*"createForgeFormalModule"\s*\)/,
    );
    const pkg = JSON.parse(readFileSync(join(FORGE_ROOT, "package.json"), "utf8"));
    const exp = pkg.exports["./os/formal-module"];
    expect(exp).toBeDefined();
    const target = join(FORGE_ROOT, exp.default);
    expect(existsSync(target)).toBe(true);
    // The exported factory in that file is the one we instantiated above.
    expect(readFileSync(target, "utf8")).toContain("export async function createForgeFormalModule");
  });

  it("generated command manifest lists proof.check under forge-formal", () => {
    const manifest = readFileSync(
      join(EXPORT_ROOT, "docs/command-manifest.generated.yaml"),
      "utf8",
    );
    const docs = yamlParse(manifest);
    const commands = (docs?.commands ?? []) as Array<{ name: string; module: string }>;
    const hit = commands.find((c) => c.name === "proof.check");
    expect(hit).toBeDefined();
    expect(hit!.module).toBe("forge-formal");
  });
});

describe("AC-9: proof.check reachable via declared coverage + the real probe path", () => {
  it("manifest records a declared coverage reachability entry", () => {
    const manifest = readFileSync(
      join(EXPORT_ROOT, "docs/command-manifest.generated.yaml"),
      "utf8",
    );
    const docs = yamlParse(manifest);
    const commands = (docs?.commands ?? []) as Array<{
      name: string;
      coverage?: string;
      reachableVia?: Array<{ kind: string; ref: string }>;
    }>;
    const hit = commands.find((c) => c.name === "proof.check")!;
    expect(hit.coverage).toBe("operator");
    expect(
      (hit.reachableVia ?? []).some((r) => r.kind === "coverage" && r.ref === "operator"),
    ).toBe(true);
  });

  it("probe: proof reaches the checker through rfc.acceptance.run (proved verdict → ok)", async () => {
    // workspaceRoot = packages/forge: the exhaustive runner spawns
    // `pnpm exec vitest run <entry>` there. Temp fixture files land inside the
    // real tree and are removed on cleanup.
    const specRel = "os/rfc/verifier/rfc-1391/fixtures/proof-ac9.proof.yaml";
    const rfcRel = "docs/rfcs/rfc-9010-ac9.md";
    const entryRel = "os/rfc/verifier/rfc-1391/fixtures/small-domain.proof.test.ts";
    put(FORGE_ROOT, specRel, exhaustiveSpec({ id: "PROOF-ac9", entry: entryRel, cardinality: 3 }));
    put(
      FORGE_ROOT,
      rfcRel,
      rfcMd({
        id: "RFC-9010",
        probesYaml: `  - probe: proof\n    criterion: AC-1\n    spec: "${specRel}"\n    expectationSource: self\n`,
        criteria: [
          "AC-1: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-1)",
        ],
      }),
    );
    for (const rel of [specRel, rfcRel]) {
      cleanups.push(() => {
        try {
          rmSync(join(FORGE_ROOT, rel), { force: true });
        } catch {
          /* best effort */
        }
      });
    }
    // packages/forge/docs is real content — only the rfcs subdir we created
    // may be pruned, and only if nothing else landed there.
    cleanups.push(() => {
      try {
        rmdirSync(join(FORGE_ROOT, "docs/rfcs"));
      } catch {
        /* best effort — leaves the dir if non-empty */
      }
    });

    const res = await runRfcAcceptanceRun(input({ id: "RFC-9010" }), ctx(FORGE_ROOT));
    expect(res.exitCode).toBe(0);
    const rec = res.data?.results?.find((r) => r.rfcId === "RFC-9010")?.probeResults?.[0];
    expect(rec).toBeDefined();
    expect(rec!.ok).toBe(true);
    expect(rec!.proof?.verdict).toBe("proved");
    expect(rec!.proof?.tool).toBe("exhaustive");
  }, 120_000);
});
