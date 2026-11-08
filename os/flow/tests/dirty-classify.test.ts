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
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

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
    expect(classifyDirtyTree(["?? tmp-e2e/"])).toEqual([
      { path: "tmp-e2e/", class: "disposable" },
    ]);
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
