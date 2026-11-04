/*
<MODULE_CONTRACT>
<purpose>
RFC-1454: validate-rules-rfc1454 V-49 tests — every `## Deviations` entry's `(review <reviewId>)`
provenance must resolve to a committed review report under the configured
reviewsDir at HEAD (AC-4). Covers dangling review ids, resolvable entries,
malformed section lines, and the no-entries fast path. Uses a real tmp git
repo because the committed-report index reads `git ls-tree`/`git show`.
</purpose>
<non-goals>
  <item>Do not exercise the stamp gate — RFC-IMP-15 is covered by implement-stamp-deviations.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1454: V-49 deviation-provenance validation tests.</item>
  <item>RFC-1454: review deviations recorded in the RFC — IMP-15 gate, V-49 provenance, skill contract</item>
  <item>RFC-1485: sweep compass headers — forge-os-rfc</item>
  <item>RFC-1513: run-scoped committed-review index evidence (AC-1)</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { CommittedReview } from "./implement-stamp-deviations.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

interface Seen {
  rule: string;
  severity?: string;
  message?: string;
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });

/** Tmp workspace: git repo, forge.yaml with reviewsDir, committed review files. */
async function makeWorkspace(reviewFiles: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rfc1454-v49-"));
  await writeFile(
    join(dir, "forge.yaml"),
    `schema: forge/config@1\nproject:\n  name: fixture\npaths: {}\nbindings:\n  schema: forge/bindings@1\n  commands: {}\n  paths:\n    reviewsDir: docs/reviews\n`,
  );
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "forge.yaml"]);
  for (const [path, content] of Object.entries(reviewFiles)) {
    await mkdir(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(dir, path), content);
    git(dir, ["add", path]);
  }
  git(dir, ["commit", "-qm", "fixture"]);
  return dir;
}

const REVIEW = (reviewId: string, rfcId = "RFC-9999") =>
  `---\nreviewId: ${reviewId}\nrfcId: ${rfcId}\n---\n\n# review\n`;

const DEVIATIONS = (lines: string) => `# RFC-9999: Test RFC\n\n## Deviations\n\n${lines}\n`;

const makeParsed = (body: string): ParsedRfc => ({
  frontmatter: {
    id: "RFC-9999",
    title: "Test RFC",
    status: "draft",
    kind: "policy",
    scope: "workspace",
    owners: ["architecture"],
    createdAt: "2026-10-30",
    updatedAt: "2026-10-30",
  },
  body,
});

const runValidate = async (workspaceRoot: string, body: string): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const add: AddViolationFn = (_id, _file, rule, msg, severity) =>
    void seen.push({ rule, severity, message: msg });
  const parsed = makeParsed(body);
  await validateSingleRfc(
    "rfc-9999-test.md",
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    workspaceRoot,
    add,
  );
  return seen;
};

describe("V-49 — deviations provenance resolves to committed reviews (AC-4)", () => {
  test("AC-4: errors when the referenced reviewId has no committed report", async () => {
    const dir = await makeWorkspace({
      "docs/reviews/code/r1.md": REVIEW("REVIEW-1"),
    });
    const seen = await runValidate(
      dir,
      DEVIATIONS("- DEV-1 (review REVIEW-9): something changed."),
    );
    const v49 = seen.filter((v) => v.rule === "V-49");
    expect(v49.length).toBe(1);
    expect(v49[0]!.severity).toBe("error");
    expect(v49[0]!.message).toContain("REVIEW-9");
  });

  test("AC-4: passes when the referenced reviewId resolves", async () => {
    const dir = await makeWorkspace({
      "docs/reviews/code/r1.md": REVIEW("REVIEW-1"),
    });
    const seen = await runValidate(
      dir,
      DEVIATIONS("- DEV-1 (review REVIEW-1): something changed."),
    );
    expect(seen.filter((v) => v.rule === "V-49")).toHaveLength(0);
  });

  test("flags section list lines that do not match the entry grammar", async () => {
    const dir = await makeWorkspace({});
    const seen = await runValidate(
      dir,
      DEVIATIONS("- a note without review provenance"),
    );
    const v49 = seen.filter((v) => v.rule === "V-49");
    expect(v49.length).toBe(1);
    expect(v49[0]!.message).toContain("grammar");
  });

  test("no ## Deviations section → no committed-report scan → no V-49", async () => {
    const dir = await makeWorkspace({});
    const seen = await runValidate(dir, "# RFC-9999: Test RFC\n\nplain body\n");
    expect(seen.filter((v) => v.rule === "V-49")).toHaveLength(0);
  });
});

describe("RFC-1513 — run-scoped committed-review index (AC-1)", () => {
  const runValidateWithIndex = async (
    workspaceRoot: string,
    body: string,
    committedReviews: () => Promise<CommittedReview[]>,
  ): Promise<Seen[]> => {
    const seen: Seen[] = [];
    const add: AddViolationFn = (_id, _file, rule, msg, severity) =>
      void seen.push({ rule, severity, message: msg });
    const parsed = makeParsed(body);
    await validateSingleRfc(
      "rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      workspaceRoot,
      add,
      undefined,
      undefined,
      committedReviews,
    );
    return seen;
  };

  test("the shared getter builds the index at most once across deviation-carrying RFCs", async () => {
    // The injected index names a review the real repo does not carry —
    // a per-RFC collection would report dangling provenance, so a clean
    // V-49 proves the getter (not execGitLog) answered. `builds` counts
    // index constructions behind the memoized promise.
    const dir = await makeWorkspace({
      "docs/reviews/code/r1.md": REVIEW("REVIEW-1"),
    });
    let builds = 0;
    let promise: Promise<CommittedReview[]> | undefined;
    const committedReviews = () => {
      promise ??= (async () => {
        builds++;
        return [
          {
            path: "docs/reviews/code/x.md",
            reviewId: "REVIEW-IDX",
            deviations: [],
          },
        ];
      })();
      return promise;
    };
    const body = DEVIATIONS("- DEV-1 (review REVIEW-IDX): changed.");
    const first = await runValidateWithIndex(dir, body, committedReviews);
    const second = await runValidateWithIndex(dir, body, committedReviews);
    expect(builds, "one index build serves every deviation-carrying RFC").toBe(1);
    expect(first.filter((v) => v.rule === "V-49")).toHaveLength(0);
    expect(second.filter((v) => v.rule === "V-49")).toHaveLength(0);
  });

  test("the getter stays un-consumed for an RFC without ## Deviations entries", async () => {
    const dir = await makeWorkspace({});
    let invoked = 0;
    const committedReviews = async () => {
      invoked++;
      return [];
    };
    const seen = await runValidateWithIndex(dir, "# RFC-9999: Test RFC\n\nplain body\n", committedReviews);
    expect(invoked).toBe(0);
    expect(seen.filter((v) => v.rule === "V-49")).toHaveLength(0);
  });
});
