/*
<MODULE_CONTRACT>
<purpose>
RFC-1469: gate.probe — materialize a declared violation fixture in a temp
workspace, invoke the bound check, compare the expect block. Proves a gate
still fires on its seeded violation (liveness), vs silently passing.
mutatesState: false for the repo — fixture files land under tmpdir only.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate.probe fixture-driven liveness runner</item>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
  <item>RFC-1469: run probe checks inside the scratch workspace — context.invoke ran against the kernel root where fixture files don't exist</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ProbeFixture {
  rule: string;
  contract: string;
  derivedFrom?: string;
  spec: { files?: Record<string, string>; from?: string };
  expect: { rule: string; command?: string; minDiagnostics?: number; pathPattern?: string };
}

export interface ProbeReport {
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

async function collectFixtures(root: string, io: ReturnType<typeof resolveIo>): Promise<{ path: string; fixture: ProbeFixture }[]> {
  const out: { path: string; fixture: ProbeFixture }[] = [];
  const base = path.join(root, "docs", "gate-probes");
  const contracts = await io.readdir(base).catch(() => [] as { name: string; isDirectory: boolean }[]);
  for (const c of contracts) {
    if (!c.isDirectory || c.name.startsWith("_")) continue;
    const cdir = path.join(base, c.name);
    for (const r of await io.readdir(cdir).catch(() => [] as { name: string; isDirectory: boolean }[])) {
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

  const reports: ProbeReport[] = [];
  for (const { path: fp, fixture } of selected) {
    const scratch = path.join(tmpdir(), `gate-probe-${fixture.rule.replace(/[^a-z0-9-]/gi, "_")}-${Date.now()}`);
    try {
      // Materialize the fixture files under the temp workspace — the seeded
      // violation must be inside the check's real scan path.
      for (const [rel, content] of Object.entries(fixture.spec.files ?? {})) {
        const abs = path.join(scratch, rel);
        await io.mkdir(path.dirname(abs));
        await io.writeFile(abs, content);
      }
      // Minimal forge.yaml so the check's workspace resolver finds a root.
      await io.writeFile(path.join(scratch, "forge.yaml"), "schema: forge/config@1\n");
      // The check runs in the scratch workspace via the kernel — the probe
      // contract is "the check fires its rule on the seeded violation".
      const checkCmd = fixture.expect.command ?? fixture.expect.rule.split(":")[0] ?? fixture.rule;
      const res = await io.exec?.(
        "pnpm",
        ["exec", "werkstatt", "run", checkCmd, "--json"],
        { cwd: scratch, timeoutMs: 60_000 },
      );
      if (!res) throw new Error("io.exec absent — cannot run checks inside the scratch workspace");
      let diagnostics = 0;
      try {
        const parsed = JSON.parse(res.stdout) as { data?: { diagnostics?: unknown[] } };
        diagnostics = (parsed.data?.diagnostics ?? []).length;
      } catch { /* non-JSON output — diagnostics stays 0 */ }
      const ruleFired = (res.exitCode ?? 1) !== 0 && diagnostics >= (fixture.expect.minDiagnostics ?? 1);
      reports.push({
        fixture: fp,
        rule: fixture.rule,
        status: ruleFired ? "pass" : "fail",
        diagnostics,
        detail: ruleFired
          ? `check fired ${diagnostics} diagnostic(s) on the seeded violation`
          : `check did not fire ${fixture.rule} on the seeded violation (exit ${res.exitCode}, ${diagnostics} diagnostics) — gate is dead`,
      });
    } catch (err) {
      reports.push({
        fixture: fp,
        rule: fixture.rule,
        status: "error",
        diagnostics: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
