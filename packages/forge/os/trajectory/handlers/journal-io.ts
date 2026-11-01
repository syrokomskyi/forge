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
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1475: appendJsonl/readJsonl + lazy YAML→JSONL migration for the trajectory journals</item>
  <item>RFC-1475: trajectory hardening — verdict-artifact binding, per-producer trust, TRAJ-02 staleness, JSONL journals</item>
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

/**
 * Append one JSON record as a single line — appendFile only, never rewrite.
 * An unterminated tail (crash mid-write) is quarantined with a newline first,
 * so the new record never glues onto the corrupt line and stays parseable.
 */
export async function appendJsonl(io: WorkspaceIO, absPath: string, record: unknown): Promise<void> {
  const tail = await io.readFile(absPath).catch(() => "");
  const separator = tail.length > 0 && !tail.endsWith("\n") ? "\n" : "";
  await io.appendFile(absPath, `${separator}${JSON.stringify(record)}\n`);
}

/** Read a JSONL journal, tolerating a crash-truncated tail (TRAJ-06). */
export async function readJsonl<T>(io: WorkspaceIO, absPath: string): Promise<JournalRead<T>> {
  const src = await io.readFile(absPath).catch(() => null);
  if (src === null || src.trim() === "") return { records: [], truncated: false, warnings: [] };
  const lines = src.split("\n").filter((l) => l.trim().length > 0);
  const records: T[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T);
    } catch {
      if (i === lines.length - 1) truncated = true;
      // Mid-file malformed lines are skipped silently — the journal survives.
    }
  }
  return { records, truncated, warnings: [] };
}

const TRAJECTORY_DIR = path.join("docs", ".index", "trajectory");

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
    r.id ?? "",
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
  const yamlSrc = await io.readFile(yamlPath).catch(() => null);
  if (yamlSrc === null) return read;
  let yamlRecords: T[] = [];
  try {
    yamlRecords = ((yamlParse(yamlSrc) as Record<string, T[] | undefined> | null)?.[yamlKey] ?? []).filter(
      (r): r is T => r !== null && typeof r === "object",
    );
  } catch {
    read.warnings.push(
      `trajectory journal migration skipped: ${path.basename(yamlPath)} is unparseable — YAML left untouched`,
    );
    return read;
  }
  const seen = new Set(read.records.map(keyOf));
  const toAppend = yamlRecords.filter((r) => !seen.has(keyOf(r)));
  for (const record of toAppend) {
    await appendJsonl(io, jsonlPath, record);
    read.records.push(record);
  }
  if (toAppend.length > 0) {
    read.warnings.push(
      `trajectory journal migration: appended ${toAppend.length} record(s) from ${path.basename(yamlPath)} to ${path.basename(jsonlPath)}`,
    );
  }
  return read;
}
