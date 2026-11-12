/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-6: correctness.mode — exempt reports status exempt with no findings; exempt plus a manifest binding, and invalid mode/tier values, are CORR-02; enforce requires checkRun (CORR-01).</purpose>
<non-goals>
  <item>Not a contract source of truth — the handler owns behaviour; fixtures are minimal.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial suite.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessManifestValidate } from "./handlers/validate.ts";
import { validateCorrectnessManifest } from "./handlers/validate.ts";
import { makeWorkspace } from "./tests/fixture-workspace.ts";
import type { ForgeRuntimeContext } from "../../src/types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const ws = (opts: Parameters<typeof makeWorkspace>[0]) => {
  const w = makeWorkspace(opts);
  cleanups.push(w.cleanup);
  return w.root;
};

const context = (root: string): ForgeRuntimeContext => ({
  workspaceRoot: root,
  dryRun: false,
  outputFormat: "json",
  logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
});

describe("correctness.mode", () => {
  it("AC-6: mode exempt reports status exempt and exits 0 without findings", async () => {
    const root = ws({
      mode: "exempt",
      manifestBinding: null,
      manifest: null,
      requirements: ["REQ-01", "REQ-02"],
    });
    const res = await runCorrectnessManifestValidate({ argv: [], flags: {} }, context(root));
    expect(res.data!.status).toBe("exempt");
    expect(res.data!.violations).toEqual([]);
    expect(res.exitCode).toBe(0);
  });

  it("exempt together with a manifest binding is CORR-02", async () => {
    const res = await validateCorrectnessManifest(ws({ mode: "exempt" }));
    expect(res.status).toBe("fail");
    expect(res.violations.map((v) => v.rule)).toEqual(["CORR-02"]);
  });

  it("invalid mode and tier values are CORR-02 errors", async () => {
    const res = await validateCorrectnessManifest(ws({ mode: "strict", tier: "ultra" }));
    const msgs = res.violations.filter((v) => v.rule === "CORR-02").map((v) => v.message);
    expect(msgs.some((m) => /correctness.mode "strict"/.test(m))).toBe(true);
    expect(msgs.some((m) => /correctness.tier "ultra"/.test(m))).toBe(true);
  });

  it("enforce without checkRun is a CORR-01 error; warn without a binding is a CORR-01 warning", async () => {
    const enforce = await validateCorrectnessManifest(ws({ mode: "enforce", checkRun: null }));
    expect(enforce.violations.find((v) => v.rule === "CORR-01")?.severity).toBe("error");
    const warn = await validateCorrectnessManifest(ws({ manifestBinding: null, manifest: null }));
    expect(warn.mode).toBe("warn");
    expect(warn.violations.find((v) => v.rule === "CORR-01")?.severity).toBe("warning");
    expect(warn.status).toBe("pass");
  });

  it("an absent mode defaults to warn and tier to standard", async () => {
    const res = await validateCorrectnessManifest(ws({}));
    expect(res.mode).toBe("warn");
    expect(res.tier).toBe("standard");
    expect(res.status).toBe("pass");
  });
});
