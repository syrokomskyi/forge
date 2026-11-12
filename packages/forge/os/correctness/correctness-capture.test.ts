/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-5: CORR-07 capture provenance — an expired, incomplete, or missing sidecar is an error; near expiry is a warning; a fresh capture lets L1 stand in for L3.</purpose>
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

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const CAPTURE = "test/captures/draft.json";

const PROVIDER_MANIFEST = BASE_MANIFEST.replace("seam: data", "seam: provider").replace(
  "substrate: L1",
  `substrate: L1\n        captures: [${CAPTURE}]`,
);

const sidecar = (recordedAt: string, ttlDays = 30, extra = "") =>
  `schema: forge/correctness-capture@1\nrecordedAt: ${recordedAt}\nprovider: workers-ai\nmodel: "@cf/meta/llama"\nttlDays: ${ttlDays}\norigin: "L3 run"\n${extra}`;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const run = async (files: Record<string, string>) => {
  const w = makeWorkspace({ manifest: PROVIDER_MANIFEST, files });
  cleanups.push(w.cleanup);
  return validateCorrectnessManifest(w.root, { now: NOW });
};

describe("CORR-07 capture provenance", () => {
  it("AC-5: a sidecar recordedAt older than ttlDays is a CORR-07 error", async () => {
    const res = await run({
      [CAPTURE]: "{}",
      [`${CAPTURE}.capture.yaml`]: sidecar(new Date(NOW - 45 * DAY).toISOString()),
    });
    const v = res.violations.find((x) => x.rule === "CORR-07");
    expect(v, "a 45-day-old capture with ttlDays 30 must be refused").toBeDefined();
    expect(v!.severity).toBe("error");
    expect(v!.message).toMatch(/past its ttlDays 30/);
    // The stale capture no longer lets the L1 oracle stand in for L3.
    expect(res.violations.some((x) => x.rule === "CORR-06")).toBe(true);
  });

  it("a fresh capture passes and satisfies the provider minimum", async () => {
    const res = await run({
      [CAPTURE]: "{}",
      [`${CAPTURE}.capture.yaml`]: sidecar(new Date(NOW - 2 * DAY).toISOString()),
    });
    expect(res.violations.filter((x) => x.rule === "CORR-07" || x.rule === "CORR-06")).toEqual([]);
  });

  it("a capture within 7 days of expiry warns", async () => {
    const res = await run({
      [CAPTURE]: "{}",
      [`${CAPTURE}.capture.yaml`]: sidecar(new Date(NOW - 25 * DAY).toISOString()),
    });
    const v = res.violations.find((x) => x.rule === "CORR-07");
    expect(v?.severity).toBe("warning");
    expect(res.violations.some((x) => x.rule === "CORR-06")).toBe(false);
  });

  it("a missing sidecar and a sidecar without model are errors", async () => {
    const missing = await run({ [CAPTURE]: "{}" });
    expect(missing.violations.find((x) => x.rule === "CORR-07")?.message).toMatch(/no sidecar/);
    const noModel = await run({
      [CAPTURE]: "{}",
      [`${CAPTURE}.capture.yaml`]: sidecar(new Date(NOW).toISOString()).replace(/model: .*\n/, ""),
    });
    expect(noModel.violations.find((x) => x.rule === "CORR-07")?.message).toMatch(/model/);
  });

  it("the extension-less sidecar spelling is accepted", async () => {
    const res = await run({
      [CAPTURE]: "{}",
      "test/captures/draft.capture.yaml": sidecar(new Date(NOW - DAY).toISOString()),
    });
    expect(res.violations.filter((x) => x.rule === "CORR-07")).toEqual([]);
  });
});
