/*
<MODULE_CONTRACT>
  <purpose>RFC-1310 STAMP-GOV-01: rfc.implement.stamp refuses to certify a provenance-broken implementation — the selected implementation commit (plus auto-detected candidates) must carry an X-RFC/X-ADR trailer or an injected CHANGE_SUMMARY item naming the id.</purpose>
  <non-goals>
    <item>Does not cover the RFC-IMP-01..09 gates — owned by implement-stamp.test.ts.</item>
    <item>Does not cover COMMIT-GOV-01/02/03 — owned by the werkstatt-site ecosystem-commit.governance.test.ts suite.</item>
  </non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1310: STAMP-GOV-01 fixtures — trailer provenance, injected-item provenance, candidate-set scan, retro-fix remedy, dry-run scan reporting</item>
  <item>RFC-1310: governance-id parity guards on ecosystem.commit and rfc.implement.stamp</item>
  <item>RFC-1321: lowercase --id satisfies an uppercase subject (AC-3)</item>
  <item>RFC-1322: step 4 — --check-criteria resolvable/unresolvable matrix + dry-run residual-unchecked fix</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const { mockRunProbe } = vi.hoisted(() => ({ mockRunProbe: vi.fn() }));
vi.mock("../../os/rfc/acceptance.ts", () => ({ runProbe: mockRunProbe }));

import { runRfcImplementStamp } from "../../os/rfc/handlers/implement-stamp.ts";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeLogger } from "../../src/types.ts";

const infoLog: string[] = [];

const recordingLogger: ForgeLogger = {
  section: () => {},
  info: (msg: string) => {
    infoLog.push(msg);
  },
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: recordingLogger,
    dryRun: false,
    outputFormat: "json",
  };
}

function makeInput(id: string, commit: string, dryRun?: boolean): ForgeCommandInput {
  return {
    argv: [],
    flags: {
      id,
      "implementation-commit": commit,
      ...(dryRun ? { "dry-run": true } : {}),
    },
  };
}

function makeInputAutoDetect(id: string, dryRun?: boolean): ForgeCommandInput {
  return {
    argv: [],
    flags: { id, ...(dryRun ? { "dry-run": true } : {}) },
  };
}

const RFC_BODY = `---
id: RFC-0001
title: "Test RFC"
status: accepted
kind: policy
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-07-21
updatedAt: 2026-07-21
---

# RFC-0001: Test RFC

## Acceptance criteria

- [x] First criterion (evidence: src/foo.ts:10, unit test)
`;

async function commitAll(dir: string, message: string): Promise<string> {
  execFileSync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, timeout: 5000 });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5000 }).toString().trim();
}

describe("STAMP-GOV-01 — implementation provenance", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "rfc-stamp-gov-"));
    await mkdir(join(workspaceRoot, "docs", "rfcs"), { recursive: true });
    execFileSync("git", ["init"], { cwd: workspaceRoot, timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: workspaceRoot,
      timeout: 5000,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceRoot, timeout: 5000 });
    await writeFile(join(workspaceRoot, "docs", "rfcs", "rfc-0001-test.md"), RFC_BODY);
    infoLog.length = 0;
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("AC-6: implementation commit without trailer fails with the retro-fix remedy", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const gov = result.data?.violations.find((v) => v.rule === "STAMP-GOV-01");
    expect(gov).toBeDefined();
    expect(gov?.message).toContain("X-RFC: RFC-0001");
    expect(gov?.message).toContain("Retro-fix");
    expect(gov?.message).toContain("ecosystem.commit --rfc RFC-0001");
  });

  it("implementation commit carrying the X-RFC trailer passes", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001\n\nX-RFC: RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toEqual([]);
  });

  it("RFC-1321 AC-3: lowercase --id rfc-0001 satisfies an RFC-0001 subject", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001\n\nX-RFC: RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("rfc-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toEqual([]);
  });

  it("trailer is matched case-insensitively and by exact id", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001\n\nX-RFC: rfc-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
  });

  it("a trailer naming a DIFFERENT id does not satisfy provenance", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001\n\nX-RFC: RFC-9999");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    const gov = result.data?.violations.find((v) => v.rule === "STAMP-GOV-01");
    expect(gov).toBeDefined();
  });

  it("an injected CHANGE_SUMMARY <item> in the diff satisfies provenance without a trailer", async () => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "impl.ts"),
      "/*\n<CHANGE_SUMMARY>\n  <item>RFC-0001: the implementation</item>\n</CHANGE_SUMMARY>\n*/\nexport const x = 1;\n",
    );
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toEqual([]);
  });

  it("an <item> bearing a different id does not satisfy provenance", async () => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "impl.ts"),
      "/*\n<CHANGE_SUMMARY>\n  <item>RFC-9999: other work</item>\n</CHANGE_SUMMARY>\n*/\nexport const x = 1;\n",
    );
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.violations.find((v) => v.rule === "STAMP-GOV-01")).toBeDefined();
  });

  it("auto-detect candidates join the scan — a sibling commit's trailer satisfies provenance", async () => {
    // Implementation-shaped commit without a trailer…
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "impl.ts"), "export const x = 1;\n");
    await commitAll(workspaceRoot, "implement: RFC-0001 the change");
    // …plus a follow-up commit that DOES carry the trailer.
    await writeFile(join(workspaceRoot, "src", "note.md"), "# note\n");
    await commitAll(workspaceRoot, "docs: RFC-0001 notes\n\nX-RFC: RFC-0001");

    const result = await runRfcImplementStamp(
      makeInputAutoDetect("RFC-0001"),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    const scanLine = infoLog.find((l) => l.includes("STAMP-GOV-01 scanning"));
    expect(scanLine).toContain("2 commit(s)");
  });

  it("dry-run prints the scanned commit set", async () => {
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001\n\nX-RFC: RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit, true),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    const scanLine = infoLog.find((l) => l.includes("STAMP-GOV-01 scanning"));
    expect(scanLine).toBeDefined();
    expect(scanLine).toContain(commit.slice(0, 40));
  });
});

