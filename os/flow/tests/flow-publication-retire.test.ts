/*
<MODULE_CONTRACT>
<purpose>flow.publication.retire tests (RFC-1503, AC-6, AC-7): retiring a
pending tag appends a publish-retired journal event and removes the tag
from the digest's pending list; a tag that is not pending refuses
FLOW-RETIRE-01; an empty --reason refuses FLOW-RETIRE-02.</purpose>
<non-goals>
  <item>No real repo-extract — the fixture installs node_modules/.bin/repo-extract.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: step 1 — publication-retire tests</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
  <item>RFC-1503: review r1 — FLOW-07 on retire journal failure, journal re-read before publish, publication-order unit tests, stale catalog/inventory regen</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { retirePublication } from "../handlers/flow-publication-retire.ts";
import { pushFlow } from "../handlers/flow-push.ts";
import { markerContent } from "../markers.ts";
import { releaseTagAnnotation, writeReleaseTag } from "../release-tags.ts";
import { commonGitDir, readJournal } from "../registry.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env["FAKE_EXTRACT_FAIL"];
}, 20_000);

async function addPackageLine(repo: string): Promise<void> {
  await mkdir(join(repo, "packages", "lib"), { recursive: true });
  await writeFile(
    join(repo, "packages", "lib", "extract.config.yaml"),
    "standalone: true\ndestName: lib-export\n",
  );
  await writeFile(
    join(repo, "packages", "lib", "package.json"),
    '{\n  "name": "lib",\n  "version": "2.1.0"\n}\n',
  );
  await writeFile(join(repo, "packages", "lib", "forge.generated.yaml"), markerContent("test"));
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "package line lib"]);
  const push = await gitExec(repo, ["push", "origin", "develop"]);
  if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);
}

async function tag(repo: string, name: string, line: string, version: string): Promise<void> {
  const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
  const res = await writeReleaseTag(repo, ambientIo, {
    name,
    target: tip,
    annotation: releaseTagAnnotation({
      tag: name,
      line,
      version,
      level: "minor",
      previous: null,
      rfcs: [],
      fingerprints: {},
    }),
  });
  if (res.exitCode !== 0) throw new Error(`tag ${name} failed: ${res.stderr}`);
}

async function makePending(repo: string, name: string): Promise<void> {
  await tag(repo, name, "lib", name.split("@")[1]!);
  process.env["FAKE_EXTRACT_FAIL"] = "1";
  const digest = await collectDigest(repo, ambientIo, { fetch: false });
  await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
  delete process.env["FAKE_EXTRACT_FAIL"];
}

describe("flow.publication.retire (RFC-1503)", () => {
  it("retires a pending tag — journal record, gone from pendingPublications (AC-6)", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-ret-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await makePending(repo, "lib@1.0.0");

    const before = await collectDigest(repo, ambientIo, { fetch: false });
    expect(before.pendingPublications).toEqual([{ tag: "lib@1.0.0", line: "lib" }]);

    const res = await retirePublication(repo, ambientIo, {
      tag: "lib@1.0.0",
      reason: "never passes extract-verify",
    });
    expect(res.diagnostics).toEqual([]);
    expect(res.retired).toBe("lib@1.0.0");

    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    const retired = journal.filter((e) => e.event === "publish-retired");
    expect(retired.map((e) => [e.branch, e.detail])).toEqual([
      ["lib@1.0.0", "never passes extract-verify"],
    ]);

    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([]);
    expect(after.supersededPublications).toEqual([]);

    // A second retire on the same tag refuses — it is no longer pending.
    const again = await retirePublication(repo, ambientIo, {
      tag: "lib@1.0.0",
      reason: "again",
    });
    expect(again.diagnostics[0]?.ruleId).toBe("FLOW-RETIRE-01");
  }, 120_000);

  it("refuses a tag that is not pending with FLOW-RETIRE-01 (AC-7)", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-ret-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@1.0.0", "lib", "1.0.0"); // never pushed → not pending

    const res = await retirePublication(repo, ambientIo, {
      tag: "lib@1.0.0",
      reason: "not pending",
    });
    expect(res.diagnostics[0]?.ruleId).toBe("FLOW-RETIRE-01");
    expect(res.retired).toBeNull();

    const unknown = await retirePublication(repo, ambientIo, {
      tag: "lib@9.9.9",
      reason: "does not exist",
    });
    expect(unknown.diagnostics[0]?.ruleId).toBe("FLOW-RETIRE-01");

    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    expect(journal.filter((e) => e.event === "publish-retired")).toEqual([]);
  }, 120_000);

  it("retires a shadowed (superseded-by-null) pending tag too", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-ret-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await makePending(repo, "lib@1.0.0");
    await makePending(repo, "lib@1.1.0");

    const before = await collectDigest(repo, ambientIo, { fetch: false });
    expect(before.pendingPublications).toEqual([{ tag: "lib@1.1.0", line: "lib" }]);
    expect(before.supersededPublications).toEqual([
      { tag: "lib@1.0.0", line: "lib", by: null },
    ]);

    const res = await retirePublication(repo, ambientIo, {
      tag: "lib@1.0.0",
      reason: "shadowed and unwanted",
    });
    expect(res.diagnostics).toEqual([]);
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([{ tag: "lib@1.1.0", line: "lib" }]);
    expect(after.supersededPublications).toEqual([]);
  }, 120_000);

  it("refuses an empty reason with FLOW-RETIRE-02", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-ret-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await makePending(repo, "lib@1.0.0");

    const res = await retirePublication(repo, ambientIo, {
      tag: "lib@1.0.0",
      reason: "   ",
    });
    expect(res.diagnostics[0]?.ruleId).toBe("FLOW-RETIRE-02");

    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    expect(journal.filter((e) => e.event === "publish-retired")).toEqual([]);
  }, 120_000);
});
