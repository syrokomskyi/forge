/*
<MODULE_CONTRACT>
<purpose>queue.decision command handler (RFC-1601) — the decision-ledger
writer. Appends one schema-validated entry to the manifest's sibling
docs/queues/<stem>.decisions.yaml, stamping the ledger's createdAt on
first write and the entry's answeredAt when the status is terminal-ish
(answered/auto-resolved). Agents stop hand-editing the ledger; the schema
stays the single shape. Refusals: QUEUE-01 unreadable manifest/ledger,
QUEUE-05 duplicate decision id (names the next free id), QUEUE-DEC-01
input/schema violations (message carries the minimal satisfying
shape).</purpose>
<non-goals>
  <item>Do not validate the queue — queue.validate owns the ledger's
  cross-checks; this command only writes well-formed entries.</item>
  <item>Do not update existing entries — append-only; a wrong entry is
  superseded by a new one.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1601: ledger writers assign rather than append — queue.decision
  stamps createdAt/answeredAt and schema-gates the write.</item>
  <item>RFC-1601: ledger writers assign + refusals teach the violated rule (RFC-1601)

FRICTION-11 flags any out-of-vocabulary friction field value at validate, naming field+value+closed set — the mechanical detector for hand-edit corruption (F-0206/F-0244). queue.decision is the new decision-ledger writer: schema-gated append stamping createdAt/answeredAt, next-free Q-id default, QUEUE-05/QUEUE-DEC-01 refusals carrying the minimal shape. ecosystem.commit --rfc/--adr normalize bare digits or refuse EC-35 with the format statement — the F-0248 silent-injection-skip class is closed, and a summary-record failure now names the id + skipped injection. RFC-IMP-10 refusal leads with the rule statement; pipeline conventions and guides point at the command write path.</item>
  <history>RFC-1601</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { decisionLedgerPath, loadDecisionLedger, loadQueueManifest } from "../manifest.ts";
import { DECISION_STATUS, decisionEntrySchema, decisionLedgerSchema } from "../types.ts";
import type { DecisionEntry, DecisionLedger } from "../types.ts";

const ENTRY_STAGES = ["idea", "audit", "enhance", "plan", "implement", "review"] as const;
const RESOLUTION_PATHS = ["codebase", "convention", "profile", "policy", "none"] as const;

export interface QueueDecisionResult {
  command: "queue.decision";
  status: "pass" | "fail";
  ledger: string | null;
  id: string | null;
  errors: Diagnostic[];
}

function flag(input: ForgeCommandInput, name: string): string | undefined {
  const v = input.flags[name];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function refuse(
  ruleId: string,
  message: string,
  ledger?: string,
): ForgeCommandResult<QueueDecisionResult> {
  return {
    data: {
      command: "queue.decision",
      status: "fail",
      ledger: ledger ?? null,
      id: null,
      errors: [{ ruleId, severity: "error", message }],
    },
    summary: `queue.decision refused: ${ruleId} ${message}`,
    exitCode: 1,
  };
}

/** Next free Q-id — max numeric suffix + 1, mirroring queue.validate's read-time rule (RFC-1534). */
function nextFreeId(items: ReadonlyArray<{ id: string }>): string {
  let max = 0;
  for (const item of items) {
    const m = item.id.match(/^Q-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `Q-${max + 1}`;
}

export async function runQueueDecision(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<QueueDecisionResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const today = new Date().toISOString().slice(0, 10)!;

  const file = flag(input, "file");
  if (file === undefined) {
    return refuse(
      "QUEUE-DEC-01",
      "--file <manifest> is required — the ledger is the manifest's sibling <stem>.decisions.yaml",
    );
  }

  // The writer needs the manifest for the ledger binding (queue field) and
  // refuses to write against a manifest that itself fails to load.
  const manifestLoad = await loadQueueManifest(workspaceRoot, file);
  if (manifestLoad.errors.length > 0) {
    return refuse(
      "QUEUE-01",
      `manifest failed to load — fix it before writing decisions: ${manifestLoad.errors[0]!.message}`,
    );
  }
  const manifest = manifestLoad.manifest;

  const ledgerPath = decisionLedgerPath(file);
  const ledgerAbs = path.isAbsolute(ledgerPath) ? ledgerPath : path.join(workspaceRoot, ledgerPath);
  const ledgerRel = path.isAbsolute(ledgerPath)
    ? path.relative(workspaceRoot, ledgerPath)
    : ledgerPath;

  const ledgerLoad = await loadDecisionLedger(workspaceRoot, file, manifest);
  if (ledgerLoad.errors.length > 0) {
    return refuse(
      "QUEUE-01",
      `decision ledger failed to load — refusing to append to a broken ledger: ${ledgerLoad.errors[0]!.message}`,
      ledgerRel,
    );
  }

  // Absent ledger → fresh skeleton with the binding fields stamped.
  const ledgerStem = path.basename(ledgerAbs).replace(/\.(ya?ml)$/i, "");
  const ledger: DecisionLedger =
    ledgerLoad.ledger ??
    decisionLedgerSchema.parse({
      id: ledgerStem,
      queue: manifest.id,
      createdAt: today,
      items: [],
    });

  // ── build the entry — --entry-file carries the full object (options
  // passthrough); flags build the minimal entry ────────────────────────
  const entryFile = flag(input, "entry-file");
  let rawEntry: Record<string, unknown>;
  if (entryFile !== undefined) {
    const entryAbs = path.isAbsolute(entryFile) ? entryFile : path.join(workspaceRoot, entryFile);
    let source: string;
    try {
      source = await fs.readFile(entryAbs);
    } catch (e) {
      return refuse(
        "QUEUE-DEC-01",
        `cannot read --entry-file: ${e instanceof Error ? e.message : String(e)}`,
        ledgerRel,
      );
    }
    try {
      const parsed: unknown = entryFile.endsWith(".json") ? JSON.parse(source) : yamlParse(source);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return refuse(
          "QUEUE-DEC-01",
          "--entry-file must hold a single decision entry object — entry shape: {id: Q-N, doc: RFC-NNNN|ADR-NNNN, stage, question, resolutionPath, options[], status, answer?}",
          ledgerRel,
        );
      }
      rawEntry = parsed as Record<string, unknown>;
    } catch (e) {
      return refuse(
        "QUEUE-DEC-01",
        `--entry-file parse error: ${e instanceof Error ? e.message : String(e)}`,
        ledgerRel,
      );
    }
  } else {
    const status = flag(input, "status");
    if (status !== undefined && !DECISION_STATUS.includes(status as never)) {
      return refuse(
        "QUEUE-DEC-01",
        `--status "${status}" is outside the closed vocabulary (${DECISION_STATUS.join("|")})`,
        ledgerRel,
      );
    }
    rawEntry = {
      id: flag(input, "id") ?? nextFreeId(ledger.items),
      doc: flag(input, "doc"),
      stage: flag(input, "stage"),
      question: flag(input, "question"),
      resolutionPath: flag(input, "resolution-path") ?? "none",
      options: [],
      status: status ?? "open",
      ...(flag(input, "answer") !== undefined ? { answer: flag(input, "answer") } : {}),
    };
  }

  // ── stamps — the writer owns its timestamps; an explicit value passes
  // through (schema still gates it) ─────────────────────────────────────
  const status = rawEntry["status"];
  if (
    (status === "answered" || status === "auto-resolved") &&
    rawEntry["answeredAt"] === undefined
  ) {
    rawEntry["answeredAt"] = today;
  }

  const entryParsed = decisionEntrySchema.safeParse(rawEntry);
  if (!entryParsed.success) {
    const first = entryParsed.error.issues[0];
    return refuse(
      "QUEUE-DEC-01",
      `entry failed the decision-ledger schema at ${first?.path.join(".") || "<root>"}: ${first?.message} — entry shape: {id: Q-N, doc: RFC-NNNN|ADR-NNNN, stage: ${ENTRY_STAGES.join("|")}, question, resolutionPath: ${RESOLUTION_PATHS.join("|")}, options[], status: ${DECISION_STATUS.join("|")}, answer?, answeredAt?, parked?}`,
      ledgerRel,
    );
  }
  const entry: DecisionEntry = entryParsed.data;

  if (ledger.items.some((item) => item.id === entry.id)) {
    return refuse(
      "QUEUE-05",
      `duplicate decision id "${entry.id}" — collides with an earlier entry; next free id: ${nextFreeId(ledger.items)}`,
      ledgerRel,
    );
  }

  const next = { ...ledger, items: [...ledger.items, entry] };
  const ledgerParsed = decisionLedgerSchema.safeParse(next);
  if (!ledgerParsed.success) {
    const first = ledgerParsed.error.issues[0];
    return refuse(
      "QUEUE-DEC-01",
      `ledger failed its schema after append at ${first?.path.join(".") || "<root>"}: ${first?.message} — nothing written`,
      ledgerRel,
    );
  }

  await fs.writeFile(ledgerAbs, yamlStringify(ledgerParsed.data));

  const data: QueueDecisionResult = {
    command: "queue.decision",
    status: "pass",
    ledger: ledgerRel,
    id: entry.id,
    errors: [],
  };
  if (outputFormat === "pretty") {
    logger.info(`  ${entry.id} → ${ledgerRel} (${entry.status})`);
  }
  return {
    data,
    summary: `queue.decision: ${entry.id} appended to ${ledgerRel}`,
    exitCode: 0,
  };
}
