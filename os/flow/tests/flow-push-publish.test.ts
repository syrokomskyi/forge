/*
<MODULE_CONTRACT>
<purpose>flow.push publication tests (RFC-1491, AC-5/AC-6): a pushed
package-line tag runs the fake repo-extract with --ref and --no-push,
pushes the destination origin and journals publish; a baseline-annotated
tag reports skipped-baseline and never reaches the extract; a failing
extract is FLOW-PUSH-05 and the rerun with an empty digest retries the
journal-scoped pending publication; a tag on origin this journal never
pushed is not pending; a non-fast-forward destination reconciles once
with an ours-merge and never force-pushes.</purpose>
<non-goals>
  <item>No real repo-extract — the fixture installs node_modules/.bin/repo-extract.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 5 — flow.push publication tests</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1517: add preflight-extract-gates — FLOW-PUB-01 changelog check at ref plus shared PKG-HEALTH-10 fixture-path scan for RFC-1517</item>
  <item>RFC-1517: make pkg-health-10 shipped-set faithful and scan the publish ref</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { pushFlow } from "../handlers/flow-push.ts";
import { verifyLineAtRef } from "../publish.ts";
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

/** Package line packages/lib (extract.config.yaml + marker), committed and pushed. */
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

async function tag(repo: string, name: string, line: string, version: string, level: string): Promise<void> {
  const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
  const res = await writeReleaseTag(repo, ambientIo, {
    name,
    target: tip,
    annotation: releaseTagAnnotation({
      tag: name,
      line,
      version,
      level,
      previous: null,
      rfcs: [],
      fingerprints: {},
    }),
  });
  if (res.exitCode !== 0) throw new Error(`tag ${name} failed: ${res.stderr}`);
}

async function extractLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

