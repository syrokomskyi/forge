/*
<MODULE_CONTRACT>
<purpose>
Unit tests for friction.validate (RFC-1433) — the five FRICTION-* rules over
docs/frictions.yaml per the spec's failure-modes table: FRICTION-01 shape +
id format/uniqueness, FRICTION-02 category catalog, FRICTION-03 status enum +
addressed-requires-artifacts, FRICTION-04 date/recurrence ordering,
FRICTION-05 signature/artifact hygiene warnings, and the absent-registry
pass (lazy creation).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the handler owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial suite — per-rule fixtures plus the ENOENT
  entries: 0 contract.</item>
  <item>RFC-1433: review realignment — expectations remapped to the spec's
  failure-modes table; new fixtures for signature normalization and
  artifact-path existence.</item>
  <item>RFC-1433: r2 review — absent required fields → FRICTION-01,
  non-ENOENT read failure, and honest entries count on schema failure.</item>
  <item>RFC-1460: recurring frictions escalate to mechanical measures — FRICTION-06/07/08, registry flips, session-retro escalation</item>
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
  return runFrictionValidate({ argv: [], flags: {} }, testContext());
}

describe("friction.validate — absent registry", () => {
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

  test("non-ENOENT read failure fails closed with FRICTION-01", async () => {
    await fs.rm(path.join(tmpDir, "docs/frictions.yaml"), { force: true });
    await fs.mkdir(path.join(tmpDir, "docs/frictions.yaml"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });
});

describe("friction.validate — FRICTION-01 (shape + id)", () => {
  test("well-formed registry passes", async () => {
    await writeRegistry(VALID_ENTRY);
    const result = await validate();
    expect(result.exitCode, "expected pass, got: " + JSON.stringify(result?.data?.violations)).toBe(
      0,
    );
    expect(result?.data?.entries).toBe(1);
  });

  test("unparseable YAML fails with FRICTION-01", async () => {
    await writeRegistry("- id: F-0001\n  bad: [unclosed\n");
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });

  test("non-array top level fails with FRICTION-01", async () => {
    await writeRegistry("entries: {}\n");
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });

  test("duplicate ids fail with FRICTION-01 naming the id", async () => {
    await writeRegistry(VALID_ENTRY + VALID_ENTRY);
    const result = await validate();
    expect(result.exitCode).toBe(1);
    const dup = result?.data?.violations.find(
      (v) => v.rule === "FRICTION-01" && v.message.includes("Duplicate"),
    );
    expect(dup?.entry).toBe("F-0001");
  });

  test("malformed id fails with FRICTION-01", async () => {
    await writeRegistry(VALID_ENTRY.replace("id: F-0001", "id: FRICTION-1"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });

  test("absent measure fails with FRICTION-01", async () => {
    await writeRegistry(VALID_ENTRY.replace('    measure: "move gate earlier — RFC draft"\n', ""));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });

  test("absent signature or artifacts fail with FRICTION-01", async () => {
    await writeRegistry(
      VALID_ENTRY.replace('    signature: "validator fired late"\n', "").replace(
        "    artifacts: []\n",
        "",
      ),
    );
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.filter((v) => v.rule === "FRICTION-01").length).toBe(2);
  });

  test("entries reports the raw count when the schema fails", async () => {
    await writeRegistry(
      VALID_ENTRY +
        VALID_ENTRY.replace("id: F-0001", "id: F-0002").replace(
          '    measure: "move gate earlier — RFC draft"\n',
          "",
        ),
    );
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.entries).toBe(2);
  });
});

describe("friction.validate — FRICTION-02 (category catalog)", () => {
  test("unknown category fails with FRICTION-02", async () => {
    await writeRegistry(VALID_ENTRY.replace("category: tooling", "category: vibes"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-02")).toBe(true);
  });
});

describe("friction.validate — FRICTION-03 (status + addressed artifacts)", () => {
  test("unknown status fails with FRICTION-03", async () => {
    await writeRegistry(VALID_ENTRY.replace("status: open", "status: maybe"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-03")).toBe(true);
  });

  test("addressed entry without artifacts fails with FRICTION-03", async () => {
    await writeRegistry(VALID_ENTRY.replace("status: open", "status: addressed"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-03")).toBe(true);
  });

  test("addressed entry with a real artifact path passes", async () => {
    await fs.mkdir(path.join(tmpDir, "docs/rfcs"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "docs/rfcs/rfc-1433.md"), "# stub\n");
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed").replace(
        "artifacts: []",
        'artifacts: ["docs/rfcs/rfc-1433.md"]',
      ),
    );
    const result = await validate();
    expect(result.exitCode, "violations: " + JSON.stringify(result?.data?.violations)).toBe(0);
  });
});

describe("friction.validate — FRICTION-04 (ordering)", () => {
  test("lastSeen before created fails with FRICTION-04 even at zero recurrences", async () => {
    await writeRegistry(VALID_ENTRY.replace("lastSeen: 2026-10-29", "lastSeen: 2026-10-01"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-04")).toBe(true);
  });

  test("negative recurrences fails with FRICTION-04", async () => {
    await writeRegistry(VALID_ENTRY.replace("recurrences: 0", "recurrences: -1"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-04")).toBe(true);
  });
});

describe("friction.validate — FRICTION-05 (warnings)", () => {
  test("empty signature warns FRICTION-05 but still passes", async () => {
    await writeRegistry(VALID_ENTRY.replace('signature: "validator fired late"', 'signature: ""'));
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-05")).toBe(true);
  });

  test("non-lowercase signature warns FRICTION-05", async () => {
    await writeRegistry(
      VALID_ENTRY.replace('signature: "validator fired late"', 'signature: "Validator fired LATE"'),
    );
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(
      result?.data?.violations.some(
        (v) => v.rule === "FRICTION-05" && v.message.includes("lowercase"),
      ),
    ).toBe(true);
  });

  test("missing artifact path warns FRICTION-05", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed").replace(
        "artifacts: []",
        'artifacts: ["docs/rfcs/rfc-9999-does-not-exist.md"]',
      ),
    );
    const result = await validate();
    expect(result.exitCode, "violations: " + JSON.stringify(result?.data?.violations)).toBe(0);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-05")).toBe(true);
  });

  test("non-path artifact refs (RFC ids) are not existence-checked", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed").replace(
        "artifacts: []",
        'artifacts: ["RFC-1433"]',
      ),
    );
    const result = await validate();
    expect(result.exitCode, "violations: " + JSON.stringify(result?.data?.violations)).toBe(0);
    expect(result?.data?.violations.filter((v) => v.rule !== "FRICTION-07")).toEqual([]);
  });
});

// RFC-1460: escalation contract — recurring docs-only measures cannot stay
// addressed; escalated entries must name a mechanical obligation.
describe("friction.validate — FRICTION-06 (docs-only recurrence blocks)", () => {
  const ADDR_DOCS = VALID_ENTRY.replace("status: open", "status: addressed").replace(
    "artifacts: []",
    'artifacts: ["AGENTS.md"]',
  );

  test("addressed + docs-rule + recurrences >= 2 fails with FRICTION-06 naming id + signature", async () => {
    await writeRegistry(
      ADDR_DOCS.replace("artifacts:", "measureKind: docs-rule\n    artifacts:")
        .replace("recurrences: 0", "recurrences: 2"),
    );
    const result = await validate();
    expect(result.exitCode).toBe(1);
    const v = result?.data?.violations.find((x) => x.rule === "FRICTION-06");
    expect(v?.entry).toBe("F-0001");
    expect(v?.message).toContain("validator fired late");
  });

  test("inferred docs-only (all-markdown artifacts, no measureKind) fires FRICTION-06", async () => {
    await writeRegistry(ADDR_DOCS.replace("recurrences: 0", "recurrences: 3"));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-06")).toBe(true);
  });

  test("mixed artifacts resolve mechanical — no FRICTION-06", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed")
        .replace("artifacts: []", 'artifacts: ["AGENTS.md", "packages/forge/os/friction/x.ts"]')
        .replace("recurrences: 0", "recurrences: 5"),
    );
    const result = await validate();
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-06")).toBe(false);
  });

  test("mechanical measureKind never fires FRICTION-06 at any recurrence count (AC-3)", async () => {
    for (const kind of ["validator", "code-change", "flag-default", "pipeline", "external"]) {
      await writeRegistry(
        ADDR_DOCS.replace("artifacts:", `measureKind: ${kind}\n    artifacts:`).replace(
          "recurrences: 0",
          "recurrences: 9",
        ),
      );
      const result = await validate();
      expect(
        result?.data?.violations.some((v) => v.rule === "FRICTION-06"),
        `kind ${kind} must not fire FRICTION-06`,
      ).toBe(false);
    }
  });

  test("recurrences < 2 on docs-rule does not fire FRICTION-06", async () => {
    await writeRegistry(
      ADDR_DOCS.replace("artifacts:", "measureKind: docs-rule\n    artifacts:").replace(
        "recurrences: 0",
        "recurrences: 1",
      ),
    );
    const result = await validate();
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-06")).toBe(false);
  });
});

describe("friction.validate — FRICTION-07 (measureKind classification debt)", () => {
  test("addressed without measureKind warns FRICTION-07 but passes", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("status: open", "status: addressed").replace(
        "artifacts: []",
        'artifacts: ["RFC-1433"]',
      ),
    );
    const result = await validate();
    expect(result.exitCode).toBe(0);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-07")).toBe(true);
  });

  test("open or declared entries do not warn FRICTION-07", async () => {
    await writeRegistry(
      VALID_ENTRY +
        VALID_ENTRY.replace("id: F-0001", "id: F-0002")
          .replace("status: open", "status: addressed")
          .replace("artifacts: []", "measureKind: validator\n    artifacts: []"),
    );
    const result = await validate();
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-07")).toBe(false);
  });
});

describe("friction.validate — FRICTION-08 (escalated needs an obligation token)", () => {
  const ESC_BASE = VALID_ENTRY.replace("status: open", "status: escalated").replace(
    "artifacts: []",
    'artifacts: ["AGENTS.md"]',
  );

  test("escalated without a mechanical token in measure fails FRICTION-08", async () => {
    await writeRegistry(ESC_BASE.replace('measure: "move gate earlier — RFC draft"', 'measure: "write another rule"'));
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-08" && v.entry === "F-0001")).toBe(true);
  });

  test("escalated naming RFC id / queue item / path / backticked command passes FRICTION-08", async () => {
    for (const measure of [
      "escalate to `ecosystem.commit` auto-derive",
      "obligation tracked as RFC-1460",
      "obligation tracked in docs/queues/session-x.yaml",
      "mechanism lands in packages/forge/os/friction/handlers/x.ts",
    ]) {
      await writeRegistry(ESC_BASE.replace('measure: "move gate earlier — RFC draft"', `measure: "${measure}"`));
      const result = await validate();
      expect(
        result?.data?.violations.some((v) => v.rule === "FRICTION-08"),
        `measure "${measure}" must satisfy FRICTION-08`,
      ).toBe(false);
    }
  });

  test("unknown measureKind value is a FRICTION-01 shape failure", async () => {
    await writeRegistry(
      VALID_ENTRY.replace("artifacts: []", "measureKind: telepathy\n    artifacts: []"),
    );
    const result = await validate();
    expect(result.exitCode).toBe(1);
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-01")).toBe(true);
  });

  test("status: escalated is a valid enum value (AC-2)", async () => {
    await writeRegistry(
      ESC_BASE.replace('measure: "move gate earlier — RFC draft"', 'measure: "obligation: RFC-1460"'),
    );
    const result = await validate();
    expect(result?.data?.violations.some((v) => v.rule === "FRICTION-03")).toBe(false);
  });
});
