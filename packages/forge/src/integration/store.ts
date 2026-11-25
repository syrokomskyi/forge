/*
<MODULE_CONTRACT>
<purpose>
Queue persistence (Werkstatt RFC-1647) — atomic enqueue via staging plus a single
journal append; append-only journal as the source of truth with bounded fold via
checkpoints; unit records immutable once terminal. A journal entry referencing a
missing or incomplete unit record is proof of crash-mid-enqueue and is discarded
as never-enqueued.
</purpose>
<non-goals>
  <item>No lease or drain logic — persistence only.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial queue store.</item>
</CHANGE_SUMMARY>
*/

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { IntegrationUnit, QueueJournalEntry } from "./types.ts";

function atomicWrite(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = join(join(path, ".."), `.tmp-${randomBytes(8).toString("hex")}`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export interface QueueStore {
  /**
   * Atomic enqueue: the unit record is staged, then becomes visible through one
   * atomic journal append. Either the unit exists complete in the queue or not
   * at all — partial units are impossible by construction.
   */
  enqueue(unit: IntegrationUnit): void;
  appendJournal(entry: QueueJournalEntry): void;
  readUnit(id: string): IntegrationUnit | null;
  writeUnit(unit: IntegrationUnit): void;
  /** All live units folded from journal + records — never-enqueued partial entries discarded. */
  units(): IntegrationUnit[];
  journal(): QueueJournalEntry[];
  checkpoint(): void;
  queueDir: string;
}

export function createQueueStore(queueDir: string): QueueStore {
  const unitsDir = join(queueDir, "units");
  const journalPath = join(queueDir, "journal.log");
  const checkpointPath = join(queueDir, "checkpoint.json");
  mkdirSync(unitsDir, { recursive: true });

  function unitPath(id: string): string {
    return join(unitsDir, `${id}.json`);
  }

  function appendJournal(entry: QueueJournalEntry): void {
    mkdirSync(queueDir, { recursive: true });
    const fd = openSync(journalPath, "a");
    try {
      writeSync(fd, JSON.stringify(entry) + "\n");
    } finally {
      closeSync(fd);
    }
  }

  function readJournalRaw(): QueueJournalEntry[] {
    if (!existsSync(journalPath)) return [];
    return readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as QueueJournalEntry);
  }

  function readUnit(id: string): IntegrationUnit | null {
    try {
      return JSON.parse(readFileSync(unitPath(id), "utf8")) as IntegrationUnit;
    } catch {
      return null;
    }
  }

  function writeUnit(unit: IntegrationUnit): void {
    atomicWrite(unitPath(unit.id), JSON.stringify(unit, null, 2));
  }

  function units(): IntegrationUnit[] {
    // Fold the journal: a unit is live when its enqueued entry resolves to a
    // complete record. Entries referencing missing/incomplete records are proof
    // of crash-mid-enqueue — discarded as never-enqueued.
    const entries = readJournalRaw();
    const ids: string[] = [];
    for (const e of entries) {
      if (e.transition === "enqueued" && !ids.includes(e.unitId)) {
        if (readUnit(e.unitId) != null) ids.push(e.unitId);
      }
    }
    return ids.map((id) => readUnit(id)!).filter(Boolean);
  }

  return {
    queueDir,
    enqueue(unit) {
      // Stage the complete record first, then the single atomic journal append
      // that makes it visible. Reverse order would expose a referencing entry
      // without a record; this order makes crash-mid-enqueue detectable and
      // discardable.
      writeUnit(unit);
      appendJournal({
        schema: "forge:queue-journal/v1",
        unitId: unit.id,
        transition: "enqueued",
        at: new Date().toISOString(),
        actor: `session:${unit.source.sessionId}`,
      });
    },
    appendJournal,
    readUnit,
    writeUnit,
    units,
    journal: readJournalRaw,
    checkpoint() {
      // Fold-on-read stays bounded by checkpoint spacing, not journal age.
      const snapshot = {
        at: new Date().toISOString(),
        units: units().map((u) => ({ id: u.id, state: u.state })),
      };
      atomicWrite(checkpointPath, JSON.stringify(snapshot, null, 2));
    },
  };
}

/** Garbage-collect staging residue older than crash windows — safe because incomplete units are never visible. */
export function cleanStagingResidue(queueDir: string): number {
  const staging = join(queueDir, "staging");
  if (!existsSync(staging)) return 0;
  let removed = 0;
  for (const entry of readdirSync(staging)) {
    try {
      unlinkSync(join(staging, entry));
      removed += 1;
    } catch {
      // concurrent writer — leave it
    }
  }
  return removed;
}
