/*
<MODULE_CONTRACT>
<purpose>friction.add command handler (RFC-1590) — the only write path
for friction records. Allocates the next F-NNNN id through the shared
governance-reservation surface (os/rfc/next-id.ts, kind: friction),
validates the record against the friction.validate rule set BEFORE any
file lands, and writes docs/frictions/F-NNNN.yaml. With --recurrence-of
it mutates no new id: the named record's recurrences counter increments
and lastSeen is set — per-record files only.</purpose>
<non-goals>
  <item>No rule-set evaluation beyond the record being written — the
  registry-level checks stay in friction.validate.</item>
  <item>No legacy-file writes — records still in LEGACY_FRICTION_FILE
  refuse with a friction.migrate hint (LegacyRecordMutationError).</item>
</non-goals>
<KEY_DECISIONS>
  <item>Flag vocabularies are checked before the id is reserved — an
  invalid record never consumes an id; a post-reservation schema failure
  burns the id as a harmless gap (RFC-1536 doctrine).</item>
  <item>The reservation is appended BEFORE the record file is written,
  so a concurrent friction.add in a sibling worktree sees the claim on
  its next-id scan (AC-2).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1590: friction.add — governance-reserved ids, write-time
  vocabulary gate (FRICTION-01..05 reuse), --recurrence-of counter path.</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

import { reserveNextGovernanceId } from "../../rfc/next-id.ts";
import { git } from "../../flow/git.ts";
import {
  LegacyRecordMutationError,
  frictionSourceMax,
  loadFrictionSources,
  updateFriction,
  writeFriction,
} from "../store.ts";
import {
  FRICTION_CATEGORIES,
  FRICTION_MEASURE_KINDS,
  FRICTION_STATUSES,
  frictionEntrySchema,
} from "../types.ts";
import type { FrictionEntry, FrictionMeasureKind, FrictionStatus } from "../types.ts";

export interface FrictionAddResult {
  command: "friction.add";
  status: "pass" | "fail";
  id: string | null;
  file: string | null;
  recurrenceOf: string | null;
  recurrences: number | null;
  warnings: string[];
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
  extra?: Partial<FrictionAddResult>,
): ForgeCommandResult<FrictionAddResult> {
  return {
    data: {
      command: "friction.add",
      status: "fail",
      id: null,
      file: null,
      recurrenceOf: null,
      recurrences: null,
      warnings: [],
      errors: [{ ruleId, severity: "error", message }],
      ...extra,
    },
    summary: `friction.add refused: ${ruleId} ${message}`,
    exitCode: 1,
  };
}

/** Session attribution default — the current branch name; detached or
 * non-git invocations record "manual". */
async function defaultSession(cwd: string): Promise<string> {
  try {
    const r = await git(cwd, fs, ["branch", "--show-current"]);
    const name = r.stdout.trim();
    if (r.exitCode === 0 && name.length > 0) return name;
  } catch {
    /* non-git cwd — manual attribution */
  }
  return "manual";
}

