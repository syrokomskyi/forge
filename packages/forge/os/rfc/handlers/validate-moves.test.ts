/*
<MODULE_CONTRACT>
<purpose>
RFC-1596: V-56 `moves` declaration tests — a workshop-tooling RFC (post-cutoff
createdAt, kind ∈ {architecture, contract, command, policy}, no appsImpacted,
no outcome-surface package) must name the loopMetrics metric it moves, or
`none` with a reason. Silent when the project declares no loopMetrics (AC-4);
terminal statuses keep a frozen record for removed metric ids.
</purpose>
<non-goals>
  <item>Do not exercise the stamp path — V-56 is a validate-time rule only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1596: V-56 moves-declaration tests (AC-1..AC-4 + subject boundary).</item>
  <item>RFC-1596: V-56 moves declaration on workshop-tooling RFCs

loopMetrics vocabulary in forge.yaml (7 site-loop metrics), V-56 validator rule (subject = loopMetrics declared + createdAt >= adoption + tooling kind + no app/outcome-surface impact; missing moves / undeclared id / none-without-reason / missing baseline+target all error; terminal-status immunity for removed ids), moves.metric copied into rfc.index.generate entries, commented moves block in the RFC template, moves on RFC-1596 itself, and skill guidance in fo-idea-create-rfc (baseline read from the metric's source) + fo-idea-audit (flag a target restating the deliverable).</item>
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
  message: string;
  severity?: string;
}

const FORGE_YAML_METRICS = `schema: forge/config@1
project:
  name: fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands: {}
  paths: {}
outcomeSurfaces:
  - packages/werkstatt-site/src/domain/ui/**
loopMetrics:
  - id: validate-wall-content-edit
    description: Wall time of mission.validate after a one-file content edit
    source: docs/metrics/site-throughput.generated.yaml
  - id: integrate-refusal-rate
    description: Share of flow.integrate runs that end in a refusal
    source: forge/gate-runs (gate.run.status)
`;

const makeParsed = (fm: Record<string, unknown>): ParsedRfc => ({
  frontmatter: {
    id: "RFC-9999",
    title: "Test RFC",
    status: "draft",
    kind: "command",
    scope: "workspace",
    owners: ["architecture"],
    createdAt: "2026-11-14",
    updatedAt: "2026-11-14",
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
  const add: AddViolationFn = (_id, _file, rule, msg, severity) =>
    void seen.push({ rule, message: msg, severity });
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

const workspaceWithMetrics = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "rfc1596-v56-"));
  await writeFile(join(dir, "forge.yaml"), FORGE_YAML_METRICS);
  return dir;
};

const v56 = (violations: Seen[]) => violations.filter((v) => v.rule === "V-56");

describe("V-56 — tooling RFCs declare the loop metric they move (RFC-1596)", () => {
  test("AC-1: errors when a subject RFC has no moves block", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate("rfc-9999-test.md", makeParsed({}), dir);
    expect(v56(violations)).toHaveLength(1);
    expect(v56(violations)[0]!.severity).toBe("error");
    expect(v56(violations)[0]!.message).toContain("moves");
  });

  test("AC-2: errors naming the declared ids when moves.metric is undeclared and not none", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        moves: { metric: "made-up-metric", baseline: "x", target: "y" },
      }),
      dir,
    );
    expect(v56(violations)).toHaveLength(1);
    expect(v56(violations)[0]!.message).toContain("validate-wall-content-edit");
    expect(v56(violations)[0]!.message).toContain("integrate-refusal-rate");
  });

  test("AC-3: errors when moves.metric is none without a reason", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ moves: { metric: "none" } }),
      dir,
    );
    expect(v56(violations)).toHaveLength(1);
    expect(v56(violations)[0]!.message).toContain("reason");
  });

  test("AC-4: silent when forge.yaml declares no loopMetrics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfc1596-v56-nometrics-"));
    await writeFile(
      join(dir, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: fixture\npaths: {}\n`,
    );
    const violations = await runValidate("rfc-9999-test.md", makeParsed({}), dir);
    expect(v56(violations)).toHaveLength(0);
  });

  test("passes with a declared metric plus baseline and target", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        moves: {
          metric: "integrate-refusal-rate",
          baseline: "22 of 51 runs refused (gate-run records 2026-11-11..14)",
          target: "under 10 %",
        },
      }),
      dir,
    );
    expect(v56(violations)).toHaveLength(0);
  });

  test("passes with metric none plus a reason", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ moves: { metric: "none", reason: "security hardening" } }),
      dir,
    );
    expect(v56(violations)).toHaveLength(0);
  });

  test("errors when a declared metric lacks baseline or target", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ moves: { metric: "integrate-refusal-rate", target: "under 10 %" } }),
      dir,
    );
    expect(v56(violations)).toHaveLength(1);
    expect(v56(violations)[0]!.message).toContain("baseline");
  });

  test("exempt when createdAt predates the adoption cutoff", async () => {
    const dir = await workspaceWithMetrics();
    const violations = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ createdAt: "2026-11-13" }),
      dir,
    );
    expect(v56(violations)).toHaveLength(0);
  });

  test("exempt for deprecation kind, app impact, and outcome-surface packages", async () => {
    const dir = await workspaceWithMetrics();
    for (const fm of [
      { kind: "deprecation" },
      { appsImpacted: ["warpgogol-com"] },
      { packagesImpacted: ["werkstatt-site"] },
    ]) {
      const violations = await runValidate("rfc-9999-test.md", makeParsed(fm), dir);
      expect(v56(violations), `subject boundary ${JSON.stringify(fm)}`).toHaveLength(0);
    }
  });

  test("terminal statuses are immune to a removed metric id but not to a missing moves", async () => {
    const dir = await workspaceWithMetrics();
    const removed = await runValidate(
      "rfc-9999-test.md",
      makeParsed({
        status: "implemented",
        implementedAt: "2026-11-14",
        moves: { metric: "retired-metric", baseline: "x", target: "y" },
      }),
      dir,
    );
    expect(v56(removed)).toHaveLength(0);
    const missing = await runValidate(
      "rfc-9999-test.md",
      makeParsed({ status: "implemented", implementedAt: "2026-11-14" }),
      dir,
    );
    expect(v56(missing)).toHaveLength(1);
  });
});
