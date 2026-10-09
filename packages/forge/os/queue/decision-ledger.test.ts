import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { decisionLedgerPath, loadDecisionLedger } from "./manifest.ts";
import { decisionLedgerSchema } from "./types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-ledger-test-"));
  await fs.mkdir(path.join(tmpDir, "docs/queues"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("decisionLedgerSchema (RFC-1250)", () => {
  test("round-trips the RFC example shape", () => {
    const ledger = decisionLedgerSchema.parse({
      id: "block-a.decisions",
      queue: "block-a",
      createdAt: "2026-10-09",
      policies: [
        {
          id: "P-1",
          question: "Blocking or advisory placement for new validators?",
          answer: "blocking (build.check)",
          appliesTo: "*",
        },
      ],
      items: [
        {
          id: "Q-1",
          doc: "RFC-1243",
          stage: "enhance",
          question: "Which storage backend?",
          resolutionPath: "none",
          options: [
            { label: "localStorage", recommended: true },
            { label: "unstorage", consequence: "server-side only" },
          ],
          status: "open",
        },
      ],
    });
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]?.status).toBe("open");
    expect(ledger.policies).toHaveLength(1);
  });

  test("status enum rejects unknown values", () => {
    const result = decisionLedgerSchema.safeParse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-09",
      items: [
        {
          id: "Q-1",
          doc: "RFC-1243",
          stage: "enhance",
          question: "q",
          resolutionPath: "none",
          status: "parked", // not a status — parked is a flag
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("entry id must match Q-N", () => {
    const result = decisionLedgerSchema.safeParse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-09",
      items: [
        {
          id: "q1",
          doc: "RFC-1243",
          stage: "enhance",
          question: "q",
          resolutionPath: "none",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("defaults: empty policies/items, status open, options []", () => {
    const ledger = decisionLedgerSchema.parse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-09",
      items: [
        {
          id: "Q-1",
          doc: "RFC-1243",
          stage: "plan",
          question: "q",
          resolutionPath: "codebase",
        },
      ],
    });
    expect(ledger.policies).toEqual([]);
    expect(ledger.items[0]?.status).toBe("open");
    expect(ledger.items[0]?.options).toEqual([]);
  });
});

describe("decisionLedgerPath / loadDecisionLedger (RFC-1250)", () => {
  test("sibling path: <stem>.yaml → <stem>.decisions.yaml", () => {
    expect(decisionLedgerPath("docs/queues/block-a.yaml")).toBe(
      "docs/queues/block-a.decisions.yaml",
    );
    expect(decisionLedgerPath("docs/queues/block-a.yml")).toBe(
      "docs/queues/block-a.decisions.yaml",
    );
  });

  test("absent ledger → null, no errors", async () => {
    const { ledger, errors } = await loadDecisionLedger(tmpDir, "docs/queues/none.yaml");
    expect(ledger).toBeNull();
    expect(errors).toEqual([]);
  });

  test("valid ledger parses", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-a.yaml"),
      "id: block-a\ncreatedAt: 2026-10-09\nitems: []\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-a.decisions.yaml"),
      "id: block-a.decisions\nqueue: block-a\ncreatedAt: 2026-10-09\nitems:\n  - id: Q-1\n    doc: RFC-1243\n    stage: enhance\n    question: which?\n    resolutionPath: none\n    status: open\n",
    );
    const { ledger, errors } = await loadDecisionLedger(tmpDir, "docs/queues/block-a.yaml");
    expect(errors).toEqual([]);
    expect(ledger?.items).toHaveLength(1);
    expect(ledger?.items[0]?.id).toBe("Q-1");
  });

  test("invalid YAML → QUEUE-01 error on the manifest load path", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-b.decisions.yaml"),
      "id: [unclosed\n",
    );
    const { ledger, errors } = await loadDecisionLedger(tmpDir, "docs/queues/block-b.yaml");
    expect(ledger).toBeNull();
    expect(errors.some((e) => e.ruleId === "QUEUE-01")).toBe(true);
  });

  test("schema violation → QUEUE-01 error naming the ledger path", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-c.decisions.yaml"),
      "id: block-c.decisions\nqueue: block-c\ncreatedAt: 2026-10-09\nitems:\n  - id: BAD\n    doc: RFC-1243\n    stage: enhance\n    question: q\n    resolutionPath: none\n",
    );
    const { ledger, errors } = await loadDecisionLedger(tmpDir, "docs/queues/block-c.yaml");
    expect(ledger).toBeNull();
    expect(errors.some((e) => e.ruleId === "QUEUE-01")).toBe(true);
    expect(errors[0]?.file).toBe("docs/queues/block-c.decisions.yaml");
  });
});