// ─── RFC-1322: STAMP-CHECK-01 — --check-criteria fail-closed ─────────────────
//
// An unchecked criterion can only be auto-checked when its (evidence: ...)
// annotation resolves: test:/file:/<path>:<line> paths must exist on disk;
// probe:AC-N must bind a passing probe in the evidence envelope. Anything else
// aborts the stamp before any write to the RFC file.

const RFC_CHECK_FAIL = (criteria: string): string => `---
id: RFC-0002
title: "Check-criteria fail fixture"
status: accepted
kind: command
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-10-01
updatedAt: 2026-10-01
acceptance:
  - probe: file-exists
    path: src/index.ts
    criterion: AC-1
---

# RFC-0002: Test RFC

## Acceptance criteria

${criteria}
`;

function makeCheckInput(id: string, commit: string): ForgeCommandInput {
  return {
    argv: [],
    flags: { id, "implementation-commit": commit, "check-criteria": true },
  };
}

const envelopePath = (root: string, id: string) =>
  join(root, "docs", "rfcs", "verification", `${id.toLowerCase()}.generated.yaml`);

describe("STAMP-CHECK-01 — unresolvable evidence aborts before any write", () => {
  let workspaceRoot: string;
  let rfcFile: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "rfc-stamp-check-"));
    await mkdir(join(workspaceRoot, "docs", "rfcs"), { recursive: true });
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    execFileSync("git", ["init"], { cwd: workspaceRoot, timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: workspaceRoot,
      timeout: 5000,
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: workspaceRoot,
      timeout: 5000,
    });
    rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0002-check.md");
    mockRunProbe.mockReset();
    mockRunProbe.mockResolvedValue({ probe: {}, ok: true, detail: "exists" });
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n");
    await writeFile(join(workspaceRoot, "src", "real.test.ts"), "// test\n");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("unchecked criterion with no annotation fails STAMP-CHECK-01 before any write", async () => {
    const body = RFC_CHECK_FAIL(
      "- [ ] AC-1: resolvable (evidence: probe:AC-1)\n- [ ] AC-2: bare criterion with no evidence annotation\n",
    );
    await writeFile(rfcFile, body);
    const commit = await commitAll(workspaceRoot, "Implement RFC-0002\n\nX-RFC: RFC-0002");

    const result = await runRfcImplementStamp(
      makeCheckInput("RFC-0002", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    const check = result.data?.violations.find((v) => v.rule === "STAMP-CHECK-01");
    expect(check).toBeDefined();
    expect(check?.message).toContain("AC-2");
    expect(check?.message).toContain("no (evidence: ...) annotation");

    // Abort before any RFC write: bytes untouched. The emit-if-needed pass
    // ran first, so a fresh envelope describing the committed bytes remains —
    // a correct generated artifact, not a partial mutation (RFC-1322 step 5).
    expect(await readFile(rfcFile, "utf-8")).toBe(body);
    await expect(access(envelopePath(workspaceRoot, "RFC-0002"))).resolves.toBeUndefined();
  });

  it("unchecked criterion with a nonexistent test: path fails STAMP-CHECK-01", async () => {
    const body = RFC_CHECK_FAIL(
      "- [ ] AC-1: resolvable (evidence: probe:AC-1)\n- [ ] AC-2: dangling test ref (evidence: test: src/missing.test.ts)\n",
    );
    await writeFile(rfcFile, body);
    const commit = await commitAll(workspaceRoot, "Implement RFC-0002\n\nX-RFC: RFC-0002");

    const result = await runRfcImplementStamp(
      makeCheckInput("RFC-0002", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    const check = result.data?.violations.find((v) => v.rule === "STAMP-CHECK-01");
    expect(check?.message).toContain("AC-2");
    expect(check?.message).toContain("test: src/missing.test.ts");
    expect(await readFile(rfcFile, "utf-8")).toBe(body);
  });

  it("probe:AC-N annotation binding a criterion with no envelope probe fails STAMP-CHECK-01", async () => {
    const body = RFC_CHECK_FAIL(
      "- [ ] AC-1: resolvable (evidence: probe:AC-1)\n- [ ] AC-2: unbound probe ref (evidence: probe:AC-9)\n",
    );
    await writeFile(rfcFile, body);
    const commit = await commitAll(workspaceRoot, "Implement RFC-0002\n\nX-RFC: RFC-0002");

    const result = await runRfcImplementStamp(
      makeCheckInput("RFC-0002", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    const check = result.data?.violations.find((v) => v.rule === "STAMP-CHECK-01");
    expect(check?.message).toContain("AC-2");
    expect(check?.message).toContain("probe:AC-9");
    expect(await readFile(rfcFile, "utf-8")).toBe(body);
  });

  it("a free-form annotation outside the resolvable grammar fails STAMP-CHECK-01", async () => {
    const body = RFC_CHECK_FAIL(
      "- [ ] AC-1: resolvable (evidence: test: src/real.test.ts)\n- [ ] AC-2: prose evidence (evidence: reviewed in the session transcript)\n",
    );
    await writeFile(rfcFile, body);
    const commit = await commitAll(workspaceRoot, "Implement RFC-0002\n\nX-RFC: RFC-0002");

    const result = await runRfcImplementStamp(
      makeCheckInput("RFC-0002", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    const check = result.data?.violations.find((v) => v.rule === "STAMP-CHECK-01");
    expect(check?.message).toContain("AC-2");
    expect(await readFile(rfcFile, "utf-8")).toBe(body);
  });
});
