import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  deriveQueueItemStatus,
  deriveQueueReport,
  resolveDocument,
  computeRfcPipelineStages,
  nextPipelineStep,
} from "./pipeline-status.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-status-test-"));
  await fs.mkdir(path.join(tmpDir, "docs/rfcs"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "docs/adrs"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "docs/audits"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "docs/plans"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRfc(id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, `docs/rfcs/${id.toLowerCase()}-test.md`),
    `---\nid: ${id}\n${frontmatter}---\n# ${id}\n`,
  );
}

async function writeAdr(id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, `docs/adrs/${id.toLowerCase()}-test.md`),
    `---\nid: ${id}\n${frontmatter}---\n# ${id}\n`,
  );
}

describe("resolveDocument", () => {
  test("resolves an active RFC file", async () => {
    await writeRfc("RFC-1001", "status: draft\n");
    const doc = await resolveDocument(tmpDir, "RFC-1001");
    expect(doc?.kind).toBe("rfc");
    expect(doc?.frontmatter["status"]).toBe("draft");
  });

  test("resolves an archived RFC file", async () => {
    await fs.mkdir(path.join(tmpDir, "docs/rfcs/archive/implemented"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-1002-old.md"),
      "---\nid: RFC-1002\nstatus: implemented\n---\n# RFC-1002\n",
    );
    const doc = await resolveDocument(tmpDir, "RFC-1002");
    expect(doc?.file).toContain("archive/implemented");
    expect(doc?.frontmatter["status"]).toBe("implemented");
  });

  test("returns undefined for malformed ids", async () => {
    expect(await resolveDocument(tmpDir, "NOT-A-DOC")).toBeUndefined();
    expect(await resolveDocument(tmpDir, "RFC-999")).toBeUndefined();
  });
});

describe("deriveQueueItemStatus — derivation matrix (RFC-1140)", () => {
  test("implemented status → implemented", async () => {
    await writeRfc("RFC-1100", "status: implemented\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1100");
    expect(r?.status).toBe("implemented");
  });

  test("implementedAt set → implemented", async () => {
    await writeRfc("RFC-1101", "status: accepted\nimplementedAt: 2026-09-01\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1101");
    expect(r?.status).toBe("implemented");
  });

  test("rejected → skipped", async () => {
    await writeRfc("RFC-1102", "status: rejected\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1102");
    expect(r?.status).toBe("skipped");
  });

  test("superseded → skipped", async () => {
    await writeRfc("RFC-1103", "status: superseded\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1103");
    expect(r?.status).toBe("skipped");
  });

  test("accepted RFC → in-progress/implement", async () => {
    await writeRfc("RFC-1104", "status: accepted\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1104");
    expect(r?.status).toBe("in-progress");
    expect(r?.pipelineStep).toBe("implement");
  });

  test("plan file exists → in-progress/implement", async () => {
    await writeRfc("RFC-1105", "status: draft\nenhancedAt: 2026-09-01\n");
    await fs.writeFile(
      path.join(tmpDir, "docs/plans/plan-rfc-1105-test.md"),
      "---\nrfcId: RFC-1105\n---\n",
    );
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1105");
    expect(r?.status).toBe("in-progress");
    expect(r?.pipelineStep).toBe("implement");
  });

  test("enhancedAt without plan → in-progress/plan", async () => {
    await writeRfc("RFC-1106", "status: draft\nenhancedAt: 2026-09-01\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1106");
    expect(r?.status).toBe("in-progress");
    expect(r?.pipelineStep).toBe("plan");
  });

  test("audit file only → in-progress/enhance", async () => {
    await writeRfc("RFC-1107", "status: draft\n");
    await fs.writeFile(
      path.join(tmpDir, "docs/audits/audit-rfc-1107-test.md"),
      "# audit\n",
    );
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1107");
    expect(r?.status).toBe("in-progress");
    expect(r?.pipelineStep).toBe("enhance");
  });

  test("no artifacts → pending", async () => {
    await writeRfc("RFC-1108", "status: draft\n");
    const r = await deriveQueueItemStatus(tmpDir, "RFC-1108");
    expect(r?.status).toBe("pending");
    expect(r?.pipelineStep).toBeUndefined();
  });

  test("non-terminal ADR → pending", async () => {
    await writeAdr("ADR-0100", "status: accepted\n");
    const r = await deriveQueueItemStatus(tmpDir, "ADR-0100");
    expect(r?.status).toBe("pending");
  });

  test("unresolvable id → undefined", async () => {
    expect(await deriveQueueItemStatus(tmpDir, "RFC-9999")).toBeUndefined();
  });
});

describe("deriveQueueReport", () => {
  test("preserves manifest order and picks the first actionable item as next", async () => {
    await writeRfc("RFC-1200", "status: implemented\n");
    await writeRfc("RFC-1201", "status: draft\n");
    await writeRfc("RFC-1202", "status: draft\n");

    const report = await deriveQueueReport(tmpDir, ["RFC-1200", "RFC-1201", "RFC-1202"]);

    expect(report.items.map((i) => i.id)).toEqual(["RFC-1200", "RFC-1201", "RFC-1202"]);
    expect(report.next).toBe("RFC-1201");
  });

  test("next is null when every item is terminal", async () => {
    await writeRfc("RFC-1210", "status: implemented\n");
    await writeRfc("RFC-1211", "status: rejected\n");

    const report = await deriveQueueReport(tmpDir, ["RFC-1210", "RFC-1211"]);

    expect(report.next).toBeNull();
  });

  test("in-progress items are actionable for next", async () => {
    await writeRfc("RFC-1220", "status: draft\nenhancedAt: 2026-09-01\n");
    await writeRfc("RFC-1221", "status: draft\n");

    const report = await deriveQueueReport(tmpDir, ["RFC-1220", "RFC-1221"]);

    expect(report.next).toBe("RFC-1220");
  });
});

describe("computeRfcPipelineStages + nextPipelineStep", () => {
  test("stages reflect artifact completion", () => {
    const stages = computeRfcPipelineStages({
      status: "draft",
      enhancedAt: "2026-09-01",
      auditFile: "docs/audits/audit-rfc-1.md",
    });
    expect(stages.map((s) => s.done)).toEqual([true, true, false, false]);
    expect(nextPipelineStep("draft", stages)).toBe("plan");
  });

  test("terminal status yields null next step", () => {
    const stages = computeRfcPipelineStages({ status: "implemented" });
    expect(nextPipelineStep("implemented", stages)).toBeNull();
  });
});
