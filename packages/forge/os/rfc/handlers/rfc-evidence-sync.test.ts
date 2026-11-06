/*
<MODULE_CONTRACT>
<purpose>
Unit tests for RFC-1516: the evidence-freshness window in the stamp-sync
chain — committed-envelope reuse gating (evaluateEvidenceReuse +
readCommittedEnvelope), heavy-vs-cheap probe partitioning in
rfc.verification.emit, and --no-evidence-reuse flag forwarding/report
surfacing in rfc.evidence.sync.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the modules under test own the
  authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1516: initial suite — reuse eligibility gates (AC-1/2/5/6),
  journal provenance (AC-3), --no-evidence-reuse (AC-4), kind
  classification, and sync-side flag forwarding.</item>
  <item>RFC-1516: add an evidence-freshness window to the stamp-sync chain for rfc-1516</item>
  <item>RFC-1516: bind evidence reuse to the oldest replayed result and harden committed-envelope reads for rfc-1516</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect, describe, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { runRfcVerificationEmit } from "../verification-evidence.ts";
import {
  EVIDENCE_REUSE_WINDOW_MS,
  EVIDENCE_SYNC_EMIT_STEP,
  EVIDENCE_SYNC_STEPS,
  evaluateEvidenceReuse,
  runRfcEvidenceSync,
} from "./rfc-evidence-sync.ts";
import { classifyProbeReuse } from "../acceptance.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const { mockRunProbe } = vi.hoisted(() => ({
  mockRunProbe: vi.fn(),
}));

vi.mock("../acceptance.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../acceptance.ts")>();
  return {
    ...orig,
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
  };
});

const RFC_MD = (id: string, probeYaml: string) => `---
id: ${id}
title: "Test ${id}"
status: accepted
kind: command
scope: workspace
owners:
  - architecture
createdAt: 2026-01-01
updatedAt: 2026-01-01
acceptance:
${probeYaml}
---

# ${id}
## Context
Test.
`;

const HEAVY_AND_CHEAP = `  - probe: test
    file: x.test.ts
    criterion: AC-1
    expect:
      exitCode: 0
  - probe: file-contains
    path: packages/forge/AGENTS.md
    pattern: anything
    criterion: AC-2
`;

function git(root: string, args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

async function setupRepo(): Promise<{ root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-1516-sync-"));
  await fs.mkdir(path.join(root, "docs", "rfcs", "verification"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "forge"), { recursive: true });
  await fs.writeFile(path.join(root, "packages", "forge", "AGENTS.md"), "# x\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  return { root };
}

const emit = (root: string, flags: Record<string, unknown>) =>
  runRfcVerificationEmit(
    { argv: [], flags } as unknown as ForgeCommandInput,
    {
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {} },
      outputFormat: "json",
      dryRun: false,
    } as unknown as ForgeRuntimeContext,
  );

async function writeRfc(root: string, id: string, probeYaml = HEAVY_AND_CHEAP) {
  await fs.writeFile(path.join(root, "docs", "rfcs", `${id.toLowerCase()}-t.md`), RFC_MD(id, probeYaml));
}

const envelopePath = (root: string, id: string) =>
  path.join(root, "docs", "rfcs", "verification", `${id.toLowerCase()}.generated.yaml`);

/** Emit once with all-ok probes, then commit — HEAD now holds a green,
 *  in-window envelope with a matching acceptanceHash. */
async function commitGreenEnvelope(root: string, id: string) {
  mockRunProbe.mockResolvedValue({ ok: true, detail: "ok" });
  const first = await emit(root, { id });
  expect(first.exitCode).toBe(0);
  const committed = yamlParse(await fs.readFile(envelopePath(root, id), "utf8")) as {
    emittedAt: string;
    acceptanceHash: string;
  };
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
  mockRunProbe.mockClear();
  return committed;
}

beforeEach(() => {
  mockRunProbe.mockReset();
});

describe("classifyProbeReuse", () => {
  test("run/test/page/proof are reusable; cheap kinds re-run; unknown is unchecked", () => {
    for (const k of ["run", "test", "page", "proof"]) {
      expect(classifyProbeReuse(k)).toBe("reusable");
    }
    for (const k of [
      "file-exists",
      "file-contains",
      "command-registered",
      "json-schema",
      "reachable",
    ]) {
      expect(classifyProbeReuse(k)).toBe("cheap");
    }
    expect(classifyProbeReuse("future-kind")).toBe("unchecked");
  });
});

