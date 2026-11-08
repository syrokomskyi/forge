/*
<MODULE_CONTRACT>
<purpose>
Unit tests for decision ledger covering decisionLedgerSchema (RFC-1250); decisionLedgerPath / loadDecisionLedger (RFC-1250).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the decision suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1350: queue-batch hardening — ledger baseline field, manifest packagesImpacted + QUEUE-09, COMMIT-GOV-02 manifest scope, test-first policy</item>
  <item>RFC-1482: emit validation-compliant RFC skeletons and surface contract breaches at authoring time</item>
  <item>RFC-1534: lint probe patterns, sync amends counterparts, name next free ledger id</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { decisionLedgerPath, loadDecisionLedger, loadQueueManifest } from "./manifest.ts";
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

  test("stage accepts pipeline phases incl. audit", () => {
    for (const stage of ["idea", "audit", "enhance", "plan", "implement", "review"]) {
      const result = decisionLedgerSchema.safeParse({
        id: "x.decisions",
        queue: "x",
        createdAt: "2026-10-09",
        items: [{ id: "Q-1", doc: "RFC-1243", stage, question: "q", resolutionPath: "none" }],
      });
      expect(result.success, `stage "${stage}" rejected`).toBe(true);
    }
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

  test("baseline field (RFC-1350): optional top-level capture of pre-existing failures", () => {
    const withoutBaseline = decisionLedgerSchema.parse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-20",
    });
    expect(withoutBaseline.baseline).toBeUndefined();

    const withBaseline = decisionLedgerSchema.parse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-20",
      baseline: {
        capturedAt: "2026-10-20T13:00:00.000Z",
        failures: [
          { kind: "validator", name: "kernel.flags.lint", detail: "12 errors" },
          { kind: "suite", name: "packages/werkstatt-site build:check" },
        ],
      },
    });
    expect(withBaseline.baseline?.failures).toHaveLength(2);
    expect(withBaseline.baseline?.failures[0]?.kind).toBe("validator");
    expect(withBaseline.baseline?.failures[1]?.detail).toBeUndefined();
  });

  test("baseline rejects unknown failure kinds", () => {
    const result = decisionLedgerSchema.safeParse({
      id: "x.decisions",
      queue: "x",
      createdAt: "2026-10-20",
      baseline: {
        capturedAt: "2026-10-20T13:00:00.000Z",
        failures: [{ kind: "mystery", name: "x" }],
      },
    });
    expect(result.success).toBe(false);
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
    await fs.writeFile(path.join(tmpDir, "docs/queues/block-b.decisions.yaml"), "id: [unclosed\n");
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

  // RFC-1482 AC-5: QUEUE-01 on the decisions-ledger path prints the minimal
  // satisfying shape so the fix is readable from the diagnostic, not code.
  test("schema violation carries the minimal required shape (AC-5)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-d.decisions.yaml"),
      "id: block-d.decisions\nqueue: block-d\nitems: []\n", // missing createdAt
    );
    const { ledger, errors } = await loadDecisionLedger(tmpDir, "docs/queues/block-d.yaml");
    expect(ledger).toBeNull();
    const queue01 = errors.filter((e) => e.ruleId === "QUEUE-01");
    expect(queue01.length).toBeGreaterThan(0);
    for (const e of queue01) {
      expect(e.message).toContain("id:");
      expect(e.message).toContain("queue:");
      expect(e.message).toContain("createdAt:");
      expect(e.message).toContain("items:");
    }
  });

  test("manifest-side QUEUE-01 does not gain the ledger hint (scope check)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-e.yaml"),
      "items: not-a-list\n", // manifest schema violation — not a ledger
    );
    const { errors } = await loadQueueManifest(tmpDir, "docs/queues/block-e.yaml");
    const queue01 = errors.filter((e) => e.ruleId === "QUEUE-01");
    expect(queue01.length).toBeGreaterThan(0);
    expect(queue01.every((e) => !e.message.includes("minimal shape"))).toBe(true);
  });

  // RFC-1534 AC-3: the collision diagnostic names the colliding id AND the
  // next free id computed at read time (max suffix + 1, never a counter).
  test("duplicate decision id → QUEUE-05 names the collision and next free id", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/block-f.decisions.yaml"),
      "id: block-f.decisions\nqueue: block-f\ncreatedAt: 2026-10-09\nitems:\n" +
        "  - id: Q-1\n    doc: RFC-1243\n    stage: enhance\n    question: first\n    resolutionPath: none\n    status: open\n" +
        "  - id: Q-7\n    doc: RFC-1243\n    stage: enhance\n    question: second\n    resolutionPath: none\n    status: open\n" +
        "  - id: Q-1\n    doc: RFC-1244\n    stage: plan\n    question: dup\n    resolutionPath: none\n    status: open\n",
    );
    const { errors } = await loadDecisionLedger(tmpDir, "docs/queues/block-f.yaml");
    const q5 = errors.filter((e) => e.ruleId === "QUEUE-05");
    expect(q5).toHaveLength(1);
    expect(q5[0]!.message).toContain('"Q-1"');
    expect(q5[0]!.message).toContain("next free id: Q-8");
  });
});
