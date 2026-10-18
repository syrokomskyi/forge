// RFC-1333 AC-1, AC-2, AC-10, Design step 2/3 — rfc.verify.workspace export.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildVerifyWorkspace } from "../../verify-workspace.ts";

let repo = "";
let out = "";
let removed: string[] = [];
const git = (...a: string[]) =>
  execFileSync("git", a, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const rfc = (status: string) =>
  `---\nid: RFC-0001\ntitle: "x"\nstatus: ${status}\ncreatedAt: 2026-10-18\n---\n\n## Context\n\nctx\n\n## Problem\n\np\n\n## Decision\n\nd\n\n## Design\n\ndes\n\n## Acceptance criteria\n\n- [ ] AC-1: x\n\n## Implementation notes\n\nSECRET-NARRATIVE\n`;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "vw-fixture-"));
  git("init", "-q", "-b", "main");
  put("docs/rfcs/rfc-0001-x.md", rfc("draft"));
  put("src/old.test.ts", "// pre-existing\n");
  put("docs/plans/other.md", "unrelated plan\n");
  git("add", "-A");
  git("commit", "-qm", "chore: init");
  put("docs/rfcs/rfc-0001-x.md", rfc("accepted"));
  git("commit", "-qam", "docs: accept");
  put("src/a.ts", "export const a = 1;\n");
  put("src/a.test.ts", "// self test\n");
  put("src/old.test.ts", "// edited by implementer\n");
  put("docs/plans/plan-x.md", "Plan for rfc-0001\n");
  put("docs/reviews/code/r.md", "Review of RFC-0001\n");
  put("docs/sessions/s.md", "session about RFC-0001\n");
  put("docs/rfcs/verification/rfc-0001.generated.yaml", "x: 1\n");
  put("docs/metrics/rfcs/rfc-0001.metrics.yaml", "x: 1\n");
  git("add", "-A");
  git("commit", "-qm", "feat: RFC-0001 impl");
  put("src/v.test.ts", "// verifier\n");
  git("add", "-A");
  git(
    "commit",
    "-qm",
    "test: verifier\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/reviews/acceptance/rfc-0001/a-r0.md",
  );
  const head = git("rev-parse", "HEAD").trim();
  const res = await buildVerifyWorkspace({
    workspaceRoot: repo,
    rfcId: "RFC-0001",
    candidateSha: head,
  });
  expect(res.status).toBe("pass");
  out = res.path!;
  removed = res.removed;
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("RFC-1333 rfc.verify.workspace", () => {
  it("AC-1: self-origin test files are absent", () => {
    expect(existsSync(join(out, "src/a.test.ts"))).toBe(false);
    expect(existsSync(join(out, "src/old.test.ts"))).toBe(false);
    expect(existsSync(join(out, "src/a.ts"))).toBe(true);
  });
  it("AC-1 (design): verifier-trailer test files are kept", () => {
    expect(existsSync(join(out, "src/v.test.ts"))).toBe(true);
  });
  it("AC-2: plan/review/session docs referencing the RFC are absent; unrelated kept", () => {
    expect(existsSync(join(out, "docs/plans/plan-x.md"))).toBe(false);
    expect(existsSync(join(out, "docs/reviews/code/r.md"))).toBe(false);
    expect(existsSync(join(out, "docs/sessions/s.md"))).toBe(false);
    expect(existsSync(join(out, "docs/plans/other.md"))).toBe(true);
  });
  it("design: verification envelope and metrics removed", () => {
    expect(existsSync(join(out, "docs/rfcs/verification/rfc-0001.generated.yaml"))).toBe(false);
    expect(existsSync(join(out, "docs/metrics/rfcs/rfc-0001.metrics.yaml"))).toBe(false);
  });
  it("AC-10: no .git entry", () => {
    expect(existsSync(join(out, ".git"))).toBe(false);
  });
  it("design step 3: bundle carries only normative sections and removed list", () => {
    const b = readFileSync(join(out, "VERIFY-BUNDLE.md"), "utf8");
    for (const h of ["Context", "Problem", "Decision", "Design", "Acceptance criteria"])
      expect(b).toContain(`## ${h}`);
    expect(b).not.toContain("SECRET-NARRATIVE");
    for (const r of removed) expect(b).toContain(`- ${r}`);
  });
});