describe("evaluateEvidenceReuse", () => {
  const env = (over: Record<string, unknown> = {}) =>
    ({
      overall: "pass",
      emittedAt: new Date().toISOString(),
      acceptanceHash: "abc",
      probes: [],
      ...over,
    }) as never;

  test("green + matching + in-window is reusable with provenance", () => {
    const emittedAt = new Date().toISOString();
    const v = evaluateEvidenceReuse({
      committed: env({ emittedAt }),
      acceptanceHashHex: "abc",
      disabled: false,
    });
    expect(v).toEqual({ reusable: true, reason: "envelope-reused", reusedFrom: emittedAt });
  });

  test("each gate fails closed with its reason", () => {
    const base = { committed: env(), acceptanceHashHex: "abc", disabled: false };
    expect(evaluateEvidenceReuse({ ...base, disabled: true }).reason).toBe("disabled");
    expect(evaluateEvidenceReuse({ ...base, committed: null }).reason).toBe("absent");
    expect(evaluateEvidenceReuse({ ...base, malformed: true }).reason).toBe("malformed");
    expect(
      evaluateEvidenceReuse({ ...base, committed: env({ overall: "fail" }) }).reason,
    ).toBe("not-green");
    expect(
      evaluateEvidenceReuse({ ...base, committed: env({ acceptanceHash: "other" }) }).reason,
    ).toBe("acceptance-changed");
    const old = new Date(Date.now() - EVIDENCE_REUSE_WINDOW_MS - 1).toISOString();
    expect(evaluateEvidenceReuse({ ...base, committed: env({ emittedAt: old }) }).reason).toBe(
      "expired",
    );
    expect(evaluateEvidenceReuse({ ...base, committed: env({ emittedAt: "bogus" }) }).reason).toBe(
      "expired",
    );
  });

  test("window boundary: exactly EVIDENCE_REUSE_WINDOW_MS old still reuses", () => {
    const now = Date.now();
    const emittedAt = new Date(now - EVIDENCE_REUSE_WINDOW_MS).toISOString();
    expect(
      evaluateEvidenceReuse({
        committed: env({ emittedAt }),
        acceptanceHashHex: "abc",
        disabled: false,
        now,
      }).reusable,
    ).toBe(true);
  });
});

