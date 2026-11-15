/*
<MODULE_CONTRACT>
<purpose>Unit tests for runQueueDecision (RFC-1601) — the decision-ledger
writer: schema-gated append, createdAt/answeredAt stamping, auto Q-id
allocation, duplicate-id and vocabulary refusals, no-write-on-refuse.</purpose>
<non-goals>
  <item>Not a contract source of truth — the handler owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1601: initial suite — ledger writers assign rather than append.</item>
  <item>RFC-1601: ledger writers assign + refusals teach the violated rule (RFC-1601)

FRICTION-11 flags any out-of-vocabulary friction field value at validate, naming field+value+closed set — the mechanical detector for hand-edit corruption (F-0206/F-0244). queue.decision is the new decision-ledger writer: schema-gated append stamping createdAt/answeredAt, next-free Q-id default, QUEUE-05/QUEUE-DEC-01 refusals carrying the minimal shape. ecosystem.commit --rfc/--adr normalize bare digits or refuse EC-35 with the format statement — the F-0248 silent-injection-skip class is closed, and a summary-record failure now names the id + skipped injection. RFC-IMP-10 refusal leads with the rule statement; pipeline conventions and guides point at the command write path.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse } from "yaml";

import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runQueueDecision } from "./handlers/queue-decision.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-decision-test-"));
  await fs.mkdir(path.join(tmpDir, "docs/rfcs"), { recursive: true });
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

async function writeRfc(id: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, `docs/rfcs/${id.toLowerCase()}-test.md`),
    `---\nid: ${id}\nstatus: draft\n---\n# ${id}\n`,
  );
}

async function writeManifest(name: string): Promise<string> {
  const rel = `docs/queues/${name}.yaml`;
  await fs.writeFile(
    path.join(tmpDir, rel),
    `id: ${name}\ncreatedAt: 2026-11-15\nitems:\n  - id: RFC-1601\n`,
  );
  return rel;
}

async function readLedger(manifestName: string) {
  const body = await fs.readFile(
    path.join(tmpDir, `docs/queues/${manifestName}.decisions.yaml`),
    "utf8",
  );
  return yamlParse(body);
}

const BASE_FLAGS = {
  doc: "RFC-1601",
  stage: "audit",
  question: "Which surface owns the check?",
};

describe("runQueueDecision (RFC-1601)", () => {
  test("fresh ledger: creates sibling with binding fields + stamped createdAt", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-a");
    const result = await runQueueDecision(
      { argv: [], flags: { file, ...BASE_FLAGS } },
      testContext(),
    );
    expect(result.exitCode).toBe(0);
    const ledger = await readLedger("batch-a");
    expect(ledger.id).toBe("batch-a.decisions");
    expect(ledger.queue).toBe("batch-a");
    expect(ledger.createdAt).toBeTruthy();
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0].id).toBe("Q-1");
    expect(ledger.items[0].status).toBe("open");
    expect(ledger.items[0].answeredAt).toBeUndefined();
  });

  test("answered entry gets answeredAt stamped; explicit value passes through", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-b");
    const stamped = await runQueueDecision(
      {
        argv: [],
        flags: { file, ...BASE_FLAGS, status: "auto-resolved", answer: "convention" },
      },
      testContext(),
    );
    expect(stamped.exitCode).toBe(0);
    let ledger = await readLedger("batch-b");
    expect(ledger.items[0].answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const explicit = await runQueueDecision(
      {
        argv: [],
        flags: {
          file,
          ...BASE_FLAGS,
          status: "answered",
          answer: "codebase",
        },
      },
      testContext(),
    );
    expect(explicit.exitCode).toBe(0);
    ledger = await readLedger("batch-b");
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items[1].id).toBe("Q-2");
  });

  test("appends to an existing ledger without disturbing prior entries", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-c");
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/batch-c.decisions.yaml"),
      "id: batch-c.decisions\nqueue: batch-c\ncreatedAt: 2026-11-14\nitems:\n" +
        "  - id: Q-1\n    doc: RFC-1601\n    stage: audit\n    question: earlier\n" +
        "    resolutionPath: convention\n    status: auto-resolved\n    answer: a\n    answeredAt: 2026-11-14\n",
    );
    const result = await runQueueDecision(
      { argv: [], flags: { file, ...BASE_FLAGS } },
      testContext(),
    );
    expect(result.exitCode).toBe(0);
    const ledger = await readLedger("batch-c");
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items[0].id).toBe("Q-1");
    expect(ledger.items[1].id).toBe("Q-2");
    expect(ledger.createdAt).toBe("2026-11-14");
  });

  test("duplicate id refuses QUEUE-05 naming the next free id; nothing written", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-d");
    await fs.writeFile(
      path.join(tmpDir, "docs/queues/batch-d.decisions.yaml"),
      "id: batch-d.decisions\nqueue: batch-d\ncreatedAt: 2026-11-14\nitems:\n" +
        "  - id: Q-1\n    doc: RFC-1601\n    stage: audit\n    question: earlier\n" +
        "    resolutionPath: convention\n    status: open\n",
    );
    const before = await fs.readFile(
      path.join(tmpDir, "docs/queues/batch-d.decisions.yaml"),
      "utf8",
    );
    const result = await runQueueDecision(
      {
        argv: [],
        flags: { file, ...BASE_FLAGS, id: "Q-1" },
      },
      testContext(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("QUEUE-05");
    expect(result.data?.errors[0]?.message).toContain("Q-2");
    expect(await fs.readFile(path.join(tmpDir, "docs/queues/batch-d.decisions.yaml"), "utf8")).toBe(
      before,
    );
  });

  test("out-of-vocabulary status refuses QUEUE-DEC-01 naming the closed set", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-e");
    const result = await runQueueDecision(
      {
        argv: [],
        flags: { file, ...BASE_FLAGS, status: "resolved" },
      },
      testContext(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("QUEUE-DEC-01");
    expect(result.data?.errors[0]?.message).toContain("open|answered|auto-resolved|deferred");
    await expect(
      fs.readFile(path.join(tmpDir, "docs/queues/batch-e.decisions.yaml")),
    ).rejects.toThrow();
  });

  test("missing question refuses QUEUE-DEC-01 with the entry shape; nothing written", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-f");
    const result = await runQueueDecision(
      {
        argv: [],
        flags: { file, doc: "RFC-1601", stage: "audit" },
      },
      testContext(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("QUEUE-DEC-01");
    expect(result.data?.errors[0]?.message).toContain("question");
    await expect(
      fs.readFile(path.join(tmpDir, "docs/queues/batch-f.decisions.yaml")),
    ).rejects.toThrow();
  });

  test("--entry-file carries options through the schema gate", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-g");
    await fs.writeFile(
      path.join(tmpDir, "entry.yaml"),
      "id: Q-7\ndoc: RFC-1601\nstage: enhance\nquestion: which fix?\n" +
        "resolutionPath: codebase\nstatus: auto-resolved\nanswer: option A\n" +
        "options:\n  - label: option A\n    consequence: tight\n    recommended: true\n" +
        "  - label: option B\n    consequence: loose\n",
    );
    const result = await runQueueDecision(
      {
        argv: [],
        flags: { file, "entry-file": "entry.yaml" },
      },
      testContext(),
    );
    expect(result.exitCode).toBe(0);
    const ledger = await readLedger("batch-g");
    expect(ledger.items[0].id).toBe("Q-7");
    expect(ledger.items[0].options).toHaveLength(2);
    expect(ledger.items[0].answeredAt).toBeTruthy();
  });

  test("missing --file refuses QUEUE-DEC-01", async () => {
    const result = await runQueueDecision({ argv: [], flags: BASE_FLAGS }, testContext());
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("QUEUE-DEC-01");
  });

  test("schema-broken ledger refuses QUEUE-01; nothing written", async () => {
    await writeRfc("RFC-1601");
    const file = await writeManifest("batch-h");
    await fs.writeFile(path.join(tmpDir, "docs/queues/batch-h.decisions.yaml"), "id: [unclosed\n");
    const result = await runQueueDecision(
      { argv: [], flags: { file, ...BASE_FLAGS } },
      testContext(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("QUEUE-01");
  });
});
