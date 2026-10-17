/*
<MODULE_CONTRACT>
<purpose>
RFC-1320 unit tests for the pre-probe generated-artifact freshness gate inside rfc.verification.emit — EVIDENCE-FRESH-01 blocking on stale/missing probe-referenced artifacts; EVIDENCE-FRESH-02 warnings on unverifiable freshness; EVIDENCE-FRESH-03 loud failure on unknown probe kinds; emit-owned artifact exclusion.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1320: initial suite — sync-remedy, non-sync owner remedy, absent invoke, render-unavailable, fresh pass-through, no-artifact probes, emit-owned exclusion, unowned paths, unknown kind.</item>
  <item>RFC-1320</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runRfcVerificationEmit, probeArtifactCandidates } from "./verification-evidence.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

const { mockRunProbe } = vi.hoisted(() => ({
  mockRunProbe: vi.fn(),
}));

vi.mock("./acceptance.ts", () => ({
  runProbe: mockRunProbe,
}));

const MANIFEST = "docs/command-manifest.generated.yaml";

function frontmatter(id: string, probeYaml: string): string {
  return `---\nid: ${id}\ntitle: "Test ${id}"\nstatus: implemented\nkind: command\nscope: workspace\nowners:\n  - architecture\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\nacceptance:\n${probeYaml}\n---\n\n# ${id}\n## Context\nTest.\n`;
}

const PROBE_BLOCK = {
  fileExistsManifest: `  - probe: file-exists\n    path: ${MANIFEST}\n    criterion: AC-1`,
  fileContainsManifest: `  - probe: file-contains\n    path: ${MANIFEST}\n    pattern: "command-manifest"\n    criterion: AC-1`,
  commandRegistered: `  - probe: command-registered\n    name: checks.commands.generate\n    criterion: AC-1`,
  runOnly: `  - probe: run\n    command: "werkstatt run rfc.validate --id RFC-0100"\n    expect:\n      exitCode: 0\n    criterion: AC-1`,
  emitOwned: `  - probe: file-exists\n    path: docs/rfcs/verification/rfc-0099.generated.yaml\n    criterion: AC-1`,
  unknownKind: `  - probe: teleport\n    path: anywhere\n    criterion: AC-1`,
};

async function setupWorkspace(probeYaml: string, id = "RFC-0100") {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-fresh-test-"));
  await fs.mkdir(path.join(tmpDir, "docs", "rfcs"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "docs", "rfcs", `${id.toLowerCase()}-test.md`),
    frontmatter(id, probeYaml),
  );
  return {
    workspaceRoot: tmpDir,
    envelope: path.join(
      tmpDir,
      "docs",
      "rfcs",
      "verification",
      `${id.toLowerCase()}.generated.yaml`,
    ),
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

function driftResult(artifacts: unknown[]) {
  return {
    exitCode: 0,
    ok: true,
    data: { command: "generated.drift.validate", diagnostics: [], artifacts },
    summary: "freshness",
  };
}

function makeContext(
  workspaceRoot: string,
  overrides: Record<string, unknown> = {},
): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: { info: () => {}, warn: () => {} },
    outputFormat: "json",
    dryRun: false,
    ...overrides,
  } as unknown as ForgeRuntimeContext;
}

beforeEach(() => {
  mockRunProbe.mockReset();
  mockRunProbe.mockResolvedValue({ probe: {}, ok: true, detail: "ok" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EVIDENCE-FRESH-01 — blocking", () => {
  test("stale command manifest blocks emit and names rfc.evidence.sync as remedy", async () => {
    const { workspaceRoot, envelope, cleanup } = await setupWorkspace(
      PROBE_BLOCK.fileContainsManifest,
    );
    const invoke = vi
      .fn()
      .mockResolvedValue(
        driftResult([{ path: MANIFEST, owner: "command.manifest.generate", verdict: "stale" }]),
      );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(invoke).toHaveBeenCalledWith("generated.drift.validate", {
        target: "workspace",
        paths: [MANIFEST],
      });
      const diag = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-01");
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("command.manifest.generate");
      expect(diag?.message).toContain("rfc.evidence.sync --id RFC-0100");
      expect(result.data!.emitted).toHaveLength(0);
      expect(result.data!.skipped[0]?.reason).toBe("stale-generated-artifact");
      expect(result.exitCode).toBe(1);
      // No probes ran, no envelope written — emit stays read-only.
      expect(mockRunProbe).not.toHaveBeenCalled();
      await expect(fs.stat(envelope)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("missing artifact owned by a non-sync generator names the generator command", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(
      `  - probe: file-exists\n    path: packages/x/out.generated.json\n    criterion: AC-1`,
    );
    const invoke = vi.fn().mockResolvedValue(
      driftResult([
        {
          path: "packages/x/out.generated.json",
          owner: "custom.artifact.generate",
          verdict: "missing",
        },
      ]),
    );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const diag = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-01");
      expect(diag?.message).toContain("custom.artifact.generate");
      expect(diag?.message).not.toContain("rfc.evidence.sync");
      expect(result.exitCode).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("command-registered probe maps to the command manifest artifact", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.commandRegistered);
    const invoke = vi
      .fn()
      .mockResolvedValue(
        driftResult([{ path: MANIFEST, owner: "command.manifest.generate", verdict: "fresh" }]),
      );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(invoke).toHaveBeenCalledWith("generated.drift.validate", {
        target: "workspace",
        paths: [MANIFEST],
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe("EVIDENCE-FRESH-02 — unverifiable, probes still run", () => {
  test("absent context.invoke warns and still emits", async () => {
    const { workspaceRoot, envelope, cleanup } = await setupWorkspace(
      PROBE_BLOCK.fileExistsManifest,
    );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot),
      );
      const warn = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-02");
      expect(warn?.severity).toBe("warning");
      expect(warn?.message).toContain("context.invoke absent");
      expect(result.data!.emitted).toHaveLength(1);
      expect(result.exitCode).toBe(0);
      await expect(fs.stat(envelope)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test("invoke throwing warns and still emits", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.fileExistsManifest);
    const invoke = vi.fn().mockRejectedValue(new Error("kernel down"));
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const warn = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-02");
      expect(warn?.message).toContain("kernel down");
      expect(result.data!.emitted).toHaveLength(1);
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("render-unavailable verdict warns and still emits", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.fileExistsManifest);
    const invoke = vi
      .fn()
      .mockResolvedValue(
        driftResult([
          { path: MANIFEST, owner: "command.manifest.generate", verdict: "render-unavailable" },
        ]),
      );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const warn = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-02");
      expect(warn?.message).toContain("render-unavailable");
      expect(result.data!.emitted).toHaveLength(1);
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("payload without artifact verdicts warns and still emits", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.fileExistsManifest);
    const invoke = vi.fn().mockResolvedValue({ exitCode: 0, ok: true, data: {}, summary: "ok" });
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const warn = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-02");
      expect(warn?.message).toContain("no artifact verdicts");
      expect(result.data!.emitted).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("freshness gate — no-op and exclusion cases", () => {
  test("fresh artifacts: emit proceeds, no FRESH diagnostics", async () => {
    const { workspaceRoot, envelope, cleanup } = await setupWorkspace(
      PROBE_BLOCK.fileContainsManifest,
    );
    const invoke = vi
      .fn()
      .mockResolvedValue(
        driftResult([{ path: MANIFEST, owner: "command.manifest.generate", verdict: "fresh" }]),
      );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(result.data!.emitted).toHaveLength(1);
      expect(result.exitCode).toBe(0);
      expect(result.data!.diagnostics.some((d) => d.ruleId?.startsWith("EVIDENCE-FRESH"))).toBe(
        false,
      );
      await expect(fs.stat(envelope)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test("run-only probes: no generated dependency — invoke never called", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.runOnly);
    const invoke = vi.fn();
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(result.data!.emitted).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("emit-owned verification envelopes are excluded from candidates", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(PROBE_BLOCK.emitOwned);
    const invoke = vi.fn();
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(result.data!.emitted).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("generated-looking but unowned paths do not block", async () => {
    const { workspaceRoot, cleanup } = await setupWorkspace(
      `  - probe: file-exists\n    path: docs/stray.generated.yaml\n    criterion: AC-1`,
    );
    const invoke = vi
      .fn()
      .mockResolvedValue(
        driftResult([{ path: "docs/stray.generated.yaml", owner: null, verdict: "unowned" }]),
      );
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      expect(result.data!.emitted).toHaveLength(1);
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe("EVIDENCE-FRESH-03 — unknown probe kind fails loudly", () => {
  test("unrecognized probe kind blocks emission with an explicit error", async () => {
    const { workspaceRoot, envelope, cleanup } = await setupWorkspace(PROBE_BLOCK.unknownKind);
    const invoke = vi.fn();
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const diag = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-03");
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("teleport");
      expect(result.data!.skipped[0]?.reason).toBe("unknown-probe-kind");
      expect(result.data!.emitted).toHaveLength(0);
      expect(result.exitCode).toBe(1);
      await expect(fs.stat(envelope)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("malformed path-bearing probe fails this RFC, never crashes the sweep", async () => {
    // `file-exists` with no `path:` — validate would flag it, but emit casts
    // frontmatter unchecked; pre-change this threw an uncaught TypeError.
    const { workspaceRoot, cleanup } = await setupWorkspace(
      `  - probe: file-exists\n    criterion: AC-1`,
    );
    const invoke = vi.fn();
    try {
      const result = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
        makeContext(workspaceRoot, { invoke }),
      );
      const diag = result.data!.diagnostics.find((d) => d.ruleId === "EVIDENCE-FRESH-03");
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("no string path");
      expect(result.data!.skipped[0]?.reason).toBe("unknown-probe-kind");
      expect(result.exitCode).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("probeArtifactCandidates — exhaustive mapping", () => {
  test("each probe kind maps to its artifact dependency", () => {
    expect(
      probeArtifactCandidates({
        probe: "command-registered",
        name: "x",
        criterion: "AC-1",
      } as never),
    ).toEqual([MANIFEST]);
    expect(
      probeArtifactCandidates({ probe: "file-exists", path: "a/b.ts", criterion: "AC-1" } as never),
    ).toEqual(["a/b.ts"]);
    expect(
      probeArtifactCandidates({
        probe: "file-contains",
        path: "a/b.ts",
        pattern: "x",
        criterion: "AC-1",
      } as never),
    ).toEqual(["a/b.ts"]);
    expect(
      probeArtifactCandidates({
        probe: "json-schema",
        artifact: "a/b.json",
        schemaInline: {},
        criterion: "AC-1",
      } as never),
    ).toEqual(["a/b.json"]);
    for (const live of ["run", "test", "page"] as const) {
      expect(probeArtifactCandidates({ probe: live, criterion: "AC-1" } as never)).toEqual([]);
    }
  });
});
