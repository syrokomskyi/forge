/*
<MODULE_CONTRACT>
<purpose>RFC-1590: the single store for friction records. One file per
record under docs/frictions/F-NNNN.yaml; the legacy single-file registry
(LEGACY_FRICTION_FILE) is read until friction.migrate removes it and is
never written by commands. Every reader and writer of the friction
registry goes through this module.</purpose>
<non-goals>
  <item>No rule-set validation — friction.validate owns FRICTION-01..10;
  the store only parses, orders, and persists.</item>
  <item>No id allocation — os/rfc/next-id.ts owns the shared governance-id
  reservation surface (kind: friction).</item>
</non-goals>
<KEY_DECISIONS>
  <item>The loader reads the directory first, then the legacy file; a
  duplicate id across both throws FrictionDuplicateError (the AC-4
  contract — FRICTION-09 maps it), while loadFrictionsTolerant keeps the
  per-record copy so best-effort readers never see an empty registry.</item>
  <item>updateFriction operates on per-record files only — a
  legacy-resident record refuses with a friction.migrate hint rather than
  writing the legacy file (the rollout contract: never written by
  commands).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1590: per-record friction store — docs/frictions/F-NNNN.yaml
  layout, legacy-fallback loader, duplicate-id error, writeFriction and
  updateFriction mutation surface.</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type { WorkspaceIO } from "../../src/types.ts";

import type { FrictionEntry } from "./types.ts";

export const FRICTION_DIR = "docs/frictions";
export const LEGACY_FRICTION_FILE = "docs/frictions.yaml";

/** `F-NNNN.yaml` file-name shape (prefix match — suffixes stay legal). */
export const FRICTION_FILE_PATTERN = /^F-(\d{4})/;

/** One record as loaded, with provenance — the full-fidelity shape the
 * validator needs (schema fidelity is friction.validate's job, not the
 * store's). */
export interface FrictionSourceRecord {
  /** The record's own `id` field when readable. */
  id: string | null;
  /** Filename-derived id for directory records (null for legacy rows). */
  fileId: string | null;
  /** Parsed yaml content (unknown shape — the validator checks it). */
  raw: unknown;
  /** Set when the file/row could not be parsed at all. */
  parseError?: string;
  source: "dir" | "legacy";
  /** Repo-relative file path (dir records only). */
  file?: string;
}

export interface FrictionSources {
  dir: FrictionSourceRecord[];
  legacy: FrictionSourceRecord[];
  /** The legacy file exists (regardless of whether it holds records). */
  legacyPresent: boolean;
}

/** Thrown by loadFrictions when an id appears in both stores — the
 * validator maps it to FRICTION-09. */
export class FrictionDuplicateError extends Error {
  readonly duplicates: string[];
  constructor(duplicates: string[]) {
    super(
      `duplicate friction id(s) across ${FRICTION_DIR}/ and ${LEGACY_FRICTION_FILE}: ${duplicates.join(", ")}`,
    );
    this.name = "FrictionDuplicateError";
    this.duplicates = duplicates;
  }
}

/** Thrown when a mutation targets a record that still lives in the
 * legacy file — commands never write the legacy file. */
export class LegacyRecordMutationError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`friction record ${id} lives in the legacy registry — run friction.migrate first`);
    this.name = "LegacyRecordMutationError";
    this.id = id;
  }
}

function fileIdOf(name: string): string | null {
  const m = name.match(FRICTION_FILE_PATTERN);
  return m ? `F-${m[1]}` : null;
}

function recordIdOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Read both storage surfaces at full fidelity — the validator's input. */
export async function loadFrictionSources(root: string, io: WorkspaceIO): Promise<FrictionSources> {
  const dir: FrictionSourceRecord[] = [];
  const dirPath = join(root, FRICTION_DIR);
  if (await io.exists(dirPath)) {
    for (const entry of await io.readdir(dirPath)) {
      if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
      const file = join(FRICTION_DIR, entry.name);
      const abs = join(root, file);
      let raw: unknown;
      let parseError: string | undefined;
      try {
        raw = yamlParse(await io.readFile(abs));
      } catch (e) {
        raw = undefined;
        parseError = e instanceof Error ? e.message : String(e);
      }
      dir.push({
        id: recordIdOf(raw),
        fileId: fileIdOf(entry.name),
        raw,
        ...(parseError !== undefined ? { parseError } : {}),
        source: "dir",
        file,
      });
    }
  }

  const legacy: FrictionSourceRecord[] = [];
  const legacyPath = join(root, LEGACY_FRICTION_FILE);
  const legacyPresent = await io.exists(legacyPath);
  if (legacyPresent) {
    let raw: unknown;
    let legacyParseError: string | undefined;
    try {
      raw = yamlParse(await io.readFile(legacyPath));
    } catch (e) {
      raw = undefined;
      legacyParseError = e instanceof Error ? e.message : String(e);
    }
    if (legacyParseError !== undefined) {
      legacy.push({
        id: null,
        fileId: null,
        raw: undefined,
        parseError: legacyParseError,
        source: "legacy",
      });
    } else {
      // An empty document (null) is zero records, not a shape failure —
      // the lazy-creation contract treats absent content as empty.
      const rows =
        raw === null || raw === undefined
          ? []
          : Array.isArray(raw)
            ? raw
            : (raw as { frictions?: unknown[] } | null)?.frictions;
      if (!Array.isArray(rows)) {
        legacy.push({
          id: null,
          fileId: null,
          raw: undefined,
          parseError: `top level of ${LEGACY_FRICTION_FILE} is not a record list`,
          source: "legacy",
        });
      } else {
        for (const row of rows as unknown[]) {
          legacy.push({
            id: recordIdOf(row),
            fileId: null,
            raw: row,
            source: "legacy",
          });
        }
      }
    }
  }

  return { dir, legacy, legacyPresent };
}

