/*
<MODULE_CONTRACT>
<purpose>RFC-1568 — `gate.run.status` handler: reports gate-run records from
  `<git common dir>/forge/gate-runs/`. Selection: --id (one), --last
  (newest, optional --command filter), default (10 newest). --wait polls up
  to N seconds (max 600) until the run is no longer running. The command
  exits 0 whenever records are readable — a gate's own outcome lives in
  `data.runs[].status`, never in this command's exit code (DNA-106).</purpose>
<non-goals>
  <item>No run lifecycle mutation — records are written by the runner.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 4 — gate.run.status handler</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
  <item>RFC-1562: rfc-1562 acceptance evidence, regenerated manifests, gate contract tag</item>
  <item>RFC-1575: gate.run.status uncacheable, --wait ends with a verdict

cacheable: false keeps live gate-run state out of the kernel result cache; --id --wait returns data.wait {requestedSeconds, waitedMs, outcome: completed|budget-expired} and a summary suffix. CMD-MAN-06 dropped after its live census (~100 warnings, no true positive): falsified route in the plan, ledger Q-8.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import { resolveIo } from "../../src/utils/io.ts";
import { commonGitDir } from "../flow/registry.ts";
import { classifyGateRun, listGateRuns } from "./record.ts";
import type { GateRunRecord, GateRunStatus } from "./types.ts";

const WAIT_MAX_SECONDS = 600;
const WAIT_POLL_MS = 2_000;

/** RFC-1575: terminal verdict of a `--wait` — whether the run left `running` or the budget ran out. */
export interface GateRunWaitVerdict {
  requestedSeconds: number;
  waitedMs: number;
  /** completed: the run left `running` during or before the wait; budget-expired: still running at the deadline */
  outcome: "completed" | "budget-expired";
}

export interface GateRunStatusData {
  runs: Array<GateRunRecord & { status: GateRunStatus }>;
  /** RFC-1575: present only for `--id` with `--wait` > 0. */
  wait?: GateRunWaitVerdict;
}

/** RFC-1575 FI-1 — summary suffix when the wait budget expires. */
export const WAIT_EXPIRED_SUFFIX = "wait budget expired, still running";

function flag(input: ForgeCommandInput, name: string): string | undefined {
  const v = input.flags[name];
  return typeof v === "string" ? v : undefined;
}

function boolFlag(input: ForgeCommandInput, name: string): boolean {
  return input.flags[name] === true;
}

function withClassified(record: GateRunRecord): GateRunRecord & { status: GateRunStatus } {
  return { ...record, status: classifyGateRun(record) };
}

function formatRunLine(record: GateRunRecord & { status: GateRunStatus }): string {
  const bits: string[] = [record.status];
  if (record.exitCode !== undefined) bits.push(`exit ${record.exitCode}`);
  bits.push(record.startedAt);
  if (record.endedAt) bits.push(`→ ${record.endedAt}`);
  return `[gate-run] ${record.runId}  ${record.command}  ${bits.join("  ")}`;
}

export async function runGateRunStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<GateRunStatusData>> {
  const io = resolveIo(context.io);
  const root = context.forgeRoot ?? context.workspaceRoot;
  let common: string;
  try {
    common = await commonGitDir(io, root);
  } catch (error) {
    return {
      exitCode: 1,
      summary: `[gate.run.status] cannot resolve the git common dir: ${(error as Error).message}`,
      data: { runs: [] },
    };
  }

  const id = flag(input, "id");
  const command = flag(input, "command");
  const last = boolFlag(input, "last");
  const waitRaw = flag(input, "wait");
  const waitSeconds = waitRaw === undefined ? 0 : Math.min(Number(waitRaw) || 0, WAIT_MAX_SECONDS);

  if (id !== undefined) {
    const waitStarted = Date.now();
    const deadline = waitStarted + waitSeconds * 1_000;
    for (;;) {
      const all = await listGateRuns(common, io);
      const found = all.find((r) => r.runId === id);
      if (found === undefined) {
        return {
          exitCode: 1,
          summary: `[gate.run.status] GATE-RUN-03 unknown run id ${id}`,
          data: { runs: [] },
          nextSteps: [
            { action: "gate.run.status --last — inspect the most recent run", kind: "optional" },
          ],
        };
      }
      const classified = withClassified(found);
      if (classified.status !== "running" || Date.now() >= deadline) {
        if (waitSeconds <= 0) {
          return { exitCode: 0, summary: formatRunLine(classified), data: { runs: [classified] } };
        }
        const waitedMs = Date.now() - waitStarted;
        const wait: GateRunWaitVerdict = {
          requestedSeconds: waitSeconds,
          waitedMs,
          outcome: classified.status === "running" ? "budget-expired" : "completed",
        };
        const suffix =
          wait.outcome === "budget-expired"
            ? ` — ${WAIT_EXPIRED_SUFFIX} (${waitSeconds} s)`
            : ` — left running after ${Math.round(waitedMs / 1000)} s`;
        return {
          exitCode: 0,
          summary: formatRunLine(classified) + suffix,
          data: { runs: [classified], wait },
        };
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(WAIT_POLL_MS, Math.max(50, deadline - Date.now()))),
      );
    }
  }

  if (last) {
    const all = await listGateRuns(common, io, { command, limit: 1 });
    const runs = all.map(withClassified);
    return {
      exitCode: 0,
      summary:
        runs.length === 0
          ? `[gate.run.status] no gate runs recorded${command ? ` for ${command}` : ""}`
          : formatRunLine(runs[0]!),
      data: { runs },
    };
  }

  const all = await listGateRuns(common, io, { command, limit: 10 });
  const runs = all.map(withClassified);
  return {
    exitCode: 0,
    summary:
      runs.length === 0
        ? `[gate.run.status] no gate runs recorded${command ? ` for ${command}` : ""}`
        : `[gate.run.status] ${runs.length} recent run(s):\n${runs.map(formatRunLine).join("\n")}`,
    data: { runs },
  };
}

export const gateRunStatusCommand = {
  name: "gate.run.status",
  description:
    "Report durable gate-run records written by detachable commands " +
    "(RFC-1568). `--id` one run, `--last` the most recent (optionally " +
    "filtered by `--command`), default the 10 newest; `--wait <s>` blocks " +
    "up to 600 s until the run leaves `running`. Classifies unfinished runs " +
    "as `lost` via the same dead-holder liveness rule as flow locks. Exits " +
    "0 whenever records are readable — the gate's outcome lives in " +
    "`data.runs[].status`, never in this command's exit code (DNA-106).",
  scope: "workspace" as const,
  contract: "gate",
  rules: [
    { id: "GATE-RUN-01", severity: "error" as const },
    { id: "GATE-RUN-02", severity: "error" as const },
    { id: "GATE-RUN-03", severity: "error" as const },
  ],
  mutatesState: false,
  execOnReadOnly: true,
  // RFC-1575: live process state — never served from the kernel result cache
  // (the records live under the git common dir, outside any cache digest).
  cacheable: false,
  reads: ["forge/gate-runs/**"],
  flags: {
    id: { kind: "string" as const, description: "One run id." },
    last: {
      kind: "boolean" as const,
      description: "Most recent run (optionally filtered by --command).",
    },
    command: { kind: "string" as const, description: "Filter by command name." },
    wait: {
      kind: "string" as const,
      description: "Block up to N seconds (max 600) until the run is no longer running.",
    },
  },
  execute: runGateRunStatus,
};