describe("rfc.verification.emit — evidence-freshness reuse (RFC-1516)", () => {
  test("AC-1/AC-3: in-window green envelope replays heavy probes, cheap probes re-resolve, journal records provenance", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9991");
    const committed = await commitGreenEnvelope(root, "RFC-9991");

    const result = await emit(root, { id: "RFC-9991" });
    expect(result.exitCode).toBe(0);
    // Only the cheap file-contains probe re-executed — the test probe's
    // committed record replayed without a subprocess.
    expect(mockRunProbe).toHaveBeenCalledTimes(1);
    const firstCallArg = (mockRunProbe.mock.calls[0] as unknown[])[0] as { probe: string };
    expect(firstCallArg.probe).toBe("file-contains");

    const entry = result.data!.emitted![0]!;
    expect(entry.reuse).toEqual({
      reusable: true,
      reason: "envelope-reused",
      reusedFrom: committed.emittedAt,
    });
    expect(entry.heavyProbesReused).toEqual(["AC-1"]);
    expect(entry.cheapProbesReRun).toEqual(["AC-2"]);
  });

  test("AC-2: acceptanceHash mismatch re-executes every probe", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9992");
    await commitGreenEnvelope(root, "RFC-9992");
    // Mutate the live acceptance list — the committed hash no longer matches.
    await writeRfc(
      root,
      "RFC-9992",
      `${HEAVY_AND_CHEAP}  - probe: file-exists\n    path: packages/forge/AGENTS.md\n    criterion: AC-3\n`,
    );

    const result = await emit(root, { id: "RFC-9992" });
    expect(mockRunProbe).toHaveBeenCalledTimes(3);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("acceptance-changed");
    expect(result.data!.emitted![0]!.heavyProbesReused).toBeUndefined();
  });

  test("AC-4: --no-evidence-reuse re-executes every probe and journals 'disabled'", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9993");
    await commitGreenEnvelope(root, "RFC-9993");

    const result = await emit(root, { id: "RFC-9993", "no-evidence-reuse": true });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("disabled");
    expect(result.data!.emitted![0]!.reuse?.reusable).toBe(false);
  });

  test("AC-5: absent committed envelope → full re-execution with reason 'absent'", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9994");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "seed"]);
    mockRunProbe.mockResolvedValue({ ok: true, detail: "ok" });

    const result = await emit(root, { id: "RFC-9994" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("absent");
  });

  test("AC-5: malformed committed envelope → full re-execution with reason 'malformed'", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9995");
    await fs.writeFile(envelopePath(root, "RFC-9995"), "::: not an envelope :::\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "seed"]);
    mockRunProbe.mockResolvedValue({ ok: true, detail: "ok" });

    const result = await emit(root, { id: "RFC-9995" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("malformed");
  });

  test("AC-6: non-green committed envelope is never reused", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9996");
    await commitGreenEnvelope(root, "RFC-9996");
    // Flip the committed envelope to fail — reuse must refuse.
    const env = yamlParse(await fs.readFile(envelopePath(root, "RFC-9996"), "utf8")) as Record<
      string,
      unknown
    >;
    env.overall = "fail";
    await fs.writeFile(envelopePath(root, "RFC-9996"), yamlStringify(env));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "flip"]);

    const result = await emit(root, { id: "RFC-9996" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("not-green");
  });

  test("expired envelope (emittedAt beyond the window) re-executes", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9997");
    await commitGreenEnvelope(root, "RFC-9997");
    const env = yamlParse(await fs.readFile(envelopePath(root, "RFC-9997"), "utf8")) as Record<
      string,
      unknown
    >;
    env.emittedAt = new Date(Date.now() - EVIDENCE_REUSE_WINDOW_MS - 60_000).toISOString();
    await fs.writeFile(envelopePath(root, "RFC-9997"), yamlStringify(env));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "age"]);

    const result = await emit(root, { id: "RFC-9997" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("expired");
  });

  test("anchor chain: stale `resultsFrom` defeats reuse even under a fresh emittedAt", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9998");
    const committed = await commitGreenEnvelope(root, "RFC-9998");

    // Reuse hit — the emitted envelope stamps the anchor back to the
    // original execution, not this run's emittedAt.
    const second = await emit(root, { id: "RFC-9998" });
    expect(second.data!.emitted![0]!.reuse?.reusable).toBe(true);
    const written = yamlParse(await fs.readFile(envelopePath(root, "RFC-9998"), "utf8")) as {
      emittedAt: string;
      resultsFrom?: string;
    };
    expect(written.resultsFrom).toBe(committed.emittedAt);
    expect(written.emittedAt).not.toBe(committed.emittedAt);

    // Commit it, then age the anchor past the window — the next emit sees a
    // fresh emittedAt but an expired resultsFrom and re-executes.
    const aged = yamlParse(await fs.readFile(envelopePath(root, "RFC-9998"), "utf8")) as Record<
      string,
      unknown
    >;
    aged.resultsFrom = new Date(Date.now() - EVIDENCE_REUSE_WINDOW_MS - 60_000).toISOString();
    await fs.writeFile(envelopePath(root, "RFC-9998"), yamlStringify(aged));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "chain"]);
    mockRunProbe.mockClear();

    const third = await emit(root, { id: "RFC-9998" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(third.data!.emitted![0]!.reuse?.reason).toBe("expired");
  });

  test("reused envelope re-pins the live probe declaration and carries committed verdict fields", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9989");
    const committed = await commitGreenEnvelope(root, "RFC-9989");
    const committedHeavy = (
      yamlParse(await fs.readFile(envelopePath(root, "RFC-9989"), "utf8")) as {
        probes: Array<{ ok: boolean; detail: string; durationMs: number }>;
      }
    ).probes[0]!;

    await emit(root, { id: "RFC-9989" });
    const written = yamlParse(await fs.readFile(envelopePath(root, "RFC-9989"), "utf8")) as {
      probes: Array<{
        probe: { probe: string; criterion?: string };
        ok: boolean;
        detail: string;
        durationMs: number;
      }>;
      rfcFileHash: string;
      acceptanceHash: string;
    };
    // Replayed heavy record: committed verdict fields, live declaration.
    expect(written.probes[0]!.probe).toMatchObject({ probe: "test", criterion: "AC-1" });
    expect(written.probes[0]!.ok).toBe(committedHeavy.ok);
    expect(written.probes[0]!.detail).toBe(committedHeavy.detail);
    expect(written.probes[0]!.durationMs).toBe(committedHeavy.durationMs);
    // Hashes re-bind to live bytes, not the committed envelope's.
    expect(written.acceptanceHash).toBe(committed.acceptanceHash);
  });

  test("--check never reuses: every probe re-executes", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9988");
    await commitGreenEnvelope(root, "RFC-9988");

    const result = await emit(root, { id: "RFC-9988", check: true });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.check?.[0]?.match).toBe(true);
    expect(result.data!.emitted).toHaveLength(0);
  });

  test.each([
    ["empty probes array", { probes: [] }],
    ["null record entries", { probes: [null, null] }],
  ])(
    "crafted committed envelope (%s) degrades to 'malformed', never a partial reuse",
    async (_label, patch) => {
      const { root } = await setupRepo();
      await writeRfc(root, "RFC-9987");
      await commitGreenEnvelope(root, "RFC-9987");
      const env = yamlParse(await fs.readFile(envelopePath(root, "RFC-9987"), "utf8")) as Record<
        string,
        unknown
      >;
      Object.assign(env, patch);
      await fs.writeFile(envelopePath(root, "RFC-9987"), yamlStringify(env));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-qm", "craft"]);

      const result = await emit(root, { id: "RFC-9987" });
      expect(mockRunProbe).toHaveBeenCalledTimes(2);
      expect(result.data!.emitted![0]!.reuse?.reason).toBe("malformed");
    },
  );

  test("future emittedAt is outside the window", async () => {
    const { root } = await setupRepo();
    await writeRfc(root, "RFC-9986");
    await commitGreenEnvelope(root, "RFC-9986");
    const env = yamlParse(await fs.readFile(envelopePath(root, "RFC-9986"), "utf8")) as Record<
      string,
      unknown
    >;
    env.emittedAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await fs.writeFile(envelopePath(root, "RFC-9986"), yamlStringify(env));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "future"]);

    const result = await emit(root, { id: "RFC-9986" });
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    expect(result.data!.emitted![0]!.reuse?.reason).toBe("expired");
  });
});

