/*
<MODULE_CONTRACT>
<purpose>
RFC-1453: RFC-IMP-14 gate tests — outcome-surface diffs require a passing
outcome probe (AC-5), untouched surfaces skip the gate (AC-6), and
--waive-outcome converts the block into a recorded warning (AC-7). Covers
the run-probe/outcomeBuild normalization and the unresolved-range fallback
to the implementation commit's own changed file set.
</purpose>
<non-goals>
  <item>Do not exercise real git — OriginGit is stubbed; diff derivation is covered by verification-origin tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1453: RFC-IMP-14 outcome gate unit tests.</item>
  <item>RFC-1453: executed outcome probes, IMP-14 surface gate, outcome.serve + V-47/V-48</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import {
  evaluateOutcomeGate,
  normalizeOutcomeBuildCommand,
  runProbeMatchesOutcomeBuild,
} from "./implement-stamp-outcome.ts";
import type { OriginGit } from "../verification-origin.ts";
import type { AcceptanceProbe, VerificationEvidenceProbeRecord } from "../types.ts";

const SURFACES = ["packages/ui/**"];

const pageProbe: AcceptanceProbe = {
  probe: "page",
  target: "site-a",
  path: "/",
  selector: "header .lang-switcher__link",
  criterion: "AC-1",
};

const runProbe: AcceptanceProbe = {
  probe: "run",
  command: "werkstatt run mission.validate --site site-a --json",
  expect: { exitCode: 0 },
  criterion: "AC-2",
};

const record = (
  probe: AcceptanceProbe,
  verdict: "pass" | "fail" | "unverified",
): VerificationEvidenceProbeRecord => ({
  probe,
  ok: verdict === "pass",
  verdict,
  detail: "fixture",
  durationMs: 0,
});

/** Fake OriginGit — resolves the range from `base`, serves `files` for diff/show. */
function fakeGit(opts: { base?: string | null; files: string[] }): OriginGit {
  return {
    run: async (args: string[]) => {
      if (args[0] === "rev-parse") return "headsha\n";
      if (args[0] === "log") return opts.base ? `${opts.base}\n` : "";
      if (args[0] === "diff") return opts.files.join("\n") + "\n";
      if (args[0] === "show") return opts.files.join("\n") + "\n";
      return null;
    },
  };
}

const gate = (over: Partial<Parameters<typeof evaluateOutcomeGate>[0]> = {}) =>
  evaluateOutcomeGate({
    targetId: "RFC-9001",
    probes: [pageProbe],
    evidenceRecords: [record(pageProbe, "pass")],
    git: fakeGit({ base: "basesha", files: ["packages/ui/button.ts"] }),
    rfcRelPath: "docs/rfcs/rfc-9001-x.md",
    implementationCommit: "implsha",
    outcomeSurfaces: SURFACES,
    outcomeBuild: "pnpm exec werkstatt run mission.validate --site {target} --json",
    ...over,
  });

describe("RFC-IMP-14 outcome gate (AC-5)", () => {
  it("blocks when the diff touches an outcome surface and no outcome probe passed", async () => {
    const res = await gate({ evidenceRecords: [record(pageProbe, "fail")] });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.rule).toBe("RFC-IMP-14");
    expect(res.errors[0]?.message).toContain("packages/ui/button.ts");
  });

  it("blocks when the only page probe is unverified — unverified is not pass", async () => {
    const res = await gate({ evidenceRecords: [record(pageProbe, "unverified")] });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.rule).toBe("RFC-IMP-14");
  });

  it("passes when a page probe passed", async () => {
    const res = await gate();
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.waived).toBe(false);
  });

  it("passes on a `run` probe equal to the normalized outcomeBuild binding", async () => {
    const res = await gate({
      probes: [runProbe],
      evidenceRecords: [record(runProbe, "pass")],
    });
    expect(res.errors).toEqual([]);
  });

  it("a `run` probe that is not the outcomeBuild binding does not satisfy the gate", async () => {
    const otherRun: AcceptanceProbe = {
      probe: "run",
      command: "werkstatt run some.other --site site-a",
      expect: { exitCode: 0 },
      criterion: "AC-2",
    };
    const res = await gate({
      probes: [otherRun],
      evidenceRecords: [record(otherRun, "pass")],
    });
    expect(res.errors).toHaveLength(1);
  });

  it("uses the implementation commit's file set when no accepted base resolves", async () => {
    const res = await gate({
      git: fakeGit({ base: null, files: ["packages/ui/x.ts"] }),
      evidenceRecords: [record(pageProbe, "unverified")],
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.rule).toBe("RFC-IMP-14");
  });
});

describe("RFC-IMP-14 outcome gate (AC-6)", () => {
  it("does not evaluate when no outcomeSurfaces are declared", async () => {
    const res = await gate({ outcomeSurfaces: [], evidenceRecords: [] });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("does not evaluate when the diff touches no surface", async () => {
    const res = await gate({
      git: fakeGit({ base: "basesha", files: ["packages/core/x.ts", "docs/rfcs/rfc-9001-x.md"] }),
      evidenceRecords: [],
    });
    expect(res.errors).toEqual([]);
  });
});

describe("RFC-IMP-14 outcome gate (AC-7)", () => {
  it("converts the block into a recorded warning under --waive-outcome", async () => {
    const res = await gate({
      evidenceRecords: [record(pageProbe, "fail")],
      waiveOutcome: "pilot dist rebuild pending — operator approved",
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.rule).toBe("RFC-IMP-14");
    expect(res.warnings[0]?.message).toContain("X-Outcome-Waiver");
    expect(res.waived).toBe(true);
  });
});

describe("runProbeMatchesOutcomeBuild / normalizeOutcomeBuildCommand", () => {
  const binding = "pnpm exec werkstatt run mission.validate --site {target} --json";

  it("strips the pnpm exec prefix and substitutes {target}", () => {
    expect(normalizeOutcomeBuildCommand(binding)).toBe(
      "werkstatt run mission.validate --site {target} --json",
    );
    expect(runProbeMatchesOutcomeBuild("werkstatt run mission.validate --site dp7 --json", binding)).toBe(
      true,
    );
  });

  it("collapses whitespace differences", () => {
    expect(
      runProbeMatchesOutcomeBuild("werkstatt  run   mission.validate --site dp7 --json", binding),
    ).toBe(true);
  });

  it("rejects a different command", () => {
    expect(runProbeMatchesOutcomeBuild("werkstatt run other.cmd --site dp7", binding)).toBe(false);
  });

  it("rejects when the binding is absent", () => {
    expect(runProbeMatchesOutcomeBuild("werkstatt run mission.validate --site dp7 --json", null)).toBe(
      false,
    );
  });
});
