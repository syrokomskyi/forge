/*
<MODULE_CONTRACT>
<purpose>flow.install baseline rerun identity (RFC-1488: AC-6): after the
first run created the baseline tags, a second run must leave the repository's
tag set byte-identical — every line's version file already equals its last
tag, so the tags step skips.</purpose>
<non-goals>
  <item>No first-run coverage — flow-install-baseline.test.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 5 — baseline rerun identity test</item>
  <item>RFC-1488: steps 5-6 — flow.install baseline tags step, flow.check FLOW-08/FLOW-09</item>
  <item>RFC-1488: AC-6 rerun timeout, AC-8 'release line' wording</item>
</CHANGE_SUMMARY>
*/

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { executeInstall, planInstall } from "../handlers/flow-install.ts";
import { gitExec, initRepo } from "./helpers.ts";

async function listTagsWithObjects(repo: string): Promise<string> {
  const r = await gitExec(repo, [
    "for-each-ref",
    "refs/tags",
    "--format=%(refname) %(objectname) %(*objectname)",
  ]);
  return r.stdout.trim().split("\n").sort().join("\n");
}

// Two full plan+execute cycles exceed the repo-root vitest default (5s).
it("AC-6: a second flow.install leaves the tag set identical", { timeout: 30000 }, async () => {
  const repo = await initRepo({ prefix: "flow-rerun-" });
  await mkdir(join(repo, "packages/pbp"), { recursive: true });
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  await writeFile(join(repo, "packages/pbp/extract.config.yaml"), "forgePlugin: false\n");
  await writeFile(join(repo, "packages/pbp/package.json"), '{ "version": "2.1.0" }\n');
  await writeFile(join(repo, "package.json"), '{ "version": "1.0.0" }\n');
  await writeFile(join(repo, "forge.yaml"), "name: test\n");
  await gitExec(repo, ["add", "."]);
  await gitExec(repo, ["commit", "-m", "versions"]);

  const first = await planInstall(repo, ambientIo);
  expect(first.refusal).toBeNull();
  await executeInstall(first, ambientIo);
  const tagsAfterFirst = await listTagsWithObjects(repo);
  expect(tagsAfterFirst).toContain("refs/tags/v1.0.0");
  expect(tagsAfterFirst).toContain("refs/tags/pbp@2.1.0");

  // Second run — same repo, same plan approval path.
  const second = await planInstall(repo, ambientIo);
  expect(second.refusal).toBeNull();
  expect(second.tagPlans).toEqual([]);
  expect(second.steps.find((s) => s.step === "tags")?.detail).toContain("no baseline tags");
  await executeInstall(second, ambientIo);

  expect(await listTagsWithObjects(repo)).toBe(tagsAfterFirst);
});
