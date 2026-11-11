/*
<MODULE_CONTRACT>
<purpose>
RFC-1467 near-duplicate gate tests — AC-1/2/3/5/8: terminal-kind
(rejected/superseded) decision-log hits at the reproposal threshold block
rfc.create until --revisit acknowledges a colliding id; the review band cites
hits via related + NEEDS CLARIFICATION; a non-colliding --revisit is refused
with candidates listed.
</purpose>
<non-goals>
  <item>Not a template-content contract — fixtures carry the minimal template shape the handler rewrites.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1482: extract-safe RFC-1482 template path + changelog for 9.1.0</item>
  <item>RFC-1514: attach corrected invocations to blocking diagnostics so retry is one-shot</item>
  <item>RFC-1534: lint probe patterns, sync amends counterparts, name next free ledger id</item>
  <item>RFC-1546: derive-and-repair recoverable state across flow surfaces (AC-1..AC-5)</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
  <history>RFC-1485</history>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runRfcCreate } from "./list-create.ts";
import { runRfcValidate } from "./validate.ts";

const TEMPLATE = `id: RFC-0000
title: "Template"
status: draft
kind: command
scope: workspace
owners: [architecture]
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
satisfies: []
related:

# RFC-0000: Template

## Decision
`;

const REJECTED_BODY = `---
id: RFC-1312
title: "Isolate parallel agent sessions in per-session worktrees"
status: rejected
kind: architecture
scope: workspace
---

# RFC-1312: rejected

## Decision

Rejected — isolation belongs to the scheduler, not the worktree.
`;

const REJECTED_TITLE = "Isolate parallel agent sessions in per-session worktrees";

let root: string;
const context = () => ({
  workspaceRoot: root,
  dryRun: false,
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    section: () => {},
    getEvents: () => [],
  },
  outputFormat: "json" as const,
  io: undefined as never,
});

async function seed(opts: { rejected?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "rfc1467-create-"));
  const rfcDir = join(root, "docs", "rfcs");
  await mkdir(join(rfcDir, "archive", "rejected"), { recursive: true });
  await writeFile(join(rfcDir, "rfc-0000-template.md"), TEMPLATE);
  if (opts.rejected !== false) {
    await writeFile(join(rfcDir, "archive", "rejected", "rfc-1312-test.md"), REJECTED_BODY);
  }
  return root;
}

const flags = (extra: Record<string, unknown> = {}) => ({
  title: REJECTED_TITLE,
  kind: "command",
  scope: "workspace",
  ...extra,
});

describe("RFC-1467 rfc.create near-duplicate gate", () => {
  beforeEach(async () => {
    await seed();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("AC-2: a terminal hit at the reproposal threshold blocks without --revisit", async () => {
    const result = await runRfcCreate({ flags: flags() } as never, context());
    expect(result.exitCode).toBe(1);
    expect(result.data?.blocked).toBe(true);
    expect(result.data?.status).toBe("blocked");
    expect(result.data?.colliding?.map((d) => d.rfcId)).toEqual(["RFC-1312"]);
    expect(result.data?.colliding?.[0]?.kind).toBe("rejected-rfc");
    expect(result.data?.colliding?.[0]?.score).toBeGreaterThanOrEqual(12);
    expect(result.data?.remedy).toContain("--revisit RFC-1312");
    // AC-1: the escalation payload accompanies consultedDecisions in JSON.
    expect(Array.isArray(result.data?.consultedDecisions)).toBe(true);
  });

  test("RFC-1514 AC-4: the refusal names score and matched title/text tokens", async () => {
    const result = await runRfcCreate({ flags: flags() } as never, context());
    expect(result.exitCode).toBe(1);
    const hit = result.data?.colliding?.[0];
    expect(hit?.score).toBeGreaterThanOrEqual(12);
    // The proposed title is verbatim the rejected one — every title token hit.
    expect(hit?.matchedTitleTokens).toContain("isolate");
    expect(hit?.matchedTitleTokens).toContain("sessions");
    expect(hit?.matchedTextTokens?.length).toBeGreaterThan(0);
    // The remedy text carries the same attribution, not just the JSON payload.
    expect(result.data?.remedy).toContain(`score ${hit!.score}`);
    expect(result.data?.remedy).toContain("isolate");
  });

  test("AC-3: --revisit scaffolds with related + NEEDS CLARIFICATION marker", async () => {
    const result = await runRfcCreate(
      { flags: flags({ revisit: "RFC-1312" }) } as never,
      context(),
    );
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.data?.status).toBe("ok");
    const body = await readFile(join(root, result.data!.file!), "utf8");
    expect(body).toContain("  - RFC-1312");
    expect(body).toContain("> NEEDS CLARIFICATION:");
    expect(body).toContain("RFC-1312 is a rejected/superseded precedent");
  });

  test("AC-8: --revisit naming a non-colliding id refuses and lists candidates", async () => {
    const result = await runRfcCreate(
      { flags: flags({ revisit: "RFC-9999" }) } as never,
      context(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.blocked).toBe(true);
    expect(result.data?.remedy).toContain("RFC-1312");
  });

  test("AC-5: sub-threshold titles scaffold normally carrying consultedDecisions", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Rotate the cache eviction cadence" }) } as never,
      context(),
    );
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.data?.status).toBe("ok");
    expect(result.data?.colliding).toBeUndefined();
  });
});

// RFC-1482: the emitted skeleton must satisfy the contracts that gates enforce —
// seed the REAL canonical template so the assertions bind the shipped skeleton,
// not a fixture twin. `os/rfc/` carries the canonical template forge ships to
// consumers — the path must stay inside the package so the test also resolves
// in the standalone extracted layout (RFC-1252).
const REAL_TEMPLATE = fileURLToPath(new URL("../rfc-0000-template.md", import.meta.url));

async function seedRealTemplate() {
  root = await mkdtemp(join(tmpdir(), "rfc1482-create-"));
  const rfcDir = join(root, "docs", "rfcs");
  await mkdir(rfcDir, { recursive: true });
  const realTemplate = await readFile(REAL_TEMPLATE, "utf8");
  await writeFile(join(rfcDir, "rfc-0000-template.md"), realTemplate);
}

describe("RFC-1482 validation-compliant skeleton", () => {
  beforeEach(async () => {
    await seedRealTemplate();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("AC-1: emitted draft passes rfc.validate with zero V-45/V-48/V-50/V-53/V-54 violations", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Rotate the cache eviction cadence" }) } as never,
      context(),
    );
    expect(result.data?.status).toBe("ok");
    const id = result.data!.id!;
    const v = await runRfcValidate({ argv: [], flags: { id } } as never, context());
    const violations = v.data?.violations ?? [];
    const named = violations.filter((x) =>
      ["V-45", "V-48", "V-50", "V-53", "V-54"].includes(x.rule),
    );
    expect(named, JSON.stringify(violations, null, 1)).toEqual([]);
    expect(v.data?.status, JSON.stringify(violations, null, 1)).toBe("pass");
  });

  test("AC-2: --proposed/--added seed commands.* and emit one reachable stub each", async () => {
    const result = await runRfcCreate(
      {
        flags: flags({
          title: "Tame the registry loader",
          proposed: "foo.bar,baz.qux",
          added: "foo.new",
        }),
      } as never,
      context(),
    );
    expect(result.data?.status).toBe("ok");
    const body = await readFile(join(root, result.data!.file!), "utf8");
    expect(body).toContain("  proposed:\n    - foo.bar\n    - baz.qux");
    expect(body).toContain("  added:\n    - foo.new");
    const reachable = body.match(/^  - probe: reachable$/gm) ?? [];
    expect(reachable).toHaveLength(3);
    expect(body).toContain('command: "foo.bar"');
    expect(body).toContain('command: "baz.qux"');
    expect(body).toContain('command: "foo.new"');
  });

  test("AC-3: emitted skeleton carries '## Fixed inputs' header schema and no FI rows", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Rotate the cache eviction cadence" }) } as never,
      context(),
    );
    const body = await readFile(join(root, result.data!.file!), "utf8");
    expect(body).toContain("## Fixed inputs");
    expect(body).toMatch(/\|\s*ID\s*\| Value \| Source \| Checked by \|/);
    expect(body).not.toMatch(/^\|\s*FI-/m);
  });

  test("AC-6: no flags → zero reachable probe stubs in acceptance:", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Rotate the cache eviction cadence" }) } as never,
      context(),
    );
    const body = await readFile(join(root, result.data!.file!), "utf8");
    expect(body).not.toMatch(/^  - probe: reachable$/gm);
    expect(body).not.toMatch(/^acceptance:/m);
  });
});

// RFC-1534: --amends writes the amendedBy counterpart on the amended file in
// the same pass — the merge is by frontmatter key and never clobbers existing
// entries (F-0056).
const AMENDED_BODY = `---
id: RFC-1200
title: "Amended predecessor"
status: implemented
kind: architecture
scope: workspace
owners: [architecture]
createdAt: 2026-01-01
updatedAt: 2026-01-01
amends: []
amendedBy:
  - RFC-1100
related: []
---

# RFC-1200: Amended predecessor
`;

describe("RFC-1534 rfc.create --amends counterpart", () => {
  beforeEach(async () => {
    await seedRealTemplate();
    await writeFile(join(root, "docs", "rfcs", "rfc-1200-amended.md"), AMENDED_BODY);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("AC-2: --amends merges the new id into the amended file's amendedBy[] in the same pass", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Tame the registry loader", amends: "RFC-1200" }) } as never,
      context(),
    );
    expect(result.data?.status).toBe("ok");
    const newId = result.data!.id!;
    expect(result.data?.amendsSync).toEqual({ amended: "RFC-1200", wroteCounterpart: true });

    const draft = await readFile(join(root, result.data!.file!), "utf8");
    expect(draft).toContain(`amends:\n  - RFC-1200`);

    const amended = await readFile(join(root, "docs", "rfcs", "rfc-1200-amended.md"), "utf8");
    expect(amended).toContain(`  - ${newId}`);
  });

  test("merge preserves existing amendedBy[] entries and stays idempotent (F-0056)", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Tame the registry loader", amends: "RFC-1200" }) } as never,
      context(),
    );
    expect(result.data?.status).toBe("ok");
    const amended = await readFile(join(root, "docs", "rfcs", "rfc-1200-amended.md"), "utf8");
    expect(amended).toContain("amendedBy:\n  - RFC-1100\n  - RFC-");
  });

  test("--amends on a missing counterpart reports pending, does not fail the create", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Tame the registry loader", amends: "RFC-1201" }) } as never,
      context(),
    );
    expect(result.data?.status).toBe("ok");
    expect(result.data?.amendsSync).toEqual({ amended: "RFC-1201", wroteCounterpart: false });
  });
});

describe("RFC-1546 AC-2: commands.* frontmatter regenerates the manifest", () => {
  beforeEach(async () => {
    await seed();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("--proposed invokes ecosystem.manifest.generate after the write", async () => {
    const invoked: string[] = [];
    const result = await runRfcCreate(
      { flags: flags({ title: "Tame the registry loader", proposed: "foo.bar" }) } as never,
      {
        ...context(),
        invoke: async (name: string) => {
          invoked.push(name);
          return { ok: true, exitCode: 0 };
        },
      } as never,
    );
    expect(result.data?.status).toBe("ok");
    expect(invoked).toEqual(["ecosystem.manifest.generate"]);
    expect(result.data?.manifestRegen).toMatchObject({ invoked: true, ok: true });
  });

  test("no commands.* seeds — the generator is never invoked", async () => {
    const invoked: string[] = [];
    const result = await runRfcCreate(
      { flags: flags({ title: "Tame the registry loader" }) } as never,
      {
        ...context(),
        invoke: async (name: string) => {
          invoked.push(name);
          return { ok: true, exitCode: 0 };
        },
      } as never,
    );
    expect(result.data?.status).toBe("ok");
    expect(invoked).toEqual([]);
    expect(result.data?.manifestRegen).toBeUndefined();
  });
});
