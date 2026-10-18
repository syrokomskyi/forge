/*
<MODULE_CONTRACT>
<purpose>RFC-1333: rfc.verify.workspace tests — stripped, git-free export of a committed candidate over a temporary git repository.</purpose>
<non-goals>
  <item>Do not run a verifier — only the export contract is under test.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1333: tests for AC-1, AC-2, AC-10.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVerifyWorkspace } from "./verify-workspace.ts";

let root: string;
let out: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@t", "-c", "user.name=T", ...args],
    { cwd: root, encoding: "utf8" },
  );
}

async function commit(message: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD").trim();
}

const rfc = (status: string) =>
  `---\nid: RFC-9002\ntitle: "Fixture"\nstatus: ${status}\ncreatedAt: 2026-10-18\n---\n\n# RFC-9002: Fixture\n\n## Context\n\nCtx.\n\n## Decision\n\nDecide.\n\n## Risks\n\nInternal only.\n\n## Acceptance criteria\n\n- [ ] AC-1: WHEN x, THE y SHALL z.\n`;

let candidate: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "verify-ws-"));
  out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "verify-out-")), "tree");
  git("init", "-q");
  await commit("draft", {
    "docs/rfcs/rfc-9002-fixture.md": rfc("draft"),
    "src/old.test.ts": "it('pre-existing', () => {});\n",
  });
  await commit("accept", { "docs/rfcs/rfc-9002-fixture.md": rfc("accepted") });
  candidate = await commit("RFC-9002: implement", {
    "src/feature.ts": "export const f = 1;\n",
    "src/feature.test.ts": "it('self', () => {});\n",
    "docs/plans/plan-rfc-9002-fixture.md": "# plan for RFC-9002\n",
    "docs/reviews/code/x/review-1.md": "reviews RFC-9002\n",
    "docs/sessions/s.md": "unrelated session\n",
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.dirname(out), { recursive: true, force: true });
});

describe("rfc.verify.workspace (RFC-1333)", () => {
  it("omits test files whose derived origin is self from the verifier worktree", async () => {
    const r = await buildVerifyWorkspace({
      workspaceRoot: root,
      rfcId: "RFC-9002",
      candidateSha: candidate,
      outDir: out,
    });
    expect(r.status).toBe("pass");
    expect(existsSync(path.join(out, "src/feature.test.ts"))).toBe(false);
    expect(existsSync(path.join(out, "src/old.test.ts")), "pre-acceptance tests stay visible").toBe(
      true,
    );
    expect(existsSync(path.join(out, "src/feature.ts"))).toBe(true);
  });

  it("omits plan, review, and session documents for the RFC from the verifier worktree", async () => {
    const r = await buildVerifyWorkspace({
      workspaceRoot: root,
      rfcId: "RFC-9002",
      candidateSha: candidate,
      outDir: out,
    });
    expect(existsSync(path.join(out, "docs/plans/plan-rfc-9002-fixture.md"))).toBe(false);
    expect(existsSync(path.join(out, "docs/reviews/code/x/review-1.md"))).toBe(false);
    expect(existsSync(path.join(out, "docs/sessions/s.md")), "unrelated docs stay").toBe(true);
    const bundle = await fs.readFile(path.join(out, "VERIFY-BUNDLE.md"), "utf8");
    expect(bundle).toContain("## Decision");
    expect(bundle).not.toContain("## Risks");
    expect(r.removed).toContain("src/feature.test.ts");
  });

  it("exports the candidate without git metadata", async () => {
    await buildVerifyWorkspace({
      workspaceRoot: root,
      rfcId: "RFC-9002",
      candidateSha: candidate,
      outDir: out,
    });
    expect(existsSync(path.join(out, ".git"))).toBe(false);
  });
});