function effectiveId(rec: FrictionSourceRecord): string | null {
  return rec.id ?? rec.fileId;
}

/** Highest numeric id across every loaded record (dir + legacy) — the
 * caller's worktree-side bound for governance-id allocation. */
export function frictionSourceMax(sources: FrictionSources): number {
  let max = 0;
  for (const rec of [...sources.dir, ...sources.legacy]) {
    const id = effectiveId(rec);
    const m = id?.match(/^F-(\d{4})$/);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

/** Duplicate ids across the two stores (the AC-4 / FRICTION-09 case). */
export function crossStoreDuplicates(sources: FrictionSources): string[] {
  const dirIds = new Set(sources.dir.map(effectiveId).filter((x): x is string => x !== null));
  const dups = new Set<string>();
  for (const rec of sources.legacy) {
    const id = effectiveId(rec);
    if (id !== null && dirIds.has(id)) dups.add(id);
  }
  return [...dups].sort();
}

/** All records sorted by id — RFC-1590's reader contract. Directory
 * records win on a duplicate id (they are canonical post-migration); a
 * duplicate across stores throws FrictionDuplicateError — callers that
 * prefer the merged set over a hard failure use loadFrictionsTolerant. */
export async function loadFrictions(root: string, io: WorkspaceIO): Promise<FrictionEntry[]> {
  const sources = await loadFrictionSources(root, io);
  const dups = crossStoreDuplicates(sources);
  if (dups.length > 0) throw new FrictionDuplicateError(dups);
  return mergeRecords(sources);
}

/** Duplicate-tolerant load for best-effort readers — same merged order,
 * dir records win, duplicates reported rather than thrown. */
export async function loadFrictionsTolerant(
  root: string,
  io: WorkspaceIO,
): Promise<{ records: FrictionEntry[]; duplicates: string[]; sources: FrictionSources }> {
  const sources = await loadFrictionSources(root, io);
  const duplicates = crossStoreDuplicates(sources);
  return { records: mergeRecords(sources), duplicates, sources };
}

function mergeRecords(sources: FrictionSources): FrictionEntry[] {
  const drop = new Set(crossStoreDuplicates(sources));
  const all = [...sources.dir, ...sources.legacy.filter((r) => !drop.has(effectiveId(r) ?? ""))];
  const withId = all.filter((r) => effectiveId(r) !== null && r.raw !== undefined);
  withId.sort((a, b) => (effectiveId(a) ?? "").localeCompare(effectiveId(b) ?? ""));
  return withId.map((r) => r.raw as FrictionEntry);
}

/** Serialize a record into its per-record file — returns the
 * repo-relative path. Idempotent: an identical existing file is left
 * alone; a different one is a hard collision (never silently clobbered). */
export async function writeFriction(
  root: string,
  record: FrictionEntry,
  io: WorkspaceIO,
): Promise<string> {
  const file = join(FRICTION_DIR, `${record.id}.yaml`);
  const abs = join(root, file);
  const body = yamlStringify(record);
  if (await io.exists(abs)) {
    const existing = await io.readFile(abs);
    if (existing !== body) {
      throw new Error(
        `friction record file ${file} already exists with different content — resolve the collision manually`,
      );
    }
    return file;
  }
  await io.mkdir(join(root, FRICTION_DIR));
  await io.writeFile(abs, body);
  return file;
}

/** Mutate a per-record file in place — the --recurrence-of / scar.migrate
 * update path. Throws LegacyRecordMutationError when the id resolves to
 * the legacy file only; Error when the id is unknown altogether. */
export async function updateFriction(
  root: string,
  id: string,
  mutate: (record: FrictionEntry) => FrictionEntry,
  io: WorkspaceIO,
): Promise<string> {
  const file = join(FRICTION_DIR, `${id}.yaml`);
  const abs = join(root, file);
  if (!(await io.exists(abs))) {
    const sources = await loadFrictionSources(root, io);
    const inLegacy = sources.legacy.some((r) => effectiveId(r) === id);
    if (inLegacy) throw new LegacyRecordMutationError(id);
    throw new Error(`friction record ${id} not found`);
  }
  const raw = yamlParse(await io.readFile(abs)) as FrictionEntry;
  const next = mutate(raw);
  await io.writeFile(abs, yamlStringify(next));
  return file;
}
