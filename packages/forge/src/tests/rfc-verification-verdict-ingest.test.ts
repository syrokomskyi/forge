/*
<MODULE_CONTRACT>
<purpose>
RFC-1458 AC-6: rfc.verification.emit ingests werkstatt:verdict/v1 records from
release evidence verdict files as external-origin evidence — newest record per
criterion, silent no-op when absent.
</purpose>
<non-goals>
  <item>Not a contract source of truth — verification-verdicts.ts owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1458: initial — emit-level ingest proof, newest-per-criterion ordering, absent/malformed no-op coverage.</item>
  <item>RFC-1458: emit requirement-mapped verdict events from deploy.smoke.run</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse } from "yaml";

import { runRfcVerificationEmit } from "../../os/rfc/verification-evidence.ts";
import { attachVerdictEvidence } from "../../os/rfc/verification-verdicts.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";
import type { VerificationEvidenceProbeRecord } from "../../os/rfc/types.ts";

const { mockRunProbe } = vi.hoisted(() => ({
  mockRunProbe: vi.fn(),
}));

vi.mock("../../os/rfc/acceptance.ts", () => ({
  runProbe: mockRunProbe,
  // RFC-1489: emit drives runProbeSet — the shim preserves the per-probe
  // mock contract so these tests observe the same probe calls as before.
  runProbeSet: async (probes: unknown[], opts: Record<string, unknown>) => {
    const results = [];
    const durationsMs = [];
    for (const p of probes) {
      results.push(
        await mockRunProbe(
          p,
          opts.workspaceRoot,
          opts.commandRegistry,
          opts.forgeRoot,
          opts.outcomeSession,
        ),
      );
      durationsMs.push(0);
    }
    return { results, durationsMs };
  },
}));

const RFC_MD = (id: string, criterion: string) => `---
id: ${id}
title: "Verdict ingest ${id}"
status: implemented
kind: command
scope: workspace
owners:
  - architecture
createdAt: 2026-01-01
updatedAt: 2026-01-01
acceptance:
  - probe: file-exists
    path: src/index.ts
    criterion: ${criterion}
---

# ${id}
## Context
Test.
`;

const VERDICT = (over: Record<string, unknown>) => ({
  schema: "werkstatt:verdict/v1",
  requirement: "RFC-0100/AC-3",
  check: "route-status",
  outcome: "pass",
  releaseId: "rel-1",
  site: "warpgogol",
  channel: "dev",
  observedAt: "2026-10-31T08:00:00.000Z",
  detail: "200",
  ...over,
});

async function setup(opts: { verdicts?: Record<string, unknown[]> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-verdict-ingest-"));
  const rfcDir = path.join(root, "docs", "rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(path.join(rfcDir, "rfc-0100-verdicts.md"), RFC_MD("RFC-0100", "AC-3"));
  for (const [releaseId, records] of Object.entries(opts.verdicts ?? {})) {
    const dir = path.join(root, "releases", releaseId, ".test-evidence");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "verdicts.json"), JSON.stringify(records));
  }
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function makeContext(root: string) {
  return {
    workspaceRoot: root,
    logger: { info: () => {}, warn: () => {} },
    outputFormat: "json" as const,
    commandRegistry: undefined,
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

async function emitFor(root: string) {
  const result = await runRfcVerificationEmit(
    {
      command: "rfc.verification.emit",
      args: [],
      argv: ["--id", "RFC-0100"],
      flags: { id: "RFC-0100" },
    } as ForgeCommandInput,
    makeContext(root),
  );
  const envelopePath = path.join(
    root,
    "docs",
    "rfcs",
    "verification",
    "rfc-0100.generated.yaml",
  );
  return {
    result,
    envelope: yamlParse(await fs.readFile(envelopePath, "utf-8")) as {
      probes: VerificationEvidenceProbeRecord[];
    },
  };
}

beforeEach(() => {
  mockRunProbe.mockReset();
  mockRunProbe.mockResolvedValue({ ok: true, detail: "exists", verdict: "pass" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rfc.verification.emit — verdict ingest (RFC-1458 AC-6)", () => {
  test("matching verdict attaches as externalVerdict on the criterion probe", async () => {
    const { root, cleanup } = await setup({
      verdicts: {
        "rel-1": [VERDICT({}), VERDICT({ requirement: "RFC-0200/AC-1" })],
      },
    });
    try {
      const { envelope } = await emitFor(root);
      const record = envelope.probes[0]!;
      expect(record.externalVerdict).toMatchObject({
        requirement: "RFC-0100/AC-3",
        check: "route-status",
        outcome: "pass",
        channel: "dev",
        releaseId: "rel-1",
      });
    } finally {
      await cleanup();
    }
  });

  test("newest observedAt wins across releases and channels", async () => {
    const { root, cleanup } = await setup({
      verdicts: {
        "rel-1": [VERDICT({ observedAt: "2026-10-31T08:00:00.000Z", channel: "dev" })],
        "rel-2": [
          VERDICT({ observedAt: "2026-10-31T09:00:00.000Z", channel: "prod", releaseId: "rel-2" }),
        ],
      },
    });
    try {
      const { envelope } = await emitFor(root);
      expect(envelope.probes[0]!.externalVerdict).toMatchObject({
        releaseId: "rel-2",
        channel: "prod",
        observedAt: "2026-10-31T09:00:00.000Z",
      });
    } finally {
      await cleanup();
    }
  });

  test("no releases dir → unchanged emit, no externalVerdict", async () => {
    const { root, cleanup } = await setup();
    try {
      const { result, envelope } = await emitFor(root);
      expect(result.data?.status).toBe("pass");
      expect(envelope.probes[0]!.externalVerdict).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("malformed file and off-schema entries are skipped, valid ones still attach", async () => {
    const { root, cleanup } = await setup({
      verdicts: {
        "rel-bad": null as unknown as Record<string, unknown>[],
      },
    });
    // overwrite with invalid JSON
    await fs.writeFile(
      path.join(root, "releases", "rel-bad", ".test-evidence", "verdicts.json"),
      "{not json",
    );
    const goodDir = path.join(root, "releases", "rel-good", ".test-evidence");
    await fs.mkdir(goodDir, { recursive: true });
    await fs.writeFile(
      path.join(goodDir, "verdicts.json"),
      JSON.stringify([
        { schema: "other:v1", requirement: "RFC-0100/AC-3" },
        "garbage",
        VERDICT({ check: "console-errors", outcome: "fail" }),
      ]),
    );
    try {
      const { envelope } = await emitFor(root);
      expect(envelope.probes[0]!.externalVerdict).toMatchObject({
        check: "console-errors",
        outcome: "fail",
      });
    } finally {
      await cleanup();
    }
  });

  test("attachVerdictEvidence unit: criterion-less probes are skipped", async () => {
    const { root, cleanup } = await setup({
      verdicts: { "rel-1": [VERDICT({})] },
    });
    try {
      const records: VerificationEvidenceProbeRecord[] = [
        {
          probe: { probe: "file-exists", path: "x" },
          ok: true,
          detail: "",
          durationMs: 1,
        },
      ];
      const attached = await attachVerdictEvidence({
        workspaceRoot: root,
        io: ambientIo,
        rfcId: "RFC-0100",
        records,
      });
      expect(attached).toBe(0);
      expect(records[0]!.externalVerdict).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
