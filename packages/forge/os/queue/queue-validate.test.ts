import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runQueueValidate } from "./handlers/queue-validate.ts";
import { loadQueueManifest } from "./manifest.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-validate-test-"));
  await fs.mkdir(path.join(tmpDir, "docs/rfcs"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "docs/adrs"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "docs/queues"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function testContext(): ForgeRuntimeContext {
  const logs: string[] = [];
  return {
    workspaceRoot: tmpDir,
    dryRun: false,
    outputFormat: "json",
    logger: {
      section: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      success: (m: string) => logs.push(m),
    },
  };
}

async function writeRfc(id: string, frontmatter = "status: draft\n"): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, `docs/rfcs/${id.toLowerCase()}-test.md`),
    `---\nid: ${id}\n${frontmatter}---\n# ${id}\n`,
  );
}

async function writeManifest(name: string, body: string): Promise<string> {
  const rel = `docs/queues/${name}.yaml`;
  await fs.writeFile(path.join(tmpDir, rel), body);
  return rel;
}

describe("loadQueueManifest — validation rules (RFC-1140)", () => {
  test("valid manifest loads with no errors", async () => {
    await writeRfc("RFC-1300");
    const file = await writeManifest(
      "block-a",
      "id: block-a\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-1300\n",
    );
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors).toEqual([]);
  });

  test("id↔filename mismatch → QUEUE-02 blocking error", async () => {
    await writeRfc("RFC-1301");
    const file = await writeManifest(
      "block-b",
      "id: different-id\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-1301\n",
    );
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors.some((e) => e.ruleId === "QUEUE-02")).toBe(true);
  });

  test("malformed item id → QUEUE-03", async () => {
    const file = await writeManifest(
      "block-c",
      "id: block-c\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-13\n",
    );
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors.some((e) => e.ruleId === "QUEUE-03")).toBe(true);
  });

  test("unresolvable item id → QUEUE-04", async () => {
    const file = await writeManifest(
      "block-d",
      "id: block-d\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-9999\n",
    );
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors.some((e) => e.ruleId === "QUEUE-04")).toBe(true);
  });

  test("duplicate item id → QUEUE-05", async () => {
    await writeRfc("RFC-1305");
    const file = await writeManifest(
      "block-e",
      "id: block-e\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-1305\n  - id: RFC-1305\n",
    );
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors.some((e) => e.ruleId === "QUEUE-05")).toBe(true);
  });

  test("dependsOn order violation → QUEUE-06 warning, not blocking", async () => {
    await writeRfc("RFC-1310");
    await writeRfc("RFC-1311", "status: draft\ndependsOn:\n  - RFC-1310\n");
    const file = await writeManifest(
      "block-f",
      "id: block-f\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-1311\n  - id: RFC-1310\n",
    );
    const { errors, warnings } = await loadQueueManifest(tmpDir, file);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.ruleId === "QUEUE-06")).toBe(true);
  });

  test("empty items is valid", async () => {
    const file = await writeManifest("block-g", "id: block-g\ncreatedAt: 2026-09-23\nitems: []\n");
    const { errors } = await loadQueueManifest(tmpDir, file);
    expect(errors).toEqual([]);
  });
});

async function writeLedger(manifestName: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `docs/queues/${manifestName}.decisions.yaml`), body);
}

const LEDGER_HEADER = (id: string) => `id: ${id}.decisions\nqueue: ${id}\ncreatedAt: 2026-10-09\n`;

