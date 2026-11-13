/*
<MODULE_CONTRACT>
<purpose>RFC-1580: `rfc.verify.workspace --manifest` — the oracle-review
export keeps the manifest, requirements, anchored code, and oracles, strips
narrative directories, and lists every oracle with the sha256 a
forge/oracle-review@1 record must name.</purpose>
<non-goals>
  <item>Not an RFC-1333 acceptance-export test — verify-workspace.test.ts owns that mode.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial suite.</item>
  <item>RFC-1580: digest trail, manifest review export, operating model and skills

flow.digest lists X-Correctness-Weakening trailers and verifier-trailer commits (correctnessTrail, part of digestId); rfc.verify.workspace --manifest exports the oracle-review surface with MANIFEST-REVIEW-BUNDLE.md hashes; operating model §7 product tiers and §8 'a self oracle never covers an anchor of a product correctness manifest'; fo-review oracle review mode producing forge/oracle-review@1; fo-idea-implement step 4.4c; correctness-gate reference page; forge AGENTS.md gate rules.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  L1_ORACLE,
  ORACLE_PATH,
  makeGateFixture,
  type GateFixture,
} from "../correctness/gate/tests/gate-fixture.ts";
import { buildManifestReviewWorkspace } from "./verify-workspace.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("rfc.verify.workspace --manifest", () => {
  it("exports the review surface, strips narrative, and lists oracle hashes", async () => {
    const f: GateFixture = makeGateFixture({});
    cleanups.push(f.cleanup);
    f.write("docs/plans/plan-x.md", "# narrative\n");
    f.write("docs/sessions/s.md", "# narrative\n");
    const head = f.commit("narrative");
    const res = await buildManifestReviewWorkspace({ workspaceRoot: f.root, candidateSha: head });
    expect(res.status, res.error).toBe("pass");
    cleanups.push(() => rmSync(res.path!, { recursive: true, force: true }));
    expect(existsSync(path.join(res.path!, "docs/correctness.yaml"))).toBe(true);
    expect(existsSync(path.join(res.path!, ORACLE_PATH))).toBe(true);
    expect(existsSync(path.join(res.path!, "apps/api/src/dispatch.ts"))).toBe(true);
    expect(existsSync(path.join(res.path!, "docs/plans"))).toBe(false);
    expect(existsSync(path.join(res.path!, "docs/sessions"))).toBe(false);
    const bundle = readFileSync(path.join(res.path!, "MANIFEST-REVIEW-BUNDLE.md"), "utf8");
    expect(bundle).toContain(createHash("sha256").update(L1_ORACLE).digest("hex"));
    expect(bundle).toContain("CM-dispatch-01");
  });
});
