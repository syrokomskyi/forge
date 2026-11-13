/*
<MODULE_CONTRACT>
<purpose>RFC-1580: flow.digest lists every X-Correctness-Weakening trailer
and every verifier-trailer commit in the unpushed develop range, so the
operator sees both at the flow.push hard stop.</purpose>
<non-goals>
  <item>Not a digest attribution test — flow-digest.test.ts owns items.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial suite.</item>
  <item>RFC-1580: digest trail, manifest review export, operating model and skills

flow.digest lists X-Correctness-Weakening trailers and verifier-trailer commits (correctnessTrail, part of digestId); rfc.verify.workspace --manifest exports the oracle-review surface with MANIFEST-REVIEW-BUNDLE.md hashes; operating model §7 product tiers and §8 'a self oracle never covers an anchor of a product correctness manifest'; fo-review oracle review mode producing forge/oracle-review@1; fo-idea-implement step 4.4c; correctness-gate reference page; forge AGENTS.md gate rules.</item>
</CHANGE_SUMMARY>
*/

import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("flow.digest correctness trail", () => {
  it("lists accepted weakenings and verifier-trailer commits in the unpushed range", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-trail-" });
    await gitExec(repo, [
      "commit",
      "--allow-empty",
      "-m",
      "flow: accept correctness weakening\n\nX-Correctness-Weakening: entry retired with REQ-04",
    ]);
    await gitExec(repo, [
      "commit",
      "--allow-empty",
      "-m",
      "test: verifier oracle\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/correctness/reviews/r.yaml",
    ]);
    await gitExec(repo, ["commit", "--allow-empty", "-m", "chore: plain"]);
    const data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.correctnessTrail.weakenings.map((w) => w.reason)).toEqual([
      "entry retired with REQ-04",
    ]);
    expect(data.correctnessTrail.verifierCommits.map((v) => v.report)).toEqual([
      "docs/correctness/reviews/r.yaml",
    ]);
  });
});
