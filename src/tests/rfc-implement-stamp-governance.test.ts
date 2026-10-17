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
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

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
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceRoot, timeout: 5000 });
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
