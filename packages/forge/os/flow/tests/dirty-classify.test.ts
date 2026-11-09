/*
<MODULE_CONTRACT>
<purpose>dirty-classify tests (RFC-1531 AC-6/AC-9): every dirty path maps to
exactly one member of the closed DirtyClass vocabulary — FORGE_STATE_FILES →
tolerated, the declared debris set → disposable, everything else → work —
and the sweep subject stays the fixed literal the RFC pins.</purpose>
<non-goals>
  <item>No diff-aware classes — importer and skill-twin assignment lives in preflight's classifyDirt, covered by the preflight suite.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1531: closed dirty-path classifier + remediation flags on flow.integrate</item>
  <item>RFC-1531: add flow.integrate remediation flags on the shared dirty classifier</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ambientIo } from "../../../src/utils/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

import {
  AUTO_CLEAN_PASS_CLASSES,
  classifyDirtyPath,
  classifyDirtyTree,
  DISPOSABLE_PATH_RULES,
  summarizeClasses,
  SWEEP_COMMIT_SUBJECT,
} from "../dirty-classify.ts";

describe("classifyDirtyPath — the closed vocabulary (AC-6)", () => {
  it("FORGE_STATE_FILES classify tolerated — reported, never deleted", () => {
    expect(classifyDirtyPath(".forge/knowledge-conflicts.txt")).toBe("tolerated");
    expect(classifyDirtyPath(".forge/task/notes.md")).toBe("tolerated");
  });

  it("every declared disposable shape classifies disposable", () => {
    for (const path of [
      "leftover.stale",
      "docs/x.md.stale",
      "coverage/lcov.info",
      ".coverage/index.json",
      "pkg/coverage/out.xml",
      "tmp/debug.txt",
      "tmp-e2e/trace.out",
      "src/tmp-t/result.json",
      "scratch.log",
      "var/build.log",
    ]) {
      expect(classifyDirtyPath(path), path).toBe("disposable");
    }
  });

  it("closed-set negatives stay work — no fuzzy debris detection", () => {
    for (const path of [
      "src/x.ts",
      "docs/rfcs/rfc-1531-x.md",
      "pnpm-lock.yaml", // importer classes need the diff — path-only is work
      ".agents/skills/foo/SKILL.md", // twin sync needs byte compare — work here
      ".forge/pinned.yaml", // authored forge state — not in FORGE_STATE_FILES
      ".forge/other-state.yaml",
      "tmpfile", // not a tmp/ dir
      "attempt/x.txt", // 'tmp' not at a segment start
      "coverage-x/f", // 'coverage-x' is not the coverage dir
      "x.logs", // not *.log
      "a.stales", // not *.stale
      "src/log/output",
    ]) {
      expect(classifyDirtyPath(path), path).toBe("work");
    }
  });
});

describe("classifyDirtyTree / summarizeClasses", () => {
  it("classifies each porcelain line by its field-3+ path", () => {
    const entries = classifyDirtyTree([
      " M src/x.ts",
      "?? tmp-t/f.json",
      "?? .forge/knowledge-conflicts.txt",
      " D notes.stale",
    ]);
    expect(entries).toEqual([
      { path: "src/x.ts", class: "work" },
      { path: "tmp-t/f.json", class: "disposable" },
      { path: ".forge/knowledge-conflicts.txt", class: "tolerated" },
      { path: "notes.stale", class: "disposable" },
    ]);
    expect(summarizeClasses(entries)).toEqual({
      work: 1,
      disposable: 2,
      tolerated: 1,
    });
  });

  it("a trailing-slash untracked dir still classifies on its name", () => {
    expect(classifyDirtyTree(["?? tmp-e2e/"])).toEqual([{ path: "tmp-e2e/", class: "disposable" }]);
  });
});

describe("constants the RFC pins", () => {
  it("AC-9: the sweep subject is the fixed literal", () => {
    expect(SWEEP_COMMIT_SUBJECT).toBe("chore(flow): sweep session leftovers");
  });

  it("disposable rules are a closed declared set — importer-prune stays out", () => {
    expect(DISPOSABLE_PATH_RULES.length).toBeGreaterThan(0);
    // The tolerated family passes auto-clean without deletion; work and
    // importer-prune refuse.
    expect(AUTO_CLEAN_PASS_CLASSES).toEqual([
      "tolerated",
      "importer-materialize",
      "skill-twin-sync",
    ]);
    expect(AUTO_CLEAN_PASS_CLASSES).not.toContain("importer-prune");
    expect(AUTO_CLEAN_PASS_CLASSES).not.toContain("work");
  });
});

// RFC-1543 AC-3/AC-5: classifyDirt's claims step — unattributed paths covered
// by a live op-claim reclassify in-flight-foreign; everything else stays
// work. The classifier consumes the claim LIST the caller resolved —
// liveness itself is ops-registry's job.
describe("classifyDirt — op-claim attribution (RFC-1543)", () => {
  const liveClaim: import("../ops-registry.ts").OpClaim = {
    schema: "forge/op-claim@1",
    opId: "op-live",
    command: "leitstand.ship",
    pid: process.pid,
    host: "h",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    workspaceRoot: "/repo",
    paths: ["docs/", "pnpm-lock.yaml"],
  };

  it("an unattributed path under a live claim classifies in-flight-foreign", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    const verdict = await classifyDirt(
      repo,
      ambientIo,
      [" M src/work.ts", " M docs/rfcs/rfc-1.md"],
      { runGit: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
      [liveClaim],
    );
    expect(verdict.foreignInFlight).toEqual([{ path: "docs/rfcs/rfc-1.md", holder: liveClaim }]);
    expect(verdict.unattributed).toEqual([" M src/work.ts"]);
  });

  it("no claims → identical unattributed output (AC-5: claims only add tolerance)", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    const entries = [" M docs/rfcs/rfc-1.md", " M src/work.ts"];
    const withClaims = await classifyDirt(repo, ambientIo, entries, {
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    expect(withClaims.unattributed).toEqual(entries);
    expect(withClaims.foreignInFlight).toEqual([]);
  });
});

// RFC-1544 AC-1/AC-3: the importer-prune class splits by referent — a live
// foreign open mission yields foreign-open-mission; residue in no checkout
// and no open mission yields importer-prune-stale; no resolver keeps the
// legacy importer-prune class.
const PRUNE_DIFF_1544 = [
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "index abc..def 100644",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -10,7 +10,6 @@ importers:",
  "-  missions/m000214/workpiece:",
  "-    dependencies:",
  "-      vite: 5.0.0",
  " packages:",
].join("\n");

describe("classifyDirt — importer-prune referents (RFC-1544)", () => {
  const runGit = async () => ({ exitCode: 0, stdout: PRUNE_DIFF_1544, stderr: "" });
  const entries = [" M pnpm-lock.yaml"];

  it("AC-1: a foreign checkout's open mission classifies foreign-open-mission", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    const verdict = await classifyDirt(repo, ambientIo, entries, { runGit }, [], async (ids) =>
      ids.map((missionId) => ({
        missionId,
        existsHere: false,
        existsInCheckout: ["/repo@auto/foreign"],
        missionOpen: true,
      })),
    );
    expect(verdict.tolerated).toEqual([
      {
        path: "pnpm-lock.yaml",
        class: "foreign-open-mission",
        missionIds: ["m000214"],
      },
    ]);
    expect(verdict.unattributed).toEqual([]);
  });

  it("AC-3: residue in no checkout and no open mission classifies importer-prune-stale", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    const verdict = await classifyDirt(repo, ambientIo, entries, { runGit }, [], async (ids) =>
      ids.map((missionId) => ({
        missionId,
        existsHere: false,
        existsInCheckout: [],
        missionOpen: false,
      })),
    );
    expect(verdict.tolerated).toEqual([
      {
        path: "pnpm-lock.yaml",
        class: "importer-prune-stale",
        missionIds: ["m000214"],
      },
    ]);
  });

  it("no resolver keeps the legacy importer-prune class", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    const verdict = await classifyDirt(repo, ambientIo, entries, { runGit });
    expect(verdict.tolerated).toEqual([
      {
        path: "pnpm-lock.yaml",
        class: "importer-prune",
        missionIds: ["m000214"],
      },
    ]);
  });
});
