/*
<MODULE_CONTRACT>
<purpose>Tests for system.outbox.scan (RFC-1510): committed open entries
produce proposals (AC-5), worktree-only entries stay invisible (AC-6),
--create deduplicates by origin (AC-7) with proposed state (AC-8), forbidden
edges create nothing (AC-9) and a product forge.yaml naming the system id
reports SYSTEM-OUTBOX-03 (AC-10).</purpose>
<non-goals><item>Entry-file validation coverage lives in outbox-validate.test.ts.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1510: step 1 — system.outbox.scan tests</item>
  <item>RFC-1510: implement RFC-1510 — product outbox for dependency-contract requests</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { gitExec } from "../../flow/tests/helpers.ts";
import { runSystemOutboxScan } from "../handlers/system-outbox-scan.ts";
import { listTasks } from "../task-store.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import {
  localMapFor,
  makeContext,
  makeProduct,
  makeSystemRepo,
  VALID_EDGES_YAML,
  VALID_PRODUCTS_YAML,
  VALID_SYSTEM_YAML,
} from "./helpers.ts";

function input(flags: Record<string, string | string[] | boolean> = {}) {
  return { argv: [], flags };
}

const ENTRY = (id: string, contract = "alpha-contract") => `schema: forge/outbox@1
id: ${id}
contract: ${contract}
need: "a stable surface"
why: "beta composes it"
state: open
`;

interface Fixture {
  systemRoot: string;
  alpha: string;
  beta: string;
}

/** System repo + two governed products; beta = asker, alpha = offerer. */
async function fixture(edges = VALID_EDGES_YAML): Promise<Fixture> {
  const alpha = await makeProduct();
  const beta = await makeProduct();
  const systemRoot = await makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": edges,
    "system/products.local.yaml": localMapFor({ alpha, beta }),
  });
  return { systemRoot, alpha, beta };
}

/** Commit a file into a product's develop checkout. */
async function commitFile(repo: string, rel: string, content: string): Promise<void> {
  const abs = path.join(repo, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await gitExec(repo, ["add", rel]);
  const res = await gitExec(repo, ["commit", "-m", `add ${rel}`]);
  if (res.exitCode !== 0) throw new Error(`fixture commit failed: ${res.stderr}`);
}

describe("system.outbox.scan", () => {
  it("AC-5: a committed open entry proposes the offering product as target", async () => {
    const { systemRoot, beta } = await fixture();
    await commitFile(beta, "docs/outbox/OB-0001.yaml", ENTRY("OB-0001"));
    const result = await runSystemOutboxScan(input(), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    const [p] = result.data!.proposals;
    expect(p).toMatchObject({
      product: "beta",
      entry: "OB-0001",
      contract: "alpha-contract",
      target: "alpha",
      verdict: "allowed",
      taskId: null,
    });
  });

  it("AC-6: an entry living only in a dirty worktree is not listed", async () => {
    const { systemRoot, beta } = await fixture();
    await commitFile(beta, "docs/outbox/OB-0001.yaml", ENTRY("OB-0001"));
    // A second entry exists only as an uncommitted worktree file.
    const dirty = path.join(beta, "docs/outbox/OB-0002.yaml");
    await mkdir(path.dirname(dirty), { recursive: true });
    await writeFile(dirty, ENTRY("OB-0002"));
    const result = await runSystemOutboxScan(input(), makeContext(systemRoot));
    const entries = result.data!.proposals.map((p) => p.entry);
    expect(entries).toEqual(["OB-0001"]);
  });

  it("AC-7+AC-8: --create proposes one task per entry, in state proposed", async () => {
    const { systemRoot, beta } = await fixture();
    await commitFile(beta, "docs/outbox/OB-0001.yaml", ENTRY("OB-0001"));

    const first = await runSystemOutboxScan(input({ create: true }), makeContext(systemRoot));
    expect(first.exitCode).toBe(0);
    expect(first.data!.created).toEqual(["T-0001"]);
    expect(first.data!.proposals[0].taskId).toBe("T-0001");

    const second = await runSystemOutboxScan(input({ create: true }), makeContext(systemRoot));
    expect(second.exitCode).toBe(0);
    expect(second.data!.created).toEqual([]);
    expect(second.data!.proposals[0].taskId).toBe("T-0001");

    const io = resolveIo(undefined);
    const { tasks } = await listTasks(systemRoot, io);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "T-0001",
      product: "alpha",
      slug: "ob-0001",
      state: "proposed",
      origin: { kind: "outbox", ref: "beta:OB-0001" },
      contracts: ["alpha-contract"],
    });
  });

  it("AC-9: a forbidden edge creates no task and refuses the scan", async () => {
    const { systemRoot, beta } = await fixture(
      `schema: forge/system-edges@1
allowed: []
forbidden:
  - consumer: beta
    contract: alpha-contract
    reason: "beta must not consume it"
`,
    );
    await commitFile(beta, "docs/outbox/OB-0001.yaml", ENTRY("OB-0001"));
    const result = await runSystemOutboxScan(input({ create: true }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-OUTBOX-02")).toBe(true);
    expect(result.data!.created).toEqual([]);

    const io = resolveIo(undefined);
    const { tasks } = await listTasks(systemRoot, io);
    expect(tasks).toHaveLength(0);
  });

  it("AC-10: a product forge.yaml naming the system id reports SYSTEM-OUTBOX-03", async () => {
    const { systemRoot, alpha, beta } = await fixture();
    await commitFile(
      alpha,
      "forge.yaml",
      'schema: "forge/workspace@1"\n# adopted from demo-system\n',
    );
    await commitFile(beta, "docs/outbox/OB-0001.yaml", ENTRY("OB-0001"));
    const result = await runSystemOutboxScan(input(), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "SYSTEM-OUTBOX-03" && d.message.includes("alpha"),
      ),
    ).toBe(true);
  });

  it("a product without a local folder is warned and skipped (SYSTEM-OUTBOX-04)", async () => {
    const beta = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ beta }),
    });
    const result = await runSystemOutboxScan(input(), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(
      result.data!.diagnostics.some(
        (d) => d.ruleId === "SYSTEM-OUTBOX-04" && d.message.includes("alpha"),
      ),
    ).toBe(true);
  });

  it("SYSTEM-OUTBOX-01: an unmatched contract proposes target null", async () => {
    const { systemRoot, beta } = await fixture();
    await commitFile(beta, "docs/outbox/OB-0007.yaml", ENTRY("OB-0007", "ghost-contract"));
    const result = await runSystemOutboxScan(input({ create: true }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data!.proposals[0]).toMatchObject({ target: null });
    expect(result.data!.diagnostics.some((d) => d.ruleId === "SYSTEM-OUTBOX-01")).toBe(true);
    expect(result.data!.created).toEqual([]);
  });

  it("served or withdrawn entries are skipped", async () => {
    const { systemRoot, beta } = await fixture();
    await commitFile(
      beta,
      "docs/outbox/OB-0001.yaml",
      ENTRY("OB-0001").replace("state: open", "state: served"),
    );
    const result = await runSystemOutboxScan(input(), makeContext(systemRoot));
    expect(result.data!.proposals).toEqual([]);
  });
});
