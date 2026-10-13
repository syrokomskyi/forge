// @vitest-environment node
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { runRfcVerificationEmit } from "./verification-evidence.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

const { mockRunProbe } = vi.hoisted(() => ({
  mockRunProbe: vi.fn(),
}));

vi.mock("./acceptance.ts", () => ({
  runProbe: mockRunProbe,
}));

const PROBE = { probe: "file-exists", path: "src/index.ts", criterion: "AC-1" };

const RFC_FRONTMATTER = (id: string, probes: Record<string, unknown>[]) => {
  const probeYaml = probes
    .map(
      (p) =>
        `  - probe: ${p.probe}\n    path: ${p.path ?? ""}\n    criterion: ${p.criterion ?? ""}`,
    )
    .join("\n");
  return `---\nid: ${id}\ntitle: "Test ${id}"\nstatus: accepted\nkind: command\nscope: workspace\nowners:\n  - architecture\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\nacceptance:\n${probeYaml}\n---\n\n# ${id}\n## Context\nTest.\n`;
};

const envelopePath = (root: string, rfcId: string) =>
  path.join(root, "docs", "rfcs", "verification", `${rfcId.toLowerCase()}.generated.yaml`);

async function setupWorkspace(
  rfcMarkdown: string,
): Promise<{ workspaceRoot: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-rfc-check-"));
  const rfcDir = path.join(tmpDir, "docs", "rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(path.join(rfcDir, "rfc-0100-check.md"), rfcMarkdown);
  return {
    workspaceRoot: tmpDir,
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

function makeContext(workspaceRoot: string) {
  return {
    workspaceRoot,
    logger: { info: () => {}, warn: () => {} },
    outputFormat: "json" as const,
    commandRegistry: undefined,
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

const emit = (root: string, flags: Record<string, unknown>) =>
  runRfcVerificationEmit(
    { flags } as unknown as ForgeCommandInput,
    makeContext(root),
  );

/** Emit a real envelope so committed hashes match the fixture exactly. */
async function emitRealEnvelope(root: string) {
  mockRunProbe.mockResolvedValue({ probe: PROBE, ok: true, detail: "exists" });
  const r = await emit(root, { id: "RFC-0100" });
  expect(r.exitCode).toBe(0);
  const envelope = yamlParse(await fs.readFile(envelopePath(root, "RFC-0100"), "utf-8"));
  return envelope as Record<string, unknown> & { probes: Record<string, unknown>[] };
}

async function rewriteEnvelope(root: string, mutate: (e: Record<string, unknown>) => void) {
  const file = envelopePath(root, "RFC-0100");
  const envelope = yamlParse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  mutate(envelope);
  await fs.writeFile(file, yamlStringify(envelope) + "\n");
}

beforeEach(() => {
  mockRunProbe.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rfc.verification.emit --check (RFC-1271)", () => {
  test("clean envelope matches a fresh recomputation", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      await emitRealEnvelope(workspaceRoot);
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(0);
      expect(result.data!.check).toEqual([
        { rfcId: "RFC-0100", match: true, mismatches: [] },
      ]);
      // Nothing was written — emitted stays empty in check mode.
      expect(result.data!.emitted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("forged overall: pass → exit 1, names overall", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      // Emit a FAILING envelope, then forge it to pass.
      mockRunProbe.mockResolvedValue({ probe: PROBE, ok: false, detail: "missing" });
      const emitted = await emit(workspaceRoot, { id: "RFC-0100" });
      expect(emitted.exitCode).toBe(1);
      await rewriteEnvelope(workspaceRoot, (e) => {
        e["overall"] = "pass";
        (e["probes"] as Record<string, unknown>[])[0]!["ok"] = true;
      });

      mockRunProbe.mockResolvedValue({ probe: PROBE, ok: false, detail: "missing" });
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(1);
      const entry = result.data!.check![0]!;
      expect(entry.match).toBe(false);
      expect(entry.mismatches).toContain("overall");
      expect(entry.mismatches).toContain("probes[0].ok");
    } finally {
      await cleanup();
    }
  });

  test("stale acceptanceHash (acceptance list changed post-emit) → exit 1", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      await emitRealEnvelope(workspaceRoot);
      // Retarget the probe's criterion — same key shape, different value.
      const changed = RFC_FRONTMATTER("RFC-0100", [{ ...PROBE, criterion: "AC-9" }]);
      await fs.writeFile(
        path.join(workspaceRoot, "docs", "rfcs", "rfc-0100-check.md"),
        changed,
      );
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(1);
      const mismatches = result.data!.check![0]!.mismatches;
      expect(mismatches).toContain("acceptanceHash");
      expect(mismatches).toContain("rfcFileHash");
    } finally {
      await cleanup();
    }
  });

  test("probe added post-emit → probes.length mismatch", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      await emitRealEnvelope(workspaceRoot);
      const changed = RFC_FRONTMATTER("RFC-0100", [
        PROBE,
        { probe: "file-exists", path: "src/other.ts", criterion: "AC-2" },
      ]);
      await fs.writeFile(
        path.join(workspaceRoot, "docs", "rfcs", "rfc-0100-check.md"),
        changed,
      );
      mockRunProbe.mockResolvedValue({ probe: PROBE, ok: true, detail: "exists" });
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(1);
      expect(result.data!.check![0]!.mismatches).toContain("probes.length");
    } finally {
      await cleanup();
    }
  });

  test("hand-edited hash field (forged acceptanceHash value) → exit 1", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      await emitRealEnvelope(workspaceRoot);
      await rewriteEnvelope(workspaceRoot, (e) => {
        e["acceptanceHash"] = "deadbeef";
      });
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(1);
      expect(result.data!.check![0]!.mismatches).toContain("acceptanceHash");
    } finally {
      await cleanup();
    }
  });

  test("missing envelope → exit 1, envelope-missing", async () => {
    const md = RFC_FRONTMATTER("RFC-0100", [PROBE]);
    const { workspaceRoot, cleanup } = await setupWorkspace(md);
    try {
      mockRunProbe.mockResolvedValue({ probe: PROBE, ok: true, detail: "exists" });
      const result = await emit(workspaceRoot, { id: "RFC-0100", check: true });
      expect(result.exitCode).toBe(1);
      expect(result.data!.check![0]!.mismatches).toEqual(["envelope-missing"]);
    } finally {
      await cleanup();
    }
  });
});
