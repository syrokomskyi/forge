/*
<MODULE_CONTRACT>
<purpose>
Unit tests for implement stamp stale covering rfc.implement.stamp — RFC-IMP-09 stale evidence gate (RFC-1271).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the implement suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { runRfcImplementStamp } from "./implement-stamp.ts";
import { runRfcVerificationEmit } from "../verification-evidence.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const { mockRunProbe } = vi.hoisted(() => ({
  mockRunProbe: vi.fn(),
}));

vi.mock("../acceptance.ts", () => ({
  runProbe: mockRunProbe,
}));

const PROBE = { probe: "file-exists", path: "src/index.ts", criterion: "AC-1" };

const RFC_MD = (id: string, probes: Record<string, unknown>[] | null, body = "Test.\n") => {
  const probeYaml = (probes ?? [])
    .map((p) => `  - probe: ${p.probe}\n    path: ${p.path}\n    criterion: ${p.criterion}`)
    .join("\n");
  const acceptanceBlock = probes === null ? "" : `acceptance:\n${probeYaml}\n`;
  return `---\nid: ${id}\ntitle: "Test ${id}"\nstatus: accepted\nkind: command\nscope: workspace\nowners:\n  - architecture\ncreatedAt: 2026-10-01\nupdatedAt: 2026-10-01\n${acceptanceBlock}---\n\n# ${id}\n## Context\n${body}\n## Acceptance criteria\n\n- [x] AC-1: THE thing SHALL work (evidence: test: packages/forge/x.test.ts)\n`;
};

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

const commitAll = (dir: string, msg: string) => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
};

async function setupGitWorkspace(): Promise<{
  dir: string;
  rfcDir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-stamp-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  const rfcDir = path.join(dir, "docs", "rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  return {
    dir,
    rfcDir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
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

const writeRfc = async (rfcDir: string, md: string) =>
  fs.writeFile(path.join(rfcDir, "rfc-0100-stale.md"), md);

async function emitEnvelope(dir: string) {
  mockRunProbe.mockResolvedValue({ probe: PROBE, ok: true, detail: "exists" });
  const r = await runRfcVerificationEmit(
    { flags: { id: "RFC-0100" } } as unknown as ForgeCommandInput,
    makeContext(dir),
  );
  expect(r.exitCode).toBe(0);
}

const stamp = (dir: string, commit: string) =>
  runRfcImplementStamp(
    {
      flags: { id: "RFC-0100", "implementation-commit": commit },
    } as unknown as ForgeCommandInput,
    makeContext(dir),
  );

const rules = (result: Awaited<ReturnType<typeof stamp>>) =>
  (result.data!.violations ?? []).map((v) => v.rule);

beforeEach(() => {
  mockRunProbe.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rfc.implement.stamp — RFC-IMP-09 stale evidence gate (RFC-1271)", () => {
  test("matching evidence does NOT emit RFC-IMP-09 (AC-8)", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      const sha = commitAll(dir, "feat: implement RFC-0100 evidence-driven gate");

      const result = await stamp(dir, sha);
      expect(rules(result)).not.toContain("RFC-IMP-09");
      expect(rules(result)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("stale acceptanceHash — probe criterion changed post-emit (AC-1)", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      commitAll(dir, "feat: implement RFC-0100");

      // Criterion retarget on the probe — committed, so IMP-04 passes.
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [{ ...PROBE, criterion: "AC-9" }]));
      commitAll(dir, "chore: tweak RFC-0100 probes");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("acceptanceHash");
      expect(v.message).toContain("rfc.verification.emit --id RFC-0100");
    } finally {
      await cleanup();
    }
  });

  test("stale rfcFileHash — body changed post-emit (AC-2)", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      commitAll(dir, "feat: implement RFC-0100");

      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE], "Edited body.\n"));
      commitAll(dir, "chore: edit RFC-0100 body");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("rfcFileHash");
      expect(v.message).not.toContain("acceptanceHash mismatch");
    } finally {
      await cleanup();
    }
  });

  test("acceptance list deleted post-emit → IMP-09 names probe deletion", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      commitAll(dir, "feat: implement RFC-0100");

      await writeRfc(rfcDir, RFC_MD("RFC-0100", null));
      commitAll(dir, "chore: drop RFC-0100 probes");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("probes were deleted");
    } finally {
      await cleanup();
    }
  });

  test("malformed scalar envelope → IMP-09 fail-closed (no evasion)", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      const envPath = path.join(dir, "docs", "rfcs", "verification", "rfc-0100.generated.yaml");
      await fs.mkdir(path.dirname(envPath), { recursive: true });
      // yamlParse("0") → 0 — falsy scalar must NOT slip the gate open.
      await fs.writeFile(envPath, "0\n");
      commitAll(dir, "feat: implement RFC-0100 with forged scalar envelope");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("malformed");
    } finally {
      await cleanup();
    }
  });

  test("unparseable envelope → IMP-09 fail-closed", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      const envPath = path.join(dir, "docs", "rfcs", "verification", "rfc-0100.generated.yaml");
      await fs.mkdir(path.dirname(envPath), { recursive: true });
      await fs.writeFile(envPath, "{{{not yaml: [unclosed\n");
      commitAll(dir, "feat: implement RFC-0100 with broken envelope");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("malformed");
    } finally {
      await cleanup();
    }
  });

  test("successful stamp auto re-emits — envelope binds the implemented-state file", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      const sha = commitAll(dir, "feat: implement RFC-0100");

      const result = await stamp(dir, sha);
      expect(rules(result)).toEqual([]);
      expect(result.data!.data?.evidenceReEmitted).toBe(true);

      // Born-stale regression: the envelope MUST describe the post-mutation
      // file — a fresh emit --check on the stamped state diverges on nothing.
      const envPath = path.join(dir, "docs", "rfcs", "verification", "rfc-0100.generated.yaml");
      const env = yamlParse(await fs.readFile(envPath, "utf-8")) as Record<string, unknown>;
      expect(env["rfcStatus"]).toBe("implemented");

      mockRunProbe.mockResolvedValue({ probe: PROBE, ok: true, detail: "exists" });
      const check = await runRfcVerificationEmit(
        { flags: { id: "RFC-0100", check: true } } as unknown as ForgeCommandInput,
        makeContext(dir),
      );
      expect(check.exitCode).toBe(0);
      expect(check.data!.check![0]).toMatchObject({
        rfcId: "RFC-0100",
        match: true,
      });
    } finally {
      await cleanup();
    }
  });

  test("envelope lacking hash fields → IMP-09 fail-closed", async () => {
    const { dir, rfcDir, cleanup } = await setupGitWorkspace();
    try {
      await writeRfc(rfcDir, RFC_MD("RFC-0100", [PROBE]));
      await emitEnvelope(dir);
      commitAll(dir, "feat: implement RFC-0100");

      // Strip the hash fields to simulate a pre-RFC-0330 envelope.
      const envPath = path.join(dir, "docs", "rfcs", "verification", "rfc-0100.generated.yaml");
      const env = yamlParse(await fs.readFile(envPath, "utf-8")) as Record<string, unknown>;
      delete env["rfcFileHash"];
      delete env["acceptanceHash"];
      await fs.writeFile(envPath, yamlStringify(env) + "\n");
      commitAll(dir, "chore: age RFC-0100 envelope");

      const result = await stamp(dir, git(dir, ["rev-parse", "HEAD"]));
      expect(rules(result)).toContain("RFC-IMP-09");
      const v = result.data!.violations.find((x) => x.rule === "RFC-IMP-09")!;
      expect(v.message).toContain("lacks hash fields");
    } finally {
      await cleanup();
    }
  });
});
