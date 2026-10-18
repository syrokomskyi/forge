/*
<MODULE_CONTRACT>
<purpose>RFC-1333: candidate-binding and report-parsing tests for RFC-IMP-12 over a temporary git repository.</purpose>
<non-goals>
  <item>Do not run the full stamp — the gate evaluator is covered elsewhere.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1333: merge-commit binding and CRLF report regression tests (REVIEW-CODE-2026-10-18-04).</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidateBoundToHead, readAcceptanceReports } from "./implement-stamp.ts";

let root: string;
const git = (...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@t", "-c", "user.name=T", ...a],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
async function put(rel: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "imp12-bind-"));
  git("init", "-q", "-b", "main");
  await put("src/a.ts", "a\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("RFC-IMP-12 binding (RFC-1333)", () => {
  it("unbinds when a merge brings code after the candidate", async () => {
    const candidate = git("rev-parse", "HEAD");
    git("checkout", "-qb", "side");
    await put("src/evil.ts", "x\n");
    git("add", "-A");
    git("commit", "-qm", "side change");
    git("checkout", "-q", "main");
    await put("docs/note.md", "n\n");
    git("add", "-A");
    git("commit", "-qm", "docs");
    git("merge", "-q", "--no-ff", "side", "-m", "merge side");
    expect(await candidateBoundToHead(root, candidate)).toBe(false);
  });

  it("stays bound across docs-only commits", async () => {
    const candidate = git("rev-parse", "HEAD");
    await put("docs/note.md", "n\n");
    git("add", "-A");
    git("commit", "-qm", "docs");
    expect(await candidateBoundToHead(root, candidate)).toBe(true);
  });

  it("parses CRLF report frontmatter", async () => {
    await put(
      "docs/reviews/acceptance/rfc-9003/acceptance-2026-10-18-r0.md",
      "---\r\nrfcId: RFC-9003\r\nverdict: pass\r\nisolation: subagent\r\ncandidateSha: abc\r\n---\r\n\r\nok\r\n",
    );
    git("add", "-A");
    git("commit", "-qm", "report");
    const reports = await readAcceptanceReports(root, "RFC-9003");
    expect(reports[0]?.frontmatter["verdict"]).toBe("pass");
  });
});