describe("flow.push publications", () => {
  it("publishes lib@2.1.0: --ref + --no-push logged, dest origin updated, publish journaled (AC-5)", async () => {
    const { repo, extractLog: log, parent } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.tags).toEqual(["lib@2.1.0"]);
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics).toEqual([]);
    expect(data.pushed).toBe(true);

    const logged = await extractLog(log);
    expect(logged).toContain("--ref lib@2.1.0");
    expect(logged).toContain("--no-push");

    const pub = data.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("published");
    expect(pub?.verify?.status).toBe("skipped"); // no hooks/extract-verify.sh in the fixture
    const destOrigin = join(parent, "extract-origins", "lib-export.git");
    const destHead = (await gitExec(destOrigin, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect(destHead).toBe(pub?.destHead);

    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    const events = journal.map((e) => e.event);
    expect(events).toContain("push");
    expect(events).toContain("publish");
    const publish = journal.find((e) => e.event === "publish");
    expect(publish?.branch).toBe("lib@2.1.0");
  }, 90_000);

  it("a baseline-annotated tag reports skipped-baseline and never reaches the extract (AC-6)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@0.0.0", "lib", "0.0.0", "baseline");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics).toEqual([]);
    const pub = data.publications.find((p) => p.tag === "lib@0.0.0");
    expect(pub?.status).toBe("skipped-baseline");
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("a failing extract is FLOW-PUSH-05; a rerun with an empty digest publishes the pending tag", async () => {
    const { repo } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    process.env["FAKE_EXTRACT_FAIL"] = "1";
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const failed = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(failed.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-05");
    const pub = failed.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("failed");
    delete process.env["FAKE_EXTRACT_FAIL"];

    // The tag is on origin now, so the digest is empty — but the journal's
    // push record without a publish keeps it pending.
    const emptyDigest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(emptyDigest.tags).toEqual([]);
    expect(emptyDigest.pendingPublications).toEqual([{ tag: "lib@2.1.0", line: "lib" }]);

    const retry = await pushFlow(repo, ambientIo, {
      digest: emptyDigest.digestId,
      dryRun: false,
    });
    expect(retry.diagnostics).toEqual([]);
    expect(retry.pushed).toBe(false); // nothing to push — publications only
    const republished = retry.publications.find((p) => p.tag === "lib@2.1.0");
    expect(republished?.status).toBe("published");

    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([]);
  }, 120_000);

  it("a package line without a valid marker refuses FLOW-PUSH-06 before any ref moves", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await mkdir(join(repo, "packages", "lib"), { recursive: true });
    await writeFile(
      join(repo, "packages", "lib", "extract.config.yaml"),
      "standalone: true\ndestName: lib-export\n",
    );
    await writeFile(
      join(repo, "packages", "lib", "package.json"),
      '{\n  "name": "lib",\n  "version": "2.1.0"\n}\n',
    );
    // No forge.generated.yaml — the line must not publish.
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "package line lib"]);
    await gitExec(repo, ["push", "origin", "develop"]);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-06");
    expect(data.diagnostics[0]?.message).toContain("lib");
    expect((await gitExec(origin, ["rev-parse", "refs/tags/lib@2.1.0"])).exitCode).not.toBe(0);
  }, 90_000);

  it("a missing repo-extract binary refuses FLOW-PUSH-07 while tags wait", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-pub-" });
    await addPackageLine(repo);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-07");
    expect((await gitExec(origin, ["rev-parse", "refs/tags/lib@2.1.0"])).exitCode).not.toBe(0);
  }, 90_000);

  it("a repo-line v* tag in a push record is never pending", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-pub-" });
    await tag(repo, "v1.2.3", "repo", "1.2.3", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.pushed).toBe(true);

    // The journal push record names v1.2.3, but repo-line tags are never
    // extract publications — the next digest reports nothing pending.
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.pendingPublications).toEqual([]);
  }, 90_000);

  it("a tag on origin this journal never pushed is not pending", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await tag(repo, "lib@9.9.9", "lib", "9.9.9", "minor");
    // Pushed outside flow.push — this machine's journal has no push record.
    await gitExec(repo, ["push", "origin", "lib@9.9.9"]);

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.pendingPublications).toEqual([]);
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics).toEqual([]);
    expect(data.publications.find((p) => p.tag === "lib@9.9.9")).toBeUndefined();
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("a CHANGELOG missing the [version] section refuses FLOW-PUB-01 before any extract spawn (AC-1)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await writeFile(
      join(repo, "packages", "lib", "CHANGELOG.md"),
      "# Changelog\n\n## [2.0.0] - 2026-01-01\n\n- earlier release\n",
    );
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "changelog without the publish section"]);
    await gitExec(repo, ["push", "origin", "develop"]);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    const pub = data.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("failed");
    expect(pub?.error).toContain("preflight-extract-gates");
    expect(pub?.error).toContain("FLOW-PUB-01");
    expect(pub?.error).toContain("[2.1.0]");
    // The whole point of the preflight — repo-extract never ran.
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("verifyLineAtRef refuses FLOW-PUB-01 pre-extract when the ref's CHANGELOG lacks the section (AC-1)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await writeFile(
      join(repo, "packages", "lib", "CHANGELOG.md"),
      "# Changelog\n\n## [2.0.0] - 2026-01-01\n\n- earlier release\n",
    );
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "changelog without the publish section"]);
    const sha = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();

    const result = await verifyLineAtRef(repo, ambientIo, {
      line: { id: "lib", tagPrefix: "lib@", versionFile: "packages/lib/package.json", paths: ["packages/lib"] },
      ref: sha,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("preflight-extract-gates");
    expect(result.detail).toContain("FLOW-PUB-01");
    expect(result.detail).toContain("[2.1.0]");
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("a bare [version]: link reference without a release heading refuses FLOW-PUB-01", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await writeFile(
      join(repo, "packages", "lib", "CHANGELOG.md"),
      "# Changelog\n\n## [2.0.0] - 2026-01-01\n\n- earlier release\n\n[2.1.0]: https://example.com/diff\n",
    );
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "changelog with only a link reference"]);
    await gitExec(repo, ["push", "origin", "develop"]);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    const pub = data.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("failed");
    expect(pub?.error).toContain("FLOW-PUB-01");
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("a shipped file's root-escaping ../ literal refuses PKG-HEALTH-10 at file:line (AC-7)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    await mkdir(join(repo, "packages", "lib", "src", "tests"), { recursive: true });
    await writeFile(
      join(repo, "packages", "lib", "src", "tests", "fixture.test.ts"),
      'const fixture = "../../../docs/rfcs/rfc-0000-template.md";\nexport { fixture };\n',
    );
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "fixture path escaping the package root"]);
    await gitExec(repo, ["push", "origin", "develop"]);
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    const pub = data.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("failed");
    expect(pub?.error).toContain("PKG-HEALTH-10");
    expect(pub?.error).toContain("packages/lib/src/tests/fixture.test.ts:1");
    expect(await extractLog(log)).toBe("");
  }, 90_000);

  it("an uncommitted root-escaping file does NOT refuse — the scan reads the tag's tree (RFC-1517 r1)", async () => {
    const { repo, extractLog: log } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);
    // Untracked escape: never enters the tag's tree, so the extract never
    // ships it — flagging it would be a false refusal.
    await mkdir(join(repo, "packages", "lib", "src"), { recursive: true });
    await writeFile(
      join(repo, "packages", "lib", "src", "scratch.ts"),
      'const scratch = "../../../outside.md";\n',
    );
    await tag(repo, "lib@2.1.0", "lib", "2.1.0", "minor");

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    const pub = data.publications.find((p) => p.tag === "lib@2.1.0");
    expect(pub?.status).toBe("published");
    expect(await extractLog(log)).not.toBe("");
  }, 90_000);

  it("a non-fast-forward destination reconciles once with an ours-merge", async () => {
    const { repo, parent } = await initRepoWithOrigin(dirs, {
      prefix: "flow-pub-",
      fakeExtract: true,
    });
    await addPackageLine(repo);

    // Pre-seed a divergent history on the destination origin.
    const destOrigin = join(parent, "extract-origins", "lib-export.git");
    await mkdir(destOrigin, { recursive: true });
    await gitExec(destOrigin, ["init", "--bare", "-b", "main", "."]);
    const seedClone = join(parent, "dest-seed");
    await gitExec(parent, ["clone", destOrigin, "dest-seed"]);
    await gitExec(seedClone, ["config", "user.email", "flow-test@example.invalid"]);
    await gitExec(seedClone, ["config", "user.name", "flow-test"]);
    await writeFile(join(seedClone, "foreign.txt"), "foreign\n");
    await gitExec(seedClone, ["add", "foreign.txt"]);
    await gitExec(seedClone, ["commit", "-m", "foreign export"]);
    const fpush = await gitExec(seedClone, ["push", "origin", "main"]);
    if (fpush.exitCode !== 0) throw new Error(`seed push failed: ${fpush.stderr}`);

    await tag(repo, "lib@3.0.0", "lib", "3.0.0", "major");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics).toEqual([]);
    const pub = data.publications.find((p) => p.tag === "lib@3.0.0");
    expect(pub?.status).toBe("published");
    expect(pub?.reconciled).toBe(true);

    // The ours-merge landed — dest origin main equals the export HEAD and
    // still contains the foreign commit in history.
    const remoteHead = (await gitExec(destOrigin, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect(remoteHead).toBe(pub?.destHead);
    const ancestry = await gitExec(destOrigin, ["log", "--format=%s", "refs/heads/main"]);
    expect(ancestry.stdout).toContain("foreign export");
  }, 120_000);
});
