/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-IMP-12 candidate binding — covers the imp12 binding acceptance suite surface and its observable contract.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-rfc</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
</CHANGE_SUMMARY>
*/

// RFC-1333 Design "Stamp gate RFC-IMP-12" — candidate binding: descendants of
// candidateSha up to the implementation commit may touch only verifier-trailer
// commits and docs/**.
// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { runRfcImplementStamp } from "../../handlers/implement-stamp.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../../src/types.ts";

vi.mock("../../acceptance.ts", () => ({
  runProbe: vi.fn(async (probe: unknown) => ({ probe, ok: true, detail: "ok" })),
  // RFC-1489: emit (which stamp composes) drives runProbeSet — the shim
  // preserves the per-probe mock contract.
  runProbeSet: vi.fn(async (probes: unknown[]) => ({
    results: probes.map((probe) => ({ probe, ok: true, detail: "ok" })),
    durationsMs: probes.map(() => 0),
  })),
}));

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
const put = async (dir: string, rel: string, body: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};
const commit = (dir: string, msg: string) => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
};
const RFC = `---\nid: RFC-0100\ntitle: "T"\nstatus: accepted\nkind: command\nscope: workspace\nowners:\n  - architecture\ncreatedAt: 2026-10-18\nupdatedAt: 2026-10-18\nverificationTier: high\nacceptance:\n  - probe: file-exists\n    path: src/index.ts\n    criterion: AC-1\n---\n\n# RFC-0100\n## Context\nx\n## Acceptance criteria\n\n- [x] AC-1: THE thing SHALL exist (evidence: probe:AC-1)\n`;

async function scenario(laterPath: string): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imp12-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    await put(dir, "docs/rfcs/rfc-0100-t.md", RFC);
    commit(dir, "docs: RFC-0100 accepted");
    await put(dir, "src/index.ts", "export {};\n");
    const cand = commit(dir, "feat: RFC-0100 implement");
    await put(
      dir,
      "docs/reviews/acceptance/rfc-0100/acceptance-2026-10-18-r0.md",
      `---\nrfcId: RFC-0100\ncandidateSha: ${cand}\nround: 0\nisolation: subagent\nverifierModel: null\nverdict: pass\ncounterexamples: []\n---\n\nok\n`,
    );
    commit(dir, "docs: RFC-0100 acceptance report");
    await put(dir, laterPath, "changed after verification\n");
    const head = commit(dir, "feat: RFC-0100 post-verification change");
    const ctx = {
      workspaceRoot: dir,
      logger: { info: () => {}, warn: () => {} },
      outputFormat: "json",
      commandRegistry: undefined,
      dryRun: false,
    } as unknown as ForgeRuntimeContext;
    const r = await runRfcImplementStamp(
      {
        flags: { id: "RFC-0100", "implementation-commit": head, "dry-run": true },
      } as unknown as ForgeCommandInput,
      ctx,
    );
    return (r.data?.violations ?? []).map((v) => v.rule);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("RFC-IMP-12 candidate binding", () => {
  test("control: post-candidate code change unbinds the report", async () => {
    expect(await scenario("src/other.ts")).toContain("RFC-IMP-12");
  });
  test("post-candidate change to a non-docs/** markdown file (e.g. a skill) unbinds the report", async () => {
    expect(await scenario("packages/forge/skills/fo/x/SKILL.md")).toContain("RFC-IMP-12");
  });
  test("post-candidate docs/** change keeps the report bound", async () => {
    expect(await scenario("docs/notes.md")).not.toContain("RFC-IMP-12");
  });
});
