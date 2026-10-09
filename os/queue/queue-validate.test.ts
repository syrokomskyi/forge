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
      `${LEDGER_HEADER("block-q7b")}items:\n  - id: Q-1\n    doc: RFC-1501\n    stage: plan\n    question: a\n    resolutionPath: none\n    status: answered\n    answer: scope A\n  - id: Q-2\n    doc: RFC-1501\n    stage: implement\n    question: b\n    resolutionPath: convention\n    status: auto-resolved\n    answer: option B\n  - id: Q-3\n    doc: RFC-1501\n    stage: review\n    question: c\n    resolutionPath: none\n    status: deferred\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(false);
    expect(result?.data?.status).toBe("pass");
    const d = result?.data?.items[0]?.decisions;
    expect(d?.open).toBe(0);
    expect(d?.deferred).toBe(1);
    expect(d?.autoResolved).toBe(1);
    expect(result?.data?.decisions).toEqual({
      open: 0,
      answered: 1,
      deferred: 1,
      autoResolved: 1,
    });
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

  test("open+parked entry parks the item — no QUEUE-07, next skips, batch stays green", async () => {
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

    // A parked open is already execution-gated — QUEUE-07 must not fire on
    // it (the park is the containment); the item just drops out of `next`.
    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(false);
    expect(result?.data?.next).toBe("RFC-1521");
    expect(result?.data?.items[0]?.decisions?.open).toBe(1);
  });

  test("un-parked open on implementable item blocks it — QUEUE-07 + next skips it", async () => {
    await writeRfc("RFC-1530", "status: accepted\n");
    await writeRfc("RFC-1531");
    const file = await writeManifest(
      "block-q7-skip",
      "id: block-q7-skip\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1530\n  - id: RFC-1531\n",
    );
    await writeLedger(
      "block-q7-skip",
      `${LEDGER_HEADER("block-q7-skip")}items:\n  - id: Q-1\n    doc: RFC-1530\n    stage: plan\n    question: pending answer\n    resolutionPath: none\n    status: open\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-07")).toBe(true);
    // QUEUE-07-blocked items are not executable — `next` must not name one.
    expect(result?.data?.next).toBe("RFC-1531");
  });

  test("ledger bound to a different manifest → QUEUE-02 error", async () => {
    await writeRfc("RFC-1540", "status: accepted\n");
    const file = await writeManifest(
      "block-bind",
      "id: block-bind\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1540\n",
    );
    await writeLedger(
      "block-bind",
      `id: block-bind.decisions\nqueue: other-queue\ncreatedAt: 2026-10-09\nitems: []\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-02")).toBe(true);
  });

  test("ledger id mismatching filename stem → QUEUE-02 error", async () => {
    await writeRfc("RFC-1541", "status: accepted\n");
    const file = await writeManifest(
      "block-stem",
      "id: block-stem\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1541\n",
    );
    await writeLedger(
      "block-stem",
      `id: wrong-id\nqueue: block-stem\ncreatedAt: 2026-10-09\nitems: []\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-02")).toBe(true);
  });

  test("duplicate decision id → QUEUE-05 error", async () => {
    await writeRfc("RFC-1542", "status: draft\n");
    const file = await writeManifest(
      "block-dup",
      "id: block-dup\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1542\n",
    );
    await writeLedger(
      "block-dup",
      `${LEDGER_HEADER("block-dup")}items:\n  - id: Q-1\n    doc: RFC-1542\n    stage: enhance\n    question: a\n    resolutionPath: none\n  - id: Q-1\n    doc: RFC-1542\n    stage: plan\n    question: b\n    resolutionPath: none\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-05")).toBe(true);
  });

  test("answered entry without answer → QUEUE-08 warning, not blocking", async () => {
    await writeRfc("RFC-1543", "status: accepted\n");
    const file = await writeManifest(
      "block-noans",
      "id: block-noans\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1543\n",
    );
    await writeLedger(
      "block-noans",
      `${LEDGER_HEADER("block-noans")}items:\n  - id: Q-1\n    doc: RFC-1543\n    stage: plan\n    question: a\n    resolutionPath: none\n    status: answered\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.warnings.some((w) => w.ruleId === "QUEUE-08")).toBe(true);
  });

  test("decision targeting a foreign doc → QUEUE-08 warning", async () => {
    await writeRfc("RFC-1544", "status: accepted\n");
    const file = await writeManifest(
      "block-foreign",
      "id: block-foreign\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1544\n",
    );
    await writeLedger(
      "block-foreign",
      `${LEDGER_HEADER("block-foreign")}items:\n  - id: Q-1\n    doc: RFC-9998\n    stage: plan\n    question: a\n    resolutionPath: none\n    status: open\n`,
    );

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.warnings.some((w) => w.ruleId === "QUEUE-08")).toBe(true);
  });

  test("unreadable ledger (non-ENOENT) → QUEUE-01 error, never fails open", async () => {
    await writeRfc("RFC-1545", "status: accepted\n");
    const file = await writeManifest(
      "block-eisdir",
      "id: block-eisdir\ncreatedAt: 2026-10-09\nitems:\n  - id: RFC-1545\n",
    );
    // A directory at the ledger path → EISDIR on read: not legal absence.
    await fs.mkdir(path.join(tmpDir, "docs/queues/block-eisdir.decisions.yaml"));

    const result = await runQueueValidate({ argv: [], flags: { file } }, testContext());

    expect(result?.data?.status).toBe("fail");
    expect(result?.data?.errors.some((e) => e.ruleId === "QUEUE-01")).toBe(true);
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