export async function runFrictionAdd(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionAddResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const today = new Date().toISOString().slice(0, 10)!;

  // ── --recurrence-of: counter path, no new id ─────────────────────────
  const recurrenceOf = flag(input, "recurrence-of");
  if (recurrenceOf !== undefined) {
    let file: string;
    let recurrences = 0;
    try {
      file = await updateFriction(
        workspaceRoot,
        recurrenceOf,
        (record) => {
          recurrences = record.recurrences + 1;
          return { ...record, recurrences, lastSeen: today };
        },
        fs,
      );
    } catch (e) {
      if (e instanceof LegacyRecordMutationError) {
        return refuse(
          "FRICTION-ADD-02",
          `${e.message} — the record still lives in the unmigrated registry`,
        );
      }
      return refuse("FRICTION-ADD-01", e instanceof Error ? e.message : String(e));
    }
    const data: FrictionAddResult = {
      command: "friction.add",
      status: "pass",
      id: recurrenceOf,
      file,
      recurrenceOf,
      recurrences,
      warnings: [],
      errors: [],
    };
    if (outputFormat === "pretty") {
      logger.info(`  ${recurrenceOf}: recurrences → ${recurrences} (${file})`);
    }
    return {
      data,
      summary: `friction.add: ${recurrenceOf} recurrence ${recurrences}`,
      exitCode: 0,
    };
  }

  // ── new record: vocabulary gate BEFORE the id is reserved ────────────
  const category = flag(input, "category");
  const signature = flag(input, "signature");
  const friction = flag(input, "friction");
  const measure = flag(input, "measure");
  const measureKind = flag(input, "measure-kind");
  const status = flag(input, "status") ?? "open";
  const artifactsRaw = flag(input, "artifacts");
  const artifacts =
    artifactsRaw === undefined
      ? []
      : artifactsRaw
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);

  if (category === undefined || !FRICTION_CATEGORIES.includes(category as never)) {
    return refuse(
      "FRICTION-02",
      `category "${category ?? ""}" is outside the closed catalog (${FRICTION_CATEGORIES.join(", ")})`,
    );
  }
  if (friction === undefined) {
    return refuse("FRICTION-01", "--friction is required");
  }
  if (signature === undefined || signature.trim().length === 0) {
    return refuse(
      "FRICTION-05",
      "--signature is required and must be non-empty — recurrence matching cannot find an entry without it",
    );
  }
  if (measure === undefined) {
    return refuse("FRICTION-01", "--measure is required");
  }
  if (measureKind !== undefined && !FRICTION_MEASURE_KINDS.includes(measureKind as never)) {
    return refuse(
      "FRICTION-01",
      `measure-kind "${measureKind}" is outside the closed catalog (${FRICTION_MEASURE_KINDS.join(", ")})`,
    );
  }
  if (!FRICTION_STATUSES.includes(status as never)) {
    return refuse(
      "FRICTION-03",
      `status "${status}" is outside the closed catalog (${FRICTION_STATUSES.join(", ")})`,
    );
  }

  // ── reserve the id on the shared surface — allocate+append under one
  // lock so two concurrent adds can never pick the same id (AC-2).
  const sources = await loadFrictionSources(workspaceRoot, fs);
  const worktreeMax = frictionSourceMax(sources);
  const session = flag(input, "session") ?? (await defaultSession(workspaceRoot));
  const allocation = await reserveNextGovernanceId(
    fs,
    workspaceRoot,
    "friction",
    worktreeMax,
    session,
  );
  const id = `F-${String(allocation.id).padStart(4, "0")}`;

  const record: FrictionEntry = {
    id,
    created: today,
    session,
    category: category as FrictionEntry["category"],
    friction,
    signature,
    measure,
    ...(measureKind !== undefined ? { measureKind: measureKind as FrictionMeasureKind } : {}),
    artifacts,
    status: status as FrictionStatus,
    recurrences: 0,
    lastSeen: today,
  };
  const parsed = frictionEntrySchema.safeParse(record);
  if (!parsed.success) {
    // Should be unreachable — the vocabulary gate ran before reservation.
    return refuse(
      "FRICTION-01",
      `assembled record failed the entry schema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      { id },
    );
  }

  let file: string;
  try {
    file = await writeFriction(workspaceRoot, record, fs);
  } catch (e) {
    return refuse("FRICTION-01", e instanceof Error ? e.message : String(e), { id });
  }

  const warnings = [...allocation.warnings];
  if (outputFormat === "pretty") {
    logger.info(`  ${id} → ${file} (${record.category}, session ${session})`);
    for (const w of warnings) logger.warn(`  ${w}`);
  }
  return {
    data: {
      command: "friction.add",
      status: "pass",
      id,
      file,
      recurrenceOf: null,
      recurrences: 0,
      warnings,
      errors: [],
    },
    summary: `friction.add: ${id} written to ${file}`,
    exitCode: 0,
  };
}