describe("rfc.evidence.sync — flag forwarding + report surfacing (RFC-1516)", () => {
  const makeSyncContext = (invoke: ReturnType<typeof vi.fn>) =>
    ({
      workspaceRoot: "/tmp/x",
      logger: { info: () => {}, warn: () => {} },
      outputFormat: "json",
      dryRun: false,
      invoke,
    }) as unknown as ForgeRuntimeContext;

  test("--no-evidence-reuse reaches the emit step's flags", async () => {
    const invoke = vi.fn(async (_name: string, _flags?: Record<string, string>) => ({
      exitCode: 0,
      filesModified: [] as string[],
    }));
    const result = await runRfcEvidenceSync(
      { argv: [], flags: { id: "RFC-9999", "no-evidence-reuse": true } } as unknown as ForgeCommandInput,
      makeSyncContext(invoke),
    );
    expect(result.exitCode).toBe(0);
    const emitCall = invoke.mock.calls.find((c) => c[0] === EVIDENCE_SYNC_EMIT_STEP);
    expect(emitCall?.[1]).toEqual({ id: "RFC-9999", "no-evidence-reuse": "true" });
    expect(invoke).toHaveBeenCalledTimes(EVIDENCE_SYNC_STEPS.length + 1);
  });

  test("the emit step's reuse verdict surfaces on the sync report", async () => {
    const reuse = { reusable: true, reason: "envelope-reused", reusedFrom: "2026-11-06T10:00:00Z" };
    const invoke = vi.fn(async (name: string, _flags?: Record<string, string>) =>
      name === EVIDENCE_SYNC_EMIT_STEP
        ? {
            exitCode: 0,
            filesModified: ["docs/rfcs/verification/rfc-9999.generated.yaml"],
            data: {
              emitted: [{ reuse, heavyProbesReused: ["AC-1"], cheapProbesReRun: ["AC-2"] }],
            },
          }
        : { exitCode: 0, filesModified: [] },
    );
    const result = await runRfcEvidenceSync(
      { argv: [], flags: { id: "RFC-9999" } } as unknown as ForgeCommandInput,
      makeSyncContext(invoke),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data!.data!.reuse).toEqual(reuse);
    expect(result.data!.data!.heavyProbesReused).toEqual(["AC-1"]);
    expect(result.data!.data!.cheapProbesReRun).toEqual(["AC-2"]);
  });
});
