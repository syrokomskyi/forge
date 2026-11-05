/*
<MODULE_CONTRACT>
<purpose>AC-5: the POSIX guard and the TypeScript grammar must not drift —
the literal regex text inside assets/flow-guard.sh is byte-identical to
FLOW_BRANCH_PATTERN, and the installed guard's verdict on every creatable
branch name of the shared table equals classifyBranch's.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 2 — shell/TypeScript grammar parity test</item>
  <item>RFC-1486: step 2 — POSIX guard asset + behavior/parity tests</item>
  <item>RFC-1486: parity test explicit timeout for repo-root probe runs (AC-5)</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

import { classifyBranch, FLOW_BRANCH_PATTERN } from "../branch-name.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  checkoutOrCreate,
  GUARD_ASSET,
  initRepo,
  runGuardDirect,
} from "./helpers.ts";

interface NameRow {
  name: string;
  verdict: "allow" | "refuse";
  rule: "FLOW-GUARD-01" | "FLOW-GUARD-02" | null;
  ref_ok: boolean;
}

const table = yamlParse(
  readFileSync(fileURLToPath(new URL("./fixtures/branch-names.yaml", import.meta.url)), "utf8"),
) as { rows: NameRow[] };

let repo: string | undefined;

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("guard/TypeScript grammar parity", () => {
  it("the regex literal in flow-guard.sh is byte-identical to FLOW_BRANCH_PATTERN", () => {
    const asset = readFileSync(GUARD_ASSET, "utf8");
    expect(asset).toContain(`flow_branch_pattern='${FLOW_BRANCH_PATTERN}'`);
    // The documentation marker and the closed FORGE_FLOW_OP vocabulary that
    // AC-11's probe greps for.
    expect(asset).toContain(">>> forge flow guard");
    expect(asset).toContain("pre-merge-commit");
    expect(asset).toContain("install");
  });

  it("is valid POSIX sh and carries no bashisms", async () => {
    const check = await ambientIo.exec("sh", ["-n", GUARD_ASSET]);
    expect(check.exitCode, check.stderr).toBe(0);
    const asset = readFileSync(GUARD_ASSET, "utf8");
    for (const bashism of ["[[", "local ", "==[", "function ", "source "]) {
      expect(asset, `flow-guard.sh must not contain bashism ${bashism}`).not.toContain(bashism);
    }
  });

  // The row loop spawns real `git`/`sh` processes — comfortably over the
  // 5s default timeout the root vitest config applies under
  // `rfc.acceptance.run`'s repo-root probe invocation.
  it("guard verdicts equal classifyBranch on every creatable table row", { timeout: 120_000 }, async () => {
    // One throwaway repo; the guard file is invoked directly (no hooksPath
    // needed) — the guard resolves the repo through cwd/git rev-parse.
    repo = await initRepo({ prefix: "flow-parity-" });
    const hooksDir = join(repo, "hooks");
    await mkdir(hooksDir, { recursive: true });
    await copyFile(GUARD_ASSET, join(hooksDir, "flow-guard.sh"));

    const skipped: string[] = [];
    // Case-insensitive ref backends (Windows, default macOS) cannot hold a
    // second spelling of a ref the table already probed — `AUTO/x` and
    // `auto/X` are the same ref there. The grammar/classify check still
    // runs for every row; only the git probe is deduplicated.
    const probed = new Set<string>();
    for (const row of table.rows) {
      if (!row.ref_ok) {
        skipped.push(row.name);
        continue;
      }
      const cls = classifyBranch(row.name);
      const expectedRule =
        cls.kind === "protected"
          ? "FLOW-GUARD-01"
          : cls.kind === "nonconforming"
            ? "FLOW-GUARD-02"
            : null;
      expect(expectedRule, `classifyBranch("${row.name}") must agree with the table`).toBe(
        row.rule,
      );
      const caseKey = row.name.toLowerCase();
      if (probed.has(caseKey)) continue;
      probed.add(caseKey);
      await checkoutOrCreate(repo, row.name);
      const result = await runGuardDirect(repo, { FORGE_FLOW_OP: "" });
      if (expectedRule === null) {
        expect(result.exitCode, `guard must allow "${row.name}": ${result.stderr}`).toBe(0);
      } else {
        expect(result.exitCode, `guard must refuse "${row.name}"`).toBe(1);
        expect(result.stderr, `guard rule for "${row.name}"`).toContain(`${expectedRule}:`);
      }
    }

    // Rows git cannot create as refs are exactly the uncreatable names — and
    // each of them is a refuse verdict (never an allow we failed to probe).
    const uncreatable = table.rows.filter((row) => !row.ref_ok).map((row) => row.name);
    expect(skipped).toEqual(uncreatable);
    for (const name of skipped) {
      expect(classifyBranch(name).kind, `uncreatable "${name}"`).toBe("nonconforming");
    }
  });
});
