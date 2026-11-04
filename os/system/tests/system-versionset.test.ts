/*
<MODULE_CONTRACT>
<purpose>system.versionset.record tests (RFC-1511) — governed product
repositories under os.tmpdir() with annotated forge/release-tag@1 tags; checks
run argv vectors (process.execPath -e or git) inside detached tag worktrees.
Covers AC-1..AC-8 plus SYSTEM-VS-01/02/03 diagnostics.</purpose>
<non-goals>
  <item>No real flow/mission commands — direct handler invocation only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1511: step 1 — versionset test harness</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { ForgeCommandInput, ForgeFlagValue } from "../../../src/types.ts";
import { gitExec } from "../../flow/tests/helpers.ts";
import { runSystemVersionSetRecord } from "../handlers/system-versionset-record.ts";
import { versionSetSchema } from "../scenario-schemas.ts";
import {
  localMapFor,
  makeContext,
  makeProduct,
  makeSystemRepo,
  VALID_EDGES_YAML,
  VALID_PRODUCTS_YAML,
  VALID_SYSTEM_YAML,
} from "./helpers.ts";

const TAG = "v1.0.0";

function input(flags: Record<string, ForgeFlagValue> = {}): ForgeCommandInput {
  return { argv: [], flags };
}

/** The release-tag annotation a real flow.cut writes (forge/release-tag@1). */
const RELEASE_ANNOTATION = [
  "release v1.0.0",
  "",
  "schema: forge/release-tag@1",
  "line: v",
  "version: 1.0.0",
  "level: minor",
  "previous: null",
  'rfcs: ["RFC-0001"]',
  "fingerprints: {}",
].join("\n");

async function tagProduct(root: string, tag = TAG, annotation = RELEASE_ANNOTATION): Promise<void> {
  const res = await gitExec(root, ["tag", "-a", tag, "HEAD", "-m", annotation]);
  if (res.exitCode !== 0) throw new Error(`tag failed: ${res.stderr}`);
}

function scenarioYaml(id: string, checks: { product: string; argv: string[]; timeoutSec?: number }[]): string {
  const checksYaml = checks
    .map(
      (c) =>
        `  - product: ${c.product}\n    argv: ${JSON.stringify(c.argv)}` +
        (c.timeoutSec !== undefined ? `\n    timeoutSec: ${c.timeoutSec}` : ""),
    )
    .join("\n");
  return `schema: forge/system-scenario@1
id: ${id}
title: ${id} fixture
products: [${[...new Set(checks.map((c) => c.product))].join(", ")}]
contracts: []
checks:
${checksYaml}
`;
}

interface Fixture {
  systemRoot: string;
  alpha: string;
  beta: string;
}

/** System repo + two governed products, each carrying an annotated release tag. */
async function fixture(files: Record<string, string> = {}): Promise<Fixture> {
  const alpha = await makeProduct();
  const beta = await makeProduct();
  await tagProduct(alpha);
  await tagProduct(beta);
  const systemRoot = await makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor({ alpha, beta }),
    ...files,
  });
  return { systemRoot, alpha, beta };
}

