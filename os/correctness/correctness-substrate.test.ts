/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-4: CORR-06 seam substrate minimums — L0 never satisfies data/lifecycle/provider; lifecycle needs L2.</purpose>
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

import { validateCorrectnessManifest } from "./handlers/validate.ts";
import { BASE_MANIFEST, makeWorkspace } from "./tests/fixture-workspace.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const run = async (manifest: string) => {
  const w = makeWorkspace({ manifest });
  cleanups.push(w.cleanup);
  return validateCorrectnessManifest(w.root);
};

describe("CORR-06 substrate minimums", () => {
  it("AC-4: a data entry whose only oracle is L0 is a CORR-06 error", async () => {
    const res = await run(BASE_MANIFEST.replace("substrate: L1", "substrate: L0"));
    const v = res.violations.find((x) => x.rule === "CORR-06");
    expect(v, "seam data requires L1 — an L0 double must never satisfy it").toBeDefined();
    expect(v!.severity).toBe("error");
    expect(v!.entry).toBe("CM-dispatch-01");
    expect(res.status).toBe("fail");
  });

  it("a data entry with an L1 oracle passes CORR-06", async () => {
    const res = await run(BASE_MANIFEST);
    expect(res.violations.filter((x) => x.rule === "CORR-06")).toEqual([]);
  });

  it("a lifecycle entry needs L2 — L1 is not enough", async () => {
    const res = await run(BASE_MANIFEST.replace("seam: data", "seam: lifecycle"));
    expect(res.violations.find((x) => x.rule === "CORR-06")?.message).toMatch(
      /requires L2; best oracle is L1/,
    );
  });

  it("a provider entry with an L1 oracle and no capture fails", async () => {
    const res = await run(BASE_MANIFEST.replace("seam: data", "seam: provider"));
    expect(res.violations.find((x) => x.rule === "CORR-06")?.message).toMatch(
      /provider requires L3/,
    );
  });

  it("seam other accepts L0", async () => {
    const res = await run(
      BASE_MANIFEST.replace("seam: data", "seam: other").replace("substrate: L1", "substrate: L0"),
    );
    expect(res.violations.filter((x) => x.rule === "CORR-06")).toEqual([]);
  });
});
