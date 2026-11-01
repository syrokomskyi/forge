/*
<MODULE_CONTRACT>
<purpose>
RFC-1475 F11: shared append-only JSONL journal I/O for the trajectory
journals (outcomes.jsonl, recalls.jsonl). appendFile-only writes — never
read-modify-write; a truncated last line drops the partial record, never
the file (TRAJ-06). One-time lazy migration retires the YAML journals as
write targets: the first read that finds outcomes.yaml/recalls.yaml
appends their records into the matching JSONL (deduped), unparseable YAML
warns and skips — a partial JSONL is worse than none.
</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1475: apply review round-4 findings — frontmatter element guards, watermark type narrow, verdictRef workspace confinement, strict-boolean journal labels</item>
  <item>RFC-1475: apply review round-5 findings — shard units container guard, array-element migration convergence, confinement drop test</item>
  <item>RFC-1475: apply review round-6 residual — normalize non-string recalls keyOf for migration convergence</item>
  <item>RFC-1480: trajectory-memory residual debt — rebuild flag, recallId derivation, TRAJ-07, confinement</item>
  <item>RFC-1485: sweep compass headers — forge-os-trajectory</item>
  <history>RFC-1475</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { resolveIo } from "../../../src/utils/io.ts";
import type { WorkspaceIO } from "../../../src/types.ts";

export interface OutcomeRecord {
  recallId?: string;
  helped?: boolean;
  hurt?: boolean;
  note?: string;
  at?: string;
}

export interface RecallJournalRecord {
  id?: string;
  task?: string;
  unitsReturned?: string[];
  at?: string;
}

export interface JournalRead<T> {
  records: T[];
  /** Last JSONL line was truncated mid-write (TRAJ-06) — the partial record was dropped. */
  truncated: boolean;
  /** Human-readable warnings (unparseable YAML skipped, migrated record counts). */
  warnings: string[];
}

/** Absent-file errors are the only tolerable read failure — everything else propagates. */
export function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readFileOrNull(io: WorkspaceIO, absPath: string): Promise<string | null> {
  try {
    return await io.readFile(absPath);
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
}

/**
 * Append one JSON record as a single line — appendFile only, never rewrite.
 * An unterminated tail (crash mid-write) is quarantined with a newline first,
 * so the new record never glues onto the corrupt line and stays parseable.
 */
export async function appendJsonl(io: WorkspaceIO, absPath: string, record: unknown): Promise<void> {
  const tail = (await readFileOrNull(io, absPath)) ?? "";
  const separator = tail.length > 0 && !tail.endsWith("\n") ? "\n" : "";
  await io.appendFile(absPath, `${separator}${JSON.stringify(record)}\n`);
}

/** Read a JSONL journal, tolerating a crash-truncated tail (TRAJ-06). */
export async function readJsonl<T>(io: WorkspaceIO, absPath: string): Promise<JournalRead<T>> {
  const src = await readFileOrNull(io, absPath);
  if (src === null || src.trim() === "") return { records: [], truncated: false, warnings: [] };
  const lines = src.split("\n").filter((l) => l.trim().length > 0);
  const records: T[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      parsed = undefined;
    }
    // Only object records are admissible — a parseable scalar (null, 42) is a
    // malformed journal record and takes the same corrupt-line path.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      records.push(parsed as T);
    } else if (i === lines.length - 1) {
      truncated = true;
    }
    // Mid-file malformed lines are skipped silently — the journal survives.
  }
  return { records, truncated, warnings: [] };
}

const TRAJECTORY_DIR = path.join("docs", ".index", "trajectory");

/**
 * Normalize a journal record's `unitsReturned` — the journal is untrusted
 * input: non-array values, non-string elements, and duplicate ids would
 * throw or double-count at consumption. Returns a deduped string list.
 */
export function journalUnitIds(r: { unitsReturned?: unknown }): string[] {
  if (!Array.isArray(r.unitsReturned)) return [];
  return [...new Set(r.unitsReturned.filter((x): x is string => typeof x === "string"))];
}

/**
 * RFC-1480: derive the next recall sequence from the journal's own ids —
 * `R-<dayKey>-<seq>-<hash>` (third segment is the counter), not from
 * `records.length` (a dropped/migrated journal would collide). padStart(2)
 * overflow (`seq > 99`) grows naturally — uniqueness is what matters.
 */