describe("runQueueValidate — decision ledger (RFC-1250)", () => {
  test("implement-stage item with open entry → QUEUE-07 + exitCode 1 (AC-2)", async () => {
    await writeRfc("RFC-1500", "status: accepted\n");
    const file = await writeManifest(
      "block-q7",
      "id: block-q7\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1500\n",
    );
    await writeLedger(
      "block-q7",
      `${LEDGER_HEADER("block-q7")}items:\n  - id: Q-1\n    doc: RFC-1500\n    stage: plan\n    question: which scope?\n    resolutionPath: none\n    status: open\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(true);
    expect(result?.data?.items[0]?.decisions?.open).toBe(1);
  });

  test("no QUEUE-07 when entries are answered/auto-resolved/deferred (AC-3)", async () => {
    await writeRfc("RFC-1501", "status: accepted\n");
    const file = await writeManifest(
      "block-q7b",
      "id: block-q7b\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1501\n",
    );
    await writeLedger(
      "block-q7b",
      `${LEDGER_HEADER("block-q7b")}items:\n  - id: Q-1\n    doc: RFC-1501\n    stage: plan\n    question: a\n    resolutionPath: none\n    status: answered\n  - id: Q-2\n    doc: RFC-1501\n    stage: implement\n    question: b\n    resolutionPath: convention\n    status: auto-resolved\n  - id: Q-3\n    doc: RFC-1501\n    stage: review\n    question: c\n    resolutionPath: none\n    status: deferred\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(false);
    expect(result?.data?.status).toBe("pass");
    const d = result?.data?.items[0]?.decisions;
    expect(d?.open).toBe(0);
    expect(d?.deferred).toBe(1);
    expect(d?.autoResolved).toBe(1);
  });

  test("no ledger sibling → no QUEUE-07 (AC-4)", async () => {
    await writeRfc("RFC-1502", "status: accepted\n");
    const file = await writeManifest(
      "block-q7c",
      "id: block-q7c\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1502\n",
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.errors).toEqual([]);
    expect(result?.data?.items[0]?.decisions).toBeUndefined();
  });

  test("open entries on pre-implement stages stay legal — no QUEUE-07", async () => {
    await writeRfc("RFC-1503"); // status: draft, no artifacts → pending
    const file = await writeManifest(
      "block-q7d",
      "id: block-q7d\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1503\n",
    );
    await writeLedger(
      "block-q7d",
      `${LEDGER_HEADER("block-q7d")}items:\n  - id: Q-1\n    doc: RFC-1503\n    stage: enhance\n    question: q\n    resolutionPath: none\n    status: open\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(false);
    expect(result?.data?.status).toBe("pass");
  });

  test("pending ADR with open entry → QUEUE-07", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/adrs/adr-1504-test.md"),
      "---\nid: ADR-1504\nstatus: proposed\n---\n# ADR-1504\n",
    );
    const file = await writeManifest(
      "block-q7e",
      "id: block-q7e\ncreatedAt: 2026-10-09\nitems:\n  - id: ADR-1504\n",
    );
    await writeLedger(
      "block-q7e",
      `${LEDGER_HEADER("block-q7e")}items:\n  - id: Q-1\n    doc: ADR-1504\n    stage: implement\n    question: which adapter?\n    resolutionPath: none\n    status: open\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(true);
    expect(result?.exitCode).toBe(1);
  });

  test("next skips deferred and parked items, dependsOn cascades (AC-5)", async () => {
    await writeRfc("RFC-1510", "status: accepted\n");
    await writeRfc("RFC-1511", "status: draft\ndependsOn:\n  - RFC-1510\n");
    await writeRfc("RFC-1512");
    const file = await writeManifest(
      "block-park",
      "id: block-park\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1510\n  - id: RFC-1511\n  - id: RFC-1512\n",
    );
    // RFC-1510 operator-deferred → parked; RFC-1511 dependsOn it → cascade-parked;
    // next must be RFC-1512.
    await writeLedger(
      "block-park",
      `${LEDGER_HEADER("block-park")}items:\n  - id: Q-1\n    doc: RFC-1510\n    stage: implement\n    question: park it\n    resolutionPath: none\n    status: deferred\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.next).toBe("RFC-1512");
  });

  test("next skips items with open+parked entries (hard-stop)", async () => {
    await writeRfc("RFC-1520", "status: accepted\n");
    await writeRfc("RFC-1521");
    const file = await writeManifest(
      "block-park2",
      "id: block-park2\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1520\n  - id: RFC-1521\n",
    );
    await writeLedger(
      "block-park2",
      `${LEDGER_HEADER("block-park2")}items:\n  - id: Q-1\n    doc: RFC-1520\n    stage: implement\n    question: destructive op\n    resolutionPath: none\n    status: open\n    parked: true\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.next).toBe("RFC-1521");
  });
});

describe("runQueueValidate — command contract (RFC-1140)", () => {
  test("throws without --file", async () => {
    await expect(runQueueValidate({ argv: [], flags: {} }, testContext())).rejects.toThrow(
      "--file",
    );
  });

  test("valid manifest → pass, items + next in JSON output", async () => {
    await writeRfc("RFC-1400", "status: implemented\n");
    await writeRfc("RFC-1401");
    const file = await writeManifest(
      "block-h",
      "id: block-h\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-1400\n  - id: RFC-1401\n",
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.queue).toBe("block-h");
    expect(result?.data?.items).toHaveLength(2);
    expect(result?.data?.items[0]?.status).toBe("implemented");
    expect(result?.data?.items[1]?.status).toBe("pending");
    expect(result?.data?.next).toBe("RFC-1401");
    expect(result?.exitCode).toBe(0);
  });

  test("invalid manifest → fail + exitCode 1", async () => {
    const file = await writeManifest(
      "block-i",
      "id: block-i\ncreatedAt: 2026-09-23\nitems:\n  - id: RFC-9999\n",
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.exitCode).toBe(1);
    expect(result?.data?.errors.length).toBeGreaterThan(0);
  });

  test("empty items → pass with next null", async () => {
    const file = await writeManifest("block-j", "id: block-j\ncreatedAt: 2026-09-23\nitems: []\n");

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.items).toEqual([]);
    expect(result?.data?.next).toBeNull();
  });
});
