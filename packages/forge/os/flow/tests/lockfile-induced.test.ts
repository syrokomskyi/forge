/*
<MODULE_CONTRACT>
<purpose>ADR-0130 (F-0201): the induced-change lockfile shapes —
  importer-materialize with `optional: true` removals and `key:` → `key: {}`
  collapses on reachable snapshots, and importer-prune with inverse induced
  additions — classify into their tolerated classes instead of `work`, while
  a real content change (a version bump) stays `work`.</purpose>
<non-goals>
  <item>No integrate-level restore coverage — the foreign-open-mission restore
    path itself is covered in the preflight/integrate suites; these tests pin
    the classification boundary the sweep depends on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>ADR-0130: induced-change lockfile classifiers — materialize BFS reachability + prune induced additions</item>
  <item>ADR-0130: induced-change lockfile classifiers — BFS reachability for optional-flag removals, collapse pairs, induced packages/snapshots additions</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ambientIo } from "../../../src/utils/io.ts";
import {
  classifyLockfileMaterializeExtended,
  classifyLockfilePruneIdsExtended,
} from "../preflight.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Fixture cut from commit 9fc5be128 (importer materialize + induced removals):
// HEAD lacks the mission importer; the working file gains it plus
// `optional: true` removals and a `buffer-from` collapse on reachable snapshots.
const HEAD_MATERIALIZE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      yaml:
        specifier: ^2.9.1
        version: 2.9.1

packages:

  yaml@2.9.1:
    resolution: {integrity: sha1}

  buffer-from@1.1.2:
    resolution: {integrity: sha2}

  buffer-crc32@0.2.13:
    resolution: {integrity: sha3}

snapshots:

  yaml@2.9.1: {}

  buffer-crc32@0.2.13:
    optional: true

  buffer-from@1.1.2:
    optional: true
`;

const DIFF_MATERIALIZE = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index aaa..bbb 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -5,7 +5,15 @@ importers:
   .:
     dependencies:
       yaml:
         specifier: ^2.9.1
         version: 2.9.1
 
+  missions/site-m000001/workpiece:
+    dependencies:
+      buffer-from:
+        specifier: ^1.1.2
+        version: 1.1.2
+      buffer-crc32:
+        specifier: ^0.2.13
+        version: 0.2.13
+
 packages:
@@ -22,10 +30,9 @@ snapshots:
 
   yaml@2.9.1: {}
 
   buffer-crc32@0.2.13:
-    optional: true
 
-  buffer-from@1.1.2:
-    optional: true
+  buffer-from@1.1.2: {}
 
`;

const WORK_MATERIALIZE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      yaml:
        specifier: ^2.9.1
        version: 2.9.1

  missions/site-m000001/workpiece:
    dependencies:
      buffer-from:
        specifier: ^1.1.2
        version: 1.1.2
      buffer-crc32:
        specifier: ^0.2.13
        version: 0.2.13

packages:

  yaml@2.9.1:
    resolution: {integrity: sha1}

  buffer-from@1.1.2:
    resolution: {integrity: sha2}

  buffer-crc32@0.2.13:
    resolution: {integrity: sha3}

snapshots:

  yaml@2.9.1: {}

  buffer-crc32@0.2.13:

  buffer-from@1.1.2: {}
`;

// Fixture cut from commit 391abcfaf (importer prune + induced additions):
// HEAD carries the mission importer; the working file drops it and gains
// `optional: true`/`transitivePeerDependencies`/snapshot entries.
const HEAD_PRUNE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      yaml:
        specifier: ^2.9.1
        version: 2.9.1

  missions/site-m000001/workpiece:
    dependencies:
      buffer-from:
        specifier: ^1.1.2
        version: 1.1.2

packages:

  yaml@2.9.1:
    resolution: {integrity: sha1}

  buffer-from@1.1.2:
    resolution: {integrity: sha2}

snapshots:

  yaml@2.9.1: {}

  buffer-from@1.1.2: {}
`;

const DIFF_PRUNE = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index ccc..ddd 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -9,7 +9,4 @@ importers:
         specifier: ^2.9.1
         version: 2.9.1
 
-  missions/site-m000001/workpiece:
-    dependencies:
-      buffer-from:
-        specifier: ^1.1.2
-        version: 1.1.2
 
 packages:
@@ -25,6 +22,13 @@ snapshots:
 
   yaml@2.9.1: {}
 
-  buffer-from@1.1.2: {}
+  buffer-from@1.1.2:
+    optional: true
+
+  buffer-crc32@0.2.13:
+    dependencies:
+      x: 1.0.0
+    transitivePeerDependencies:
+      - prettier
+    optional: true
 
`;

const DIFF_VERSION_BUMP = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index eee..fff 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -5,6 +5,11 @@ importers:
   .:
     dependencies:
       yaml:
-        specifier: ^2.9.1
-        version: 2.9.1
+        specifier: ^3.0.0
+        version: 3.0.0
+
+  missions/site-m000001/workpiece:
+    dependencies:
+      buffer-from:
+        specifier: ^1.1.2
+        version: 1.1.2
+
 packages:
`;

describe("classifyLockfileMaterializeExtended — ADR-0130", () => {
  it("the 9fc5be128 shape (importer add + optional removals + collapse) classifies importer-materialize", () => {
    expect(
      classifyLockfileMaterializeExtended(DIFF_MATERIALIZE, HEAD_MATERIALIZE, WORK_MATERIALIZE),
    ).toEqual(["site-m000001"]);
  });

  it("an `optional: true` removal on an unreachable snapshot keeps the diff unattributed", () => {
    // drop buffer-crc32 from the mission's deps — its optional removal is
    // then outside the added importers' closure.
    const narrowed = WORK_MATERIALIZE.replace(
      `      buffer-crc32:
        specifier: ^0.2.13
        version: 0.2.13
`,
      "",
    );
    expect(
      classifyLockfileMaterializeExtended(DIFF_MATERIALIZE, HEAD_MATERIALIZE, narrowed),
    ).toBeNull();
  });
});

describe("classifyLockfilePruneIdsExtended — ADR-0130", () => {
  it("the 391abcfaf shape (importer prune + induced additions) returns the pruned ids", () => {
    expect(classifyLockfilePruneIdsExtended(DIFF_PRUNE, HEAD_PRUNE)).toEqual(["site-m000001"]);
  });

  it("a version-string change inside the diff keeps the diff unattributed", () => {
    expect(classifyLockfilePruneIdsExtended(DIFF_VERSION_BUMP, HEAD_MATERIALIZE)).toBeNull();
    expect(
      classifyLockfileMaterializeExtended(DIFF_VERSION_BUMP, HEAD_MATERIALIZE, WORK_MATERIALIZE),
    ).toBeNull();
  });
});

describe("classifyDirt — induced shapes (ADR-0130)", () => {
  it("the 391abcfaf shape against a foreign open mission classifies foreign-open-mission (restored, not swept)", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    // classifyDirt reads the working lockfile through io — content is
    // irrelevant for the prune direction (only HEAD text + diff are used).
    await writeFile(join(repo, "pnpm-lock.yaml"), HEAD_PRUNE);
    const runGit = async (_cwd: string, _io: unknown, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("diff")) return { exitCode: 0, stdout: DIFF_PRUNE, stderr: "" };
      if (joined.includes("show")) return { exitCode: 0, stdout: HEAD_PRUNE, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const verdict = await classifyDirt(
      repo,
      ambientIo,
      [" M pnpm-lock.yaml"],
      { runGit: runGit as never },
      [],
      async (ids) =>
        ids.map((missionId) => ({
          missionId,
          existsHere: false,
          existsInCheckout: ["/repo@auto/foreign"],
          missionOpen: true,
        })),
    );
    expect(verdict.tolerated).toEqual([
      {
        path: "pnpm-lock.yaml",
        class: "foreign-open-mission",
        missionIds: ["site-m000001"],
      },
    ]);
    expect(verdict.unattributed).toEqual([]);
  });

  it("the 9fc5be128 shape with an open mission classifies importer-materialize", async () => {
    const { classifyDirt } = await import("../preflight.ts");
    const repo = await mkdtemp(join(tmpdir(), "dirt-"));
    dirs.push(repo);
    await writeFile(join(repo, "pnpm-lock.yaml"), WORK_MATERIALIZE);
    // the mission must read as open — openMissionsIn globs missions/*/mission.yaml
    await mkdir(join(repo, "missions/site-m000001"), { recursive: true });
    await writeFile(join(repo, "missions/site-m000001/mission.yaml"), 'state: "open"\n');
    const runGit = async (_cwd: string, _io: unknown, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("diff")) return { exitCode: 0, stdout: DIFF_MATERIALIZE, stderr: "" };
      if (joined.includes("show")) return { exitCode: 0, stdout: HEAD_MATERIALIZE, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const verdict = await classifyDirt(repo, ambientIo, [" M pnpm-lock.yaml"], {
      runGit: runGit as never,
    });
    expect(verdict.tolerated).toEqual([{ path: "pnpm-lock.yaml", class: "importer-materialize" }]);
    expect(verdict.unattributed).toEqual([]);
  });
});