export function nextRecallSeq(records: { id?: string }[]): number {
  let max = 0;
  for (const r of records) {
    const m = /^R-\d+-(\d+)-/.exec(typeof r.id === "string" ? r.id : "");
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max + 1;
}

/**
 * Read the outcomes journal: outcomes.jsonl plus a lazy one-time migration
 * from outcomes.yaml (deduped by {recallId, at}). The YAML stays on disk as
 * the read-only source until migrated; unparseable YAML warns + skips.
 */
export async function readOutcomesJournal(
  root: string,
  io?: WorkspaceIO,
): Promise<JournalRead<OutcomeRecord>> {
  const resolved = resolveIo(io);
  const jsonlPath = path.join(root, TRAJECTORY_DIR, "outcomes.jsonl");
  const yamlPath = path.join(root, TRAJECTORY_DIR, "outcomes.yaml");
  return readJournalWithYamlMigration<OutcomeRecord>(resolved, jsonlPath, yamlPath, "outcomes", (r) =>
    `${r.recallId ?? ""}|${r.at ?? ""}`,
  );
}

/**
 * Read the recalls journal: recalls.jsonl plus a lazy one-time migration
 * from recalls.yaml (deduped by id).
 */
export async function readRecallsJournal(
  root: string,
  io?: WorkspaceIO,
): Promise<JournalRead<RecallJournalRecord>> {
  const resolved = resolveIo(io);
  const jsonlPath = path.join(root, TRAJECTORY_DIR, "recalls.jsonl");
  const yamlPath = path.join(root, TRAJECTORY_DIR, "recalls.yaml");
  return readJournalWithYamlMigration<RecallJournalRecord>(resolved, jsonlPath, yamlPath, "recalls", (r) =>
    typeof r.id === "string" ? r.id : "",
  );
}

async function readJournalWithYamlMigration<T>(
  io: WorkspaceIO,
  jsonlPath: string,
  yamlPath: string,
  yamlKey: string,
  keyOf: (r: T) => string,
): Promise<JournalRead<T>> {
  const read = await readJsonl<T>(io, jsonlPath);
  let yamlSrc: string | null;
  try {
    yamlSrc = await io.readFile(yamlPath);
  } catch (e) {
    if (isEnoent(e)) return read;
    read.warnings.push(
      `trajectory journal migration skipped: ${path.basename(yamlPath)} is unreadable (${(e as Error).message}) — YAML left untouched`,
    );
    return read;
  }
  if (yamlSrc === null) return read;
  let yamlRecords: T[] = [];
  try {
    const parsed = yamlParse(yamlSrc) as Record<string, T[] | undefined> | null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      read.warnings.push(
        `trajectory journal migration skipped: ${path.basename(yamlPath)} has unexpected shape for a ${yamlKey} journal — YAML left untouched`,
      );
      return read;
    }
    const list = parsed[yamlKey];
    if (list === undefined) {
      read.warnings.push(
        `trajectory journal migration skipped: ${path.basename(yamlPath)} carries no ${yamlKey}: key — YAML left untouched`,
      );
      return read;
    }
    if (!Array.isArray(list)) {
      read.warnings.push(
        `trajectory journal migration skipped: ${path.basename(yamlPath)} ${yamlKey}: is not a record list — YAML left untouched`,
      );
      return read;
    }
    yamlRecords = list.filter((r): r is T => r !== null && typeof r === "object" && !Array.isArray(r));
  } catch {
    read.warnings.push(
      `trajectory journal migration skipped: ${path.basename(yamlPath)} is unparseable — YAML left untouched`,
    );
    return read;
  }
  const seen = new Set(read.records.map(keyOf));
  let appended = 0;
  for (const record of yamlRecords) {
    const key = keyOf(record);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendJsonl(io, jsonlPath, record);
    read.records.push(record);
    appended++;
  }
  if (appended > 0) {
    read.warnings.push(
      `trajectory journal migration: appended ${appended} record(s) from ${path.basename(yamlPath)} to ${path.basename(jsonlPath)}`,
    );
  }
  return read;
}
