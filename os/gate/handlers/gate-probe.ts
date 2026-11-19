/*
<MODULE_CONTRACT>
<purpose>
RFC-1469: gate.probe — inject a declared violation at its real workspace path
(backup → write → invoke the check → restore), compare the expect block by
ruleId + pathPattern. A seeded violation the check can't see is a dead gate —
the probe proves the gate still fires on its real scan path, not a fabricated
fixture shape. mutatesState: true (in-tree writes, always restored).
</purpose>
<non-goals>
  <item>Never invent probe targets — probes come only from the declared fixture inventory.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate.probe in-tree injection + invoke + restore (r1 repair)</item>
  <item>RFC-1469: apply r2 repairs — contracts-root inventory join, PROBE-03/05 declarations, dir-skeleton sweep, stale doc text</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
  <item>RFC-1592: probe-or-retire ratchet for blocking check rules

Every error-severity check rule now needs liveness evidence — a bound
gate-probe fixture that has actually run — or an explicit entry in the
shrink-only unprobed baseline, enforced by gate.probe.catalog --check
(PROBE-06/07) and wired into the worktree gate as probe-ratchet.

- probe-runs journal (docs/.index/gate-probes/runs.jsonl) records each
  gate.probe fixture execution; shared liveness.ts joins fixtures x
  journal for catalog + contribution report (liveness: none|fixture|fired)
- gate.probe.catalog --check/--write-baseline: PROBE-06 unprobed error
  rule, PROBE-07 stale baseline entry, PROBE-08 baseline growth refusal
  (shrink-only, no file modification), PROBE-09 expired/undeclared
  warnOnly provisional step
- checks.contribution.report adds liveness to every rule record
- KernelPipelineStep/RuleDescriptor gain provisionalUntil; the two
  warnOnly pipeline steps carry future dates
- worktree gate adds probe-ratchet step; gate-domains + forge pre-lock
  DELTA_STEP_SPECS mirror updated
- build-verification policy states blocking rules are probed or retired;
  fo-session-retro preserves probe/retire evidence for escape frictions
- baseline adopted at 1678 entries (forge/unprobed-baseline@1)</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { recordProbeRuns, type ProbeRunRecord } from "./probe-runs-journal.ts";

export interface ProbeFixture {
  rule: string;
  contract: string;
  derivedFrom?: string;
  spec: { files?: Record<string, string>; from?: string };
  expect: { command?: string; rule: string; minDiagnostics?: number; pathPattern?: string };
}

export interface ProbeReport {
  ruleId: "PROBE-01" | "PROBE-02" | "PROBE-05";
  fixture: string;
  rule: string;
  status: "pass" | "fail" | "error";
  diagnostics: number;
  detail?: string;
}

export interface GateProbeData {
  command: "gate.probe";
  status: "ok" | "failures";
  probed: number;
  reports: ProbeReport[];
}

async function collectFixtures(
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<{ path: string; fixture: ProbeFixture }[]> {
  const out: { path: string; fixture: ProbeFixture }[] = [];
  const base = path.join(root, "docs", "gate-probes");
  const contracts = await io
    .readdir(base)
    .catch(() => [] as { name: string; isDirectory: boolean }[]);
  for (const c of contracts) {
    if (!c.isDirectory || c.name.startsWith("_")) continue;
    const cdir = path.join(base, c.name);
    for (const r of await io
      .readdir(cdir)
      .catch(() => [] as { name: string; isDirectory: boolean }[])) {
      if (!r.isDirectory) continue;
      const fp = path.join(cdir, r.name, "fixture.yaml");
      const src = await io.readFile(fp).catch(() => null);
      if (src === null) continue;
      const parsed = yamlParse(src) as ProbeFixture | null;
      if (parsed && typeof parsed === "object" && typeof parsed.rule === "string") {
        out.push({ path: path.relative(root, fp).split(path.sep).join("/"), fixture: parsed });
      }
    }
  }
  return out;
}

function shapeError(fp: string, fixture: ProbeFixture): string | null {
  if (!fixture.expect || typeof fixture.expect.rule !== "string") return "missing expect.rule";
  if (!fixture.spec || typeof fixture.spec !== "object") return "missing spec";
  if (fixture.spec.from) return `spec.from: template unsupported in v1 — inline files only (${fp})`;
  if (
    !fixture.spec.files ||
    typeof fixture.spec.files !== "object" ||
    Object.keys(fixture.spec.files).length === 0
  ) {
    return "missing spec.files";
  }
  return null;
}

export async function runGateProbe(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<GateProbeData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const fixtures = await collectFixtures(root, io);
  const ruleFilter = input.flags["rule"] as string | undefined;
  const contractFilter = input.flags["contract"] as string | undefined;
  const list = input.flags["list"] === true;

  let selected = fixtures;
  if (ruleFilter) selected = selected.filter((f) => f.fixture.rule === ruleFilter);
  if (contractFilter) selected = selected.filter((f) => f.fixture.contract === contractFilter);

  if (list) {
    return {
      data: {
        command: "gate.probe",
        status: "ok",
        probed: selected.length,
        reports: selected.map((f) => ({
          ruleId: "PROBE-01" as const,
          fixture: f.path,
          rule: f.fixture.rule,
          status: "pass" as const,
          diagnostics: 0,
          detail: `${f.fixture.contract} (derivedFrom: ${f.fixture.derivedFrom ?? "none"})`,
        })),
      },
      summary: `${selected.length} fixture(s) declared`,
      exitCode: 0,
    };
  }

  if (!context.invoke) {
    return {
      data: {
        command: "gate.probe",
        status: "failures",
        probed: 0,
        reports: [
          {
            ruleId: "PROBE-01",
            fixture: "-",
            rule: "-",
            status: "error",
            diagnostics: 0,
            detail: "context.invoke absent — run under the kernel",
          },
        ],
      },
      summary: "gate.probe failed — invoke port absent",
      exitCode: 1,
    };
  }

  const reports: ProbeReport[] = [];
  for (const { path: fp, fixture } of selected) {
    const shape = shapeError(fp, fixture);
    if (shape !== null) {
      reports.push({
        ruleId: "PROBE-05",
        fixture: fp,
        rule: fixture.rule,
        status: "error",
        diagnostics: 0,
        detail: `fixture shape: ${shape}`,
      });
      continue;
    }
    const files = fixture.spec.files!;
    // Path guard — fixture files must be workspace-relative, never escape.
    const bad = Object.keys(files).find((rel) => rel.includes("..") || path.isAbsolute(rel));
    if (bad !== undefined) {
      reports.push({
        ruleId: "PROBE-05",
        fixture: fp,
        rule: fixture.rule,
        status: "error",
        diagnostics: 0,
        detail: `fixture path "${bad}" escapes the workspace — rejected`,
      });
      continue;
    }

    // Inject at the real paths — a seeded violation only proves liveness when
    // it lands inside the check's real scan path.
    const backups: [string, string | null][] = [];
    const createdDirs: string[] = [];
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        backups.push([abs, await io.readFile(abs).catch(() => null)]);
        const dir = path.dirname(abs);
        if (!(await io.exists(dir))) {
          // Track the highest created ancestor so the skeleton can be swept.
          let cur = dir;
          while (!(await io.exists(cur))) {
            createdDirs.push(cur);
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
          }
        }
        await io.mkdir(dir);
        await io.writeFile(abs, content);
      }
      const res = await context.invoke(fixture.expect.command ?? fixture.expect.rule, {});
      // Checks emit their verdicts under different keys — diagnostics for the
      // normalized runners, errors/warnings or violations for validators that
      // keep their own report shape (friction.validate). Union them all.
      const data = res.data as
        | {
            diagnostics?: { ruleId?: string; file?: string }[];
            errors?: { ruleId?: string; file?: string }[];
            warnings?: { ruleId?: string; file?: string }[];
            violations?: { rule?: string; file?: string }[];
          }
        | undefined;
      const diags = [
        ...(data?.diagnostics ?? []),
        ...(data?.errors ?? []),
        ...(data?.warnings ?? []),
      ];
      // violations[] overlaps errors[]/warnings[] on validators that emit all
      // three — only fall back when the normalized keys are absent.
      if (diags.length === 0) {
        diags.push(...(data?.violations ?? []).map((v) => ({ ruleId: v.rule, file: v.file })));
      }
      const fired = diags.filter((d) => d.ruleId === fixture.expect.rule);
      const pathOk =
        !fixture.expect.pathPattern ||
        fired.some((d) => (d.file ?? "").includes(fixture.expect.pathPattern!));
      const firedCount = fired.length;
      if (firedCount >= (fixture.expect.minDiagnostics ?? 1) && pathOk) {
        reports.push({
          ruleId: "PROBE-01",
          fixture: fp,
          rule: fixture.rule,
          status: "pass",
          diagnostics: firedCount,
          detail: `check fired ${firedCount} ${fixture.expect.rule} diagnostic(s) on the seeded violation`,
        });
      } else if (firedCount > 0 && !pathOk) {
        reports.push({
          ruleId: "PROBE-02",
          fixture: fp,
          rule: fixture.rule,
          status: "fail",
          diagnostics: firedCount,
          detail: `check fired ${fixture.expect.rule} but not on ${fixture.expect.pathPattern} — the rule fires on the wrong scope`,
        });
      } else if (diags.length > 0) {
        reports.push({
          ruleId: "PROBE-02",
          fixture: fp,
          rule: fixture.rule,
          status: "fail",
          diagnostics: diags.length,
          detail: `check emitted ${diags.length} diagnostic(s) but none of rule ${fixture.expect.rule} — binding drift`,
        });
      } else {
        reports.push({
          ruleId: "PROBE-01",
          fixture: fp,
          rule: fixture.rule,
          status: "fail",
          diagnostics: 0,
          detail: `check did not fire ${fixture.expect.rule} on the seeded violation (exit ${res.exitCode}) — gate is dead`,
        });
      }
    } catch (err) {
      reports.push({
        ruleId: "PROBE-01",
        fixture: fp,
        rule: fixture.rule,
        status: "error",
        diagnostics: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Restore — every injected file is unwound, prior bytes restored, and
      // the created directory skeletons are swept deepest-first.
      for (const [abs, prior] of backups.reverse()) {
        try {
          if (prior === null) await io.rm(abs);
          else await io.writeFile(abs, prior);
        } catch (err) {
          context.logger.warn(
            `probe restore failed for ${path.relative(root, abs)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      for (const dir of createdDirs.sort((a, b) => b.length - a.length)) {
        await io.rm(dir).catch(() => {});
      }
    }
  }

  // RFC-1592: journal every executed fixture — "fixture" liveness reads the
  // last recorded run per rule. --list and a missing invoke port exit earlier
  // and journal nothing (no run happened).
  const runId = `gate.probe-${new Date().toISOString()}`;
  const journalWarn = await recordProbeRuns(
    root,
    reports.map((r, i): ProbeRunRecord => ({
      runId,
      fixture: r.fixture,
      contract: selected[i]?.fixture.contract ?? "?",
      rule: r.rule,
      status: r.status,
      diagnostics: r.diagnostics,
      at: new Date().toISOString(),
    })),
  );
  if (journalWarn) context.logger.warn(journalWarn);

  const failed = reports.filter((r) => r.status !== "pass");
  if (context.outputFormat === "pretty") {
    for (const r of reports) {
      const fn = r.status === "pass" ? context.logger.success : context.logger.warn;
      fn(`${r.status.toUpperCase()} ${r.rule} — ${r.detail}`);
    }
  }
  return {
    data: {
      command: "gate.probe",
      status: failed.length > 0 ? "failures" : "ok",
      probed: reports.length,
      reports,
    },
    summary: `${reports.length} probe(s): ${failed.length} failure(s)`,
    exitCode: failed.length > 0 ? 1 : 0,
  };
}