async function worktreePaths(repo: string): Promise<string[]> {
  const res = await gitExec(repo, ["worktree", "list", "--porcelain"]);
  return res.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

describe("system.versionset.record", () => {
  it("AC-1+AC-2: all-green checks write VS-0001 with sha256 evidence per scenario", async () => {
    const { systemRoot } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('ok')"] },
        { product: "beta", argv: [process.execPath, "-e", "console.log('ok-beta')"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG},beta=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data!.created).toBe(true);
    const setFile = YAML.parse(
      await readFile(path.join(systemRoot, "system/version-sets/VS-0001.yaml"), "utf8"),
    );
    const parsed = versionSetSchema.safeParse(setFile);
    expect(parsed.success).toBe(true);
    expect(setFile.id).toBe("VS-0001");
    expect(setFile.products).toEqual({ alpha: TAG, beta: TAG });
    expect(setFile.evidence["lead-flow"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("AC-3+AC-4: a failing check exits non-zero with SYSTEM-VS-04 and writes no set", async () => {
    const { systemRoot } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "process.exit(3)"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG},beta=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-04")).toBe(true);
    expect(result.data!.created).toBe(false);
    await expect(
      readFile(path.join(systemRoot, "system/version-sets/VS-0001.yaml"), "utf8"),
    ).rejects.toThrow();
    // the log stays for reading
    const log = await readFile(
      path.join(systemRoot, "system/version-sets/evidence/VS-0001/lead-flow.log"),
      "utf8",
    );
    expect(log).toContain("process.exit(3)");
  });

  it("AC-5: a check's cwd is the detached checkout of the named tag", async () => {
    const { systemRoot, alpha } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: ["git", "rev-parse", "HEAD"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG},beta=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    const tagged = await gitExec(alpha, ["rev-parse", `${TAG}^{commit}`]);
    const log = await readFile(
      path.join(systemRoot, "system/version-sets/evidence/VS-0001/lead-flow.log"),
      "utf8",
    );
    expect(log).toContain(tagged.stdout.trim());
  });

  it("AC-6: no temporary worktree survives the run", async () => {
    const { systemRoot, alpha, beta } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
        { product: "beta", argv: [process.execPath, "-e", "console.log('y')"] },
      ]),
    });
    await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG},beta=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    for (const repo of [alpha, beta]) {
      const paths = await worktreePaths(repo);
      expect(paths).toEqual([repo]);
    }
  });

  it("AC-7: a non-release tag exits non-zero with SYSTEM-VS-03", async () => {
    const { systemRoot, alpha } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
      ]),
    });
    await tagProduct(alpha, "v9.9.9", "not a release annotation");
    const result = await runSystemVersionSetRecord(
      input({ products: "alpha=v9.9.9", scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-03")).toBe(true);
  });

  it("AC-7b: a missing tag exits non-zero with SYSTEM-VS-03", async () => {
    const { systemRoot } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: "alpha=v8.8.8", scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-03")).toBe(true);
  });

  it("AC-8: --dry-run creates no worktree and writes nothing", async () => {
    const { systemRoot, alpha } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG}`, scenarios: "lead-flow", "dry-run": true }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    expect(await worktreePaths(alpha)).toEqual([alpha]);
    await expect(
      readFile(path.join(systemRoot, "system/version-sets/VS-0001.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("SYSTEM-VS-01: an unknown scenario id is an error", async () => {
    const { systemRoot } = await fixture();
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG}`, scenarios: "ghost" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-01")).toBe(true);
  });

  it("SYSTEM-VS-01: a malformed --products entry is an error", async () => {
    const { systemRoot } = await fixture();
    const result = await runSystemVersionSetRecord(
      input({ products: "alpha-no-equals", scenarios: "x" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-01")).toBe(true);
  });

  it("SYSTEM-VS-02: a scenario product missing from --products is an error", async () => {
    const { systemRoot } = await fixture({
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `beta=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-VS-02")).toBe(true);
  });

  it("SYSTEM-VS-04: a check exceeding timeoutSec is a failure", async () => {
    const { systemRoot } = await fixture({
      "system/scenarios/slow.yaml": scenarioYaml("slow", [
        { product: "alpha", argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], timeoutSec: 1 },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG}`, scenarios: "slow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "SYSTEM-VS-04" && d.message.includes("timed out"),
      ),
    ).toBe(true);
    expect(result.data!.created).toBe(false);
  }, 20000);

  it("ids continue from the highest existing VS-NNNN", async () => {
    const { systemRoot } = await fixture({
      "system/version-sets/VS-0007.yaml": `schema: forge/version-set@1
id: VS-0007
products: {alpha: v0.9.0}
scenarios: [old]
evidence: {}
verifiedAt: "2026-01-01T00:00:00Z"
`,
      "system/scenarios/lead-flow.yaml": scenarioYaml("lead-flow", [
        { product: "alpha", argv: [process.execPath, "-e", "console.log('x')"] },
      ]),
    });
    const result = await runSystemVersionSetRecord(
      input({ products: `alpha=${TAG}`, scenarios: "lead-flow" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data!.id).toBe("VS-0008");
  });
});
