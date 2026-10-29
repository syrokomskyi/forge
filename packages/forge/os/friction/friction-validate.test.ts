/*
<MODULE_CONTRACT>
<purpose>
Unit tests for friction.validate (RFC-1433) — the five FRICTION-* rules over
docs/frictions.yaml: schema failures, duplicate ids, enum violations,
hygiene warnings, and the absent-registry pass (lazy creation).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the handler owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial suite — per-rule fixtures plus the ENOENT
  entries: 0 contract.</item>
  <item>RFC-1433: os/friction module, friction.validate, retro autopsy + RFC fast-path

Add friction.validate (FRICTION-01..05, contract frictions) over the
append-only docs/frictions.yaml registry; absent file passes with
entries: 0 per lazy-creation contract. fo-session-retro gains the
autopsy step (signal checklist, signature matching, harvest mode +
triggerPhrases) and fo-idea-create-rfc the friction fast-path. Module
registered in bin/cli.ts, WORKSHOP_MODULE_MAP.forge, package.json
exports; AGENTS.md module row; 13 vitest cases.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runFrictionValidate } from "./handlers/friction-validate.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friction-validate-test-"));
  await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
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

const VALID_ENTRY = `  - id: F-0001
    created: 2026-10-29
    session: 2026-10-29-16-20-00-3e0805
    category: tooling
    friction: "validator fired late"
    signature: "validator fired late"
    measure: "move gate earlier — RFC draft"
    artifacts: []
    status: open
    recurrences: 0
    lastSeen: 2026-10-29
`;

async function writeRegistry(body: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, "docs/frictions.yaml"), body);
}

async function validate() {
  return runFrictionValidate(
    { argv: [], flags: {} },
    testContext(),
  );
}

describe("friction.validate — absent registry (RFC-1433 AC-10)", () => {
  test("ENOENT passes with entries: 0", async () => {
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.status).toBe("pass");
    expect(result?.data?.entries).toBe(0);
  });

  test("empty list passes with entries: 0", async () => {
    await writeRegistry("[]\n");
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.entries).toBe(0);
  });
});

describe("friction.validate — FRICTION-01 (structural)", () => {
  test("well-formed registry passes", async () => {
    await writeRegistry(VALID_ENTRY);
    const result = await validate();
    expect(result.exitCode, "expected pass, got: " + JSON.stringify(result?.data?.errors)).toBe(0);
    expect(result?.data?.entries).toBe(1);
  });

  test("unparseable YAML fails with FRICTION-01", async () => {
    await writeRegistry("- id: F-0001\n  bad: [unclosed\n");
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "FRICTION-01")).toBe(true);
  });

  test("non-array top level fails with FRICTION-01", async () => {
    await writeRegistry("entries: {}\n");
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "FRICTION-01")).toBe(true);
  });
});

describe("friction.validate — FRICTION-02 (id uniqueness)", () => {
  test("duplicate ids fail with FRICTION-02", async () => {
    await writeRegistry(VALID_ENTRY + VALID_ENTRY);
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "FRICTION-02")).toBe(true);
  });

  test("malformed id fails the schema (FRICTION-01)", async () => {
    await writeRegistry(VALID_ENTRY.replace("id: F-0001", "id: FRICTION-1"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.length).toBeGreaterThan(0);
  });
});

describe("friction.validate — FRICTION-03 (closed enums)", () => {
  test("unknown category fails with FRICTION-03", async () => {
    await writeRegistry(VALID_ENTRY.replace("category: tooling", "category: vibes"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "FRICTION-03")).toBe(true);
  });

  test("unknown status fails with FRICTION-03", async () => {
    await writeRegistry(VALID_ENTRY.replace("status: open", "status: maybe"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.errors.some((e) => e.ruleId === "FRICTION-03")).toBe(true);
  });
});

describe("friction.validate — FRICTION-04/05 (hygiene warnings)", () => {
  test("open entry with empty measure warns FRICTION-04 but still passes", async () => {
    await writeRegistry(VALID_ENTRY.replace('measure: "move gate earlier — RFC draft"', 'measure: ""'));
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.warnings.some((w) => w.ruleId === "FRICTION-04")).toBe(true);
  });

  test("addressed entry without artifacts warns FRICTION-05", async () => {
    await writeRegistry(VALID_ENTRY.replace("status: open", "status: addressed"));
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.warnings.some((w) => w.ruleId === "FRICTION-05")).toBe(true);
  });

  test("recurrences with lastSeen before created warns FRICTION-05", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("recurrences: 0", "recurrences: 2").replace(
        "lastSeen: 2026-10-29",
        "lastSeen: 2026-10-01",
      ),
    );
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.warnings.some((w) => w.ruleId === "FRICTION-05")).toBe(true);
  });

  test("addressed entry with artifacts produces no warnings", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed").replace(
        "artifacts: []",
        'artifacts: ["docs/rfcs/rfc-1433.md"]',
      ),
    );
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.warnings).toEqual([]);
  });
});
