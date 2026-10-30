/*
<MODULE_CONTRACT>
<purpose>
RFC-1453: V-47/V-48 tests — `page` probes require `target` on non-archived
files (error), archived files exempt; V-48 warns when packagesImpacted
touches an outcomeSurfaces glob without a declared outcome probe (AC-8).
</purpose>
<non-goals>
  <item>Do not exercise outcome execution — the session-level path is covered by acceptance.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1453: V-47 page-target + V-48 outcome-surface validation tests.</item>
  <item>RFC-1453: executed outcome probes, IMP-14 surface gate, outcome.serve + V-47/V-48</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

interface Seen {
  rule: string;
  severity?: string;
}

const pageProbeNoTarget = { probe: "page", path: "/", selector: "h1", criterion: "AC-1" };
const pageProbeWithTarget = {
  probe: "page",
  target: "site-a",
  path: "/",
  selector: "h1",
  criterion: "AC-1",
};

const makeParsed = (fm: Record<string, unknown>): ParsedRfc => ({
  frontmatter: {
    id: "RFC-9999",
    title: "Test RFC",
    status: "draft",
    kind: "policy",
    scope: "workspace",
    owners: ["architecture"],
    createdAt: "2026-10-30",
    updatedAt: "2026-10-30",
    ...fm,
  },
  body: "# RFC-9999: Test RFC\n",
});

const runValidate = async (
  fileName: string,
  parsed: ParsedRfc,
  workspaceRoot: string,
): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const add: AddViolationFn = (_id, _file, rule, _msg, severity) =>
    void seen.push({ rule, severity });
  await validateSingleRfc(
    fileName,
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    workspaceRoot,
    add,
  );
  return seen;
};

const FORGE_YAML_SURFACES = `schema: forge/config@1
project:
  name: fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    outcomeBuild: pnpm exec werkstatt run mission.validate --site {target} --json
    outcomeServe: pnpm exec werkstatt run outcome.serve --site {target}
  paths: {}
outcomeSurfaces:
  - packages/werkstatt-site/src/domain/ui/**
`;

describe("V-47 — page probes require target (AC-8)", () => {
  test("errors on a page probe without target", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ acceptance: [pageProbeNoTarget] }),
      join(tmpdir(), "rfc1453-ws"),
    );
    expect(violations.some((v) => v.rule === "V-47")).toBe(true);
  });

  test("passes a page probe with target", async () => {
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ acceptance: [pageProbeWithTarget] }),
      join(tmpdir(), "rfc1453-ws"),
    );
    expect(violations.some((v) => v.rule === "V-47")).toBe(false);
  });

  test("exempts archived RFCs — pre-field page probes stay frozen", async () => {
    const violations = await runValidate(
      "archive/rfc-9999-test.md",
      makeParsed({ acceptance: [pageProbeNoTarget] }),
      join(tmpdir(), "rfc1453-ws"),
    );
    expect(violations.some((v) => v.rule === "V-47")).toBe(false);
  });
});

describe("V-48 — outcome-surface packages need an outcome probe (warning)", () => {
  test("warns when packagesImpacted touches an outcome surface without an outcome probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfc1453-v48-"));
    await writeFile(join(dir, "forge.yaml"), FORGE_YAML_SURFACES);
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        packagesImpacted: ["werkstatt-site"],
        acceptance: [{ probe: "test", file: "x.test.ts", expect: { exitCode: 0 } }],
      }),
      dir,
    );
    const v48 = violations.filter((v) => v.rule === "V-48");
    expect(v48).toHaveLength(1);
    expect(v48[0]!.severity).toBe("warning");
  });

  test("silent when an outcome probe is declared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfc1453-v48-"));
    await writeFile(join(dir, "forge.yaml"), FORGE_YAML_SURFACES);
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        packagesImpacted: ["werkstatt-site"],
        acceptance: [pageProbeWithTarget],
      }),
      dir,
    );
    expect(violations.some((v) => v.rule === "V-48")).toBe(false);
  });

  test("silent when packagesImpacted avoids every outcome surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfc1453-v48-"));
    await writeFile(join(dir, "forge.yaml"), FORGE_YAML_SURFACES);
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        packagesImpacted: ["forge"],
        acceptance: [{ probe: "test", file: "x.test.ts", expect: { exitCode: 0 } }],
      }),
      dir,
    );
    expect(violations.some((v) => v.rule === "V-48")).toBe(false);
  });
});
