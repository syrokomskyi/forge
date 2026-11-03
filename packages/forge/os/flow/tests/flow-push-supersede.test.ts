/*
<MODULE_CONTRACT>
<purpose>flow.push supersession tests (RFC-1503, AC-1..AC-5): with two pending
tags of one line only the highest is attempted; publishing it journals
publish-superseded for the lower one; a pending tag at or below the newest
published is never extracted and is superseded on sight; the exit code
counts only this run's refs and attempted publications; the digest reports
pendingPublications as the highest pending tag per line.</purpose>
<non-goals>
  <item>No real repo-extract — the fixture installs node_modules/.bin/repo-extract.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: step 1 — supersede/ordering publication tests</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
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

async function extractLogText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Push every digest tag with the extract forced to fail — all become pending. */
async function failAllPublications(repo: string): Promise<void> {
  process.env["FAKE_EXTRACT_FAIL"] = "1";
  const digest = await collectDigest(repo, ambientIo, { fetch: false });
  await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
  delete process.env["FAKE_EXTRACT_FAIL"];
}

describe("flow.push supersession (RFC-1503)", () => {
  it("attempts only the highest pending tag of a line and supersedes the lower one (AC-1, AC-2, AC-4)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-sup-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@1.0.0", "lib", "1.0.0");
    await tag(repo, "lib@1.1.0", "lib", "1.1.0");
    await failAllPublications(repo);

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.pendingPublications).toEqual([{ tag: "lib@1.1.0", line: "lib" }]);
    expect(digest.supersededPublications).toEqual([
      { tag: "lib@1.0.0", line: "lib", by: null },
    ]);

    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    // AC-4: refs and this run's attempted publications succeeded → exit-0 data.
    expect(data.diagnostics).toEqual([]);

    // AC-1: only lib@1.1.0 was attempted in this run.
    const attempted = data.publications.filter((p) => p.status !== "skipped-baseline");
    expect(attempted.map((p) => p.tag)).toEqual(["lib@1.1.0"]);
    expect(attempted[0]?.status).toBe("published");
    expect(data.superseded).toEqual([{ tag: "lib@1.0.0", by: "lib@1.1.0" }]);

    // AC-2: the journal records publish-superseded for lib@1.0.0.
    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    const superseded = journal.filter((e) => e.event === "publish-superseded");
    expect(superseded.map((e) => [e.branch, e.detail])).toEqual([["lib@1.0.0", "lib@1.1.0"]]);

    // AC-3 strengthened: lib@1.0.0 was never extracted at all — supersession
    // already applied in the first run where it stayed shadowed pending.
    const logged = await extractLogText(log);
    expect(logged).not.toContain("--ref lib@1.0.0");

    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([]);
    expect(after.supersededPublications).toEqual([]);
  }, 120_000);

  it("a pending tag at or below the newest published is never extracted — superseded on sight (AC-3)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-sup-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@1.1.0", "lib", "1.1.0");
    const first = await collectDigest(repo, ambientIo, { fetch: false });
    const published = await pushFlow(repo, ambientIo, {
      digest: first.digestId,
      dryRun: false,
    });
    expect(published.diagnostics).toEqual([]);

    // A lower tag created later — below the line's newest published version.
    await tag(repo, "lib@1.0.0", "lib", "1.0.0");
    const pendingDigest = await collectDigest(repo, ambientIo, { fetch: false });
    // Journal-scoped views stay empty — the tag was never pushed, so it is
    // a fresh digest tag that the push itself supersedes on sight.
    expect(pendingDigest.pendingPublications).toEqual([]);
    expect(pendingDigest.supersededPublications).toEqual([]);

    const data = await pushFlow(repo, ambientIo, {
      digest: pendingDigest.digestId,
      dryRun: false,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.publications.filter((p) => p.status !== "skipped-baseline")).toEqual([]);
    expect(data.superseded).toEqual([{ tag: "lib@1.0.0", by: "lib@1.1.0" }]);

    // The tag was pushed to origin but never extracted.
    const logged = await extractLogText(log);
    expect(logged).not.toContain("--ref lib@1.0.0");
    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    expect(
      journal.filter((e) => e.event === "publish-superseded").map((e) => e.branch),
    ).toEqual(["lib@1.0.0"]);
  }, 120_000);

  it("semver order, not string order: 9.10.0 outranks 9.9.0 (AC-5)", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-sup-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@9.9.0", "lib", "9.9.0");
    await tag(repo, "lib@9.10.0", "lib", "9.10.0");
    await failAllPublications(repo);

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.pendingPublications).toEqual([{ tag: "lib@9.10.0", line: "lib" }]);
    expect(digest.supersededPublications).toEqual([
      { tag: "lib@9.9.0", line: "lib", by: null },
    ]);
  }, 120_000);

  it("a lower pending tag stays pending when the highest fails", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-sup-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@1.0.0", "lib", "1.0.0");
    await tag(repo, "lib@1.1.0", "lib", "1.1.0");
    await failAllPublications(repo);

    process.env["FAKE_EXTRACT_FAIL"] = "1";
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const failed = await pushFlow(repo, ambientIo, {
      digest: digest.digestId,
      dryRun: false,
    });
    delete process.env["FAKE_EXTRACT_FAIL"];
    expect(failed.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-05");

    // Both stay pending — 1.0.0 is not superseded because 1.1.0 never published.
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([{ tag: "lib@1.1.0", line: "lib" }]);
    expect(after.supersededPublications).toEqual([
      { tag: "lib@1.0.0", line: "lib", by: null },
    ]);
    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    expect(journal.filter((e) => e.event === "publish-superseded")).toEqual([]);
  }, 120_000);
});
