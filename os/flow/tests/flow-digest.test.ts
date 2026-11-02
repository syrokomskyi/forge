/*
<MODULE_CONTRACT>
<purpose>flow.digest tests (RFC-1491, AC-1): the unpushed develop tail is
segmented into journal-attributed items — two integrated branches yield two
integration items, the X-RFC one classified migration — one item per risk
category, unattributed runs, a stable digestId that changes with one more
commit, new-tag detection versus origin, and FLOW-PUSH-01 without origin.</purpose>
<non-goals>
  <item>No hold/push coverage — flow-hold/flow-push tests own that.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 3 — flow.digest tests</item>
  <item>RFC-1491: step 3 — flow.digest risk digest with journal-attributed items, categories, digestId</item>
  <item>RFC-1498: step 4 — CI tag triggers and FLOW-11 in flow.digest

flow.digest now reads .github/workflows on the primary checkout and reports tagTriggers: for every digest tag the workflows whose on.push.tags filter matches its name. Matching evaluates the GitHub glob subset — star inside a segment, double-star across, question for one char; character classes and leading negations report FLOW-11 as pattern not understood and match nothing. A workflow that cannot be parsed reports FLOW-11 and contributes nothing, never blocking the digest. tagTriggers feeds digestId so a workflow change invalidates a quoted id, the pretty output prints one line per triggered tag, and flow.module declares FLOW-11 warning plus the workflows read glob. Tests AC-7 (a v1.0.1 tag maps to the v-star workflow only) and AC-8 (broken YAML and a bracket pattern warn while the digest still returns). Compass metadata updated.</item>
</CHANGE_SUMMARY>
*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { writeReleaseTag, releaseTagAnnotation } from "../release-tags.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/**
 * Governed repo (forge.yaml + develop) with a bare origin whose develop and
 * main are fully pushed — the digest tail starts empty.
 */
async function repoWithOrigin(): Promise<{ repo: string; origin: string }> {
  const repo = await initRepo({ prefix: "flow-digest-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(repo, ["add", "forge.yaml"]);
  await gitExec(repo, ["commit", "-m", "forge.yaml"]);
  await gitExec(repo, ["branch", "develop", "HEAD"]);

  const origin = await mkdtemp(join(tmpdir(), "flow-digest-origin-"));
  dirs.push(origin);
  const bare = await gitExec(origin, ["init", "--bare", "-b", "develop", "."]);
  if (bare.exitCode !== 0) throw new Error(`bare init failed: ${bare.stderr}`);
  await gitExec(repo, ["remote", "add", "origin", origin]);
  await gitExec(repo, ["switch", "develop"]);
  const push = await gitExec(repo, ["push", "-u", "origin", "develop", "main"]);
  if (push.exitCode !== 0) throw new Error(`initial push failed: ${push.stderr}`);
  return { repo, origin };
}

async function openSession(repo: string, slug: string) {
  const data = await openFlowBranch(repo, ambientIo, {
    kind: "session",
    slug,
    brief: null,
    owner: null,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  dirs.push(data.worktree!);
  return data;
}

async function integrate(repo: string, branch: string): Promise<void> {
  const data = await integrateFlowBranch(repo, ambientIo, {
    branch,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  expect(data.integrated).toBe(true);
}

async function commitIn(
  worktree: string,
  file: string,
  content: string,
  trailer?: string,
): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(join(worktree, dirname(file)), { recursive: true });
  await writeFile(join(worktree, file), content);
  await gitExec(worktree, ["add", file]);
  const args = ["commit", "-m", `add ${file}`];
  if (trailer !== undefined) args.push("-m", trailer);
  const r = await gitExec(worktree, args);
  if (r.exitCode !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

/** Commit on develop + push so the tail boundary advances past it. */
async function pushedCommit(repo: string, file: string, content: string): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(join(repo, dirname(file)), { recursive: true });
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-m", `add ${file}`]);
  const push = await gitExec(repo, ["push", "origin", "develop"]);
  if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);
}

/** Commit on develop left unpushed — part of the digest tail. */
async function unpushedCommit(repo: string, file: string, content: string): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(join(repo, dirname(file)), { recursive: true });
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-m", `add ${file}`]);
}

describe("flow.digest", () => {
  it("attributes two integrated branches; the X-RFC one is migration (AC-1)", async () => {
    const { repo } = await repoWithOrigin();

    const a = await openSession(repo, "alpha");
    await commitIn(a.worktree!, "docs/rfcs/rfc-9001-alpha.md", "---\nid: RFC-9001\nversionBump: minor\n---\n# A\n");
    await commitIn(a.worktree!, "a.txt", "a", "X-RFC: RFC-9001");
    await integrate(repo, a.branch!);

    const b = await openSession(repo, "beta");
    await commitIn(b.worktree!, "b.txt", "b");
    await integrate(repo, b.branch!);

    const data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.develop.ahead).toBe(3); // A's two commits + B's one

    const integrations = data.items.filter((i) => i.kind === "integration");
    expect(integrations).toHaveLength(2);
    expect(integrations[0]!.branch).toBe(a.branch);
    expect(integrations[0]!.category).toBe("migration");
    expect(integrations[0]!.rfcs).toEqual(["RFC-9001"]);
    expect(integrations[1]!.branch).toBe(b.branch);
    expect(integrations[1]!.category).toBe("other");
    expect(data.byCategory["migration"]).toEqual([integrations[0]!.id]);
  }, 60_000);

  it("classifies one item per risk category", async () => {
    const { repo } = await repoWithOrigin();
    await pushedCommit(repo, "package.json", JSON.stringify({
      name: "x",
      version: "0.1.0",
      exports: { ".": "./a.js", "./extra": "./x.js" },
      dependencies: { dep: "^1.0.0" },
    }, null, 2) + "\n");

    await unpushedCommit(repo, "docs/specs/spec-a.md", "# spec\n");
    let data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.items.at(-1)!.category).toBe("contract");

    await pushedCommit(repo, "marker1.txt", "boundary\n");
    await unpushedCommit(repo, "rules.ts", "// @ai-invariant keep sorted\nexport const x = 1;\n");
    data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.items.at(-1)!.category).toBe("invariant");

    await pushedCommit(repo, "marker2.txt", "boundary\n");
    await unpushedCommit(repo, "package.json", JSON.stringify({
      name: "x",
      version: "0.1.0",
      exports: { ".": "./a.js" },
      dependencies: { dep: "^1.0.0" },
    }, null, 2) + "\n");
    data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.items.at(-1)!.category).toBe("capability-removal");

    await pushedCommit(repo, "marker3.txt", "boundary\n");
    await unpushedCommit(repo, "package.json", JSON.stringify({
      name: "x",
      version: "0.1.0",
      exports: { ".": "./a.js" },
      dependencies: { dep: "^2.0.0" },
    }, null, 2) + "\n");
    data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.items.at(-1)!.category).toBe("major-dependency");

    await pushedCommit(repo, "marker4.txt", "boundary\n");
    await unpushedCommit(repo, "plain.txt", "nothing special\n");
    data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.items.at(-1)!.category).toBe("other");
    expect(data.items.at(-1)!.kind).toBe("unattributed");
  }, 90_000);

  it("the same state gives the same digestId; one more commit changes it", async () => {
    const { repo } = await repoWithOrigin();
    await unpushedCommit(repo, "one.txt", "1\n");
    const first = await collectDigest(repo, ambientIo, { fetch: false });
    const again = await collectDigest(repo, ambientIo, { fetch: false });
    expect(again.digestId).toBe(first.digestId);

    await unpushedCommit(repo, "two.txt", "2\n");
    const moved = await collectDigest(repo, ambientIo, { fetch: false });
    expect(moved.digestId).not.toBe(first.digestId);
    expect(moved.develop.ahead).toBe(first.develop.ahead + 1);
  }, 40_000);

  it("lists local release tags absent from origin", async () => {
    const { repo } = await repoWithOrigin();
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    await writeReleaseTag(repo, ambientIo, {
      name: "v0.1.0",
      target: tip,
      annotation: releaseTagAnnotation({
        tag: "v0.1.0",
        line: "repo",
        version: "0.1.0",
        level: "baseline",
        previous: null,
        rfcs: [],
        fingerprints: {},
      }),
    });
    const data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.tags).toEqual(["v0.1.0"]);

    await gitExec(repo, ["push", "origin", "v0.1.0"]);
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.tags).toEqual([]);
    expect(after.digestId).not.toBe(data.digestId);
  }, 40_000);

  it("RFC-1498 AC-7: a pushed tag maps to the workflows its on.push.tags filter matches", async () => {
    const { repo } = await repoWithOrigin();
    await mkdir(join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(repo, ".github", "workflows", "publish.yml"),
      "name: publish\non:\n  push:\n    tags: ['v*']\n",
    );
    await writeFile(
      join(repo, ".github", "workflows", "lib-only.yml"),
      "name: lib\non:\n  push:\n    tags:\n      - 'lib@*'\n",
    );
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    await writeReleaseTag(repo, ambientIo, {
      name: "v1.0.1",
      target: tip,
      annotation: releaseTagAnnotation({
        tag: "v1.0.1",
        line: "repo",
        version: "1.0.1",
        level: "baseline",
        previous: null,
        rfcs: [],
        fingerprints: {},
      }),
    });
    const data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.diagnostics.some((d) => d.ruleId === "FLOW-11")).toBe(false);
    const entry = data.tagTriggers.find((t) => t.tag === "v1.0.1");
    expect(entry).toBeDefined();
    expect(entry!.workflows).toEqual([".github/workflows/publish.yml"]);
  }, 60_000);

  it("RFC-1498 AC-8: a malformed workflow reports FLOW-11 and the digest still returns", async () => {
    const { repo } = await repoWithOrigin();
    await mkdir(join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(repo, ".github", "workflows", "broken.yml"),
      "name: broken\non: [push\n",
    );
    await writeFile(
      join(repo, ".github", "workflows", "fancy.yml"),
      "name: fancy\non:\n  push:\n    tags: ['v[0-9]*']\n",
    );
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    await writeReleaseTag(repo, ambientIo, {
      name: "v1.0.1",
      target: tip,
      annotation: releaseTagAnnotation({
        tag: "v1.0.1",
        line: "repo",
        version: "1.0.1",
        level: "baseline",
        previous: null,
        rfcs: [],
        fingerprints: {},
      }),
    });
    const data = await collectDigest(repo, ambientIo, { fetch: false });
    // The digest still lands — FLOW-11 is a warning, never a refusal.
    expect(data.digestId).not.toBe("");
    expect(data.tags).toEqual(["v1.0.1"]);
    const flow11 = data.diagnostics.filter((d) => d.ruleId === "FLOW-11");
    expect(flow11.some((d) => d.file === ".github/workflows/broken.yml")).toBe(true);
    // A character-class pattern is reported as not understood and matches nothing.
    expect(flow11.some((d) => d.message.includes("v[0-9]*"))).toBe(true);
    expect(flow11.every((d) => d.severity === "warning")).toBe(true);
    expect(data.tagTriggers.find((t) => t.tag === "v1.0.1")).toBeUndefined();
  }, 60_000);

  it("reports FLOW-PUSH-01 without an origin remote", async () => {
    const repo = await initRepo({ prefix: "flow-digest-noorigin-" });
    dirs.push(repo);
    const data = await collectDigest(repo, ambientIo, { fetch: false });
    expect(data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-01" && d.severity === "error")).toBe(true);
    expect(data.fetched).toBe(false);
  }, 30_000);
});
