/*
<MODULE_CONTRACT>
<purpose>
session.list handler — lists session files with optional filters by date
range, RFC-id, and session type. Parses frontmatter on the fly.
</purpose>
<non-goals>
  <item>Does not validate session content — that is session.validate.</item>
  <item>Does not modify files in any way.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: implement session.list command handler.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import {
  listSessionFiles,
  listArchivedSessionFiles,
  readAndParseSession,
} from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  SESSION_DIR,
  SESSION_ARCHIVE_SUBDIR,
  type SessionListResult,
  type SessionListEntry,
  type SessionType,
} from "../types.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(dateStr: string): Date | null {
  if (!DATE_PATTERN.test(dateStr)) return null;
  const date = new Date(dateStr + "T00:00:00Z");
  return isNaN(date.getTime()) ? null : date;
}

export async function runSessionList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const sessionDirPath = path.join(workspaceRoot, SESSION_DIR);

  const filterDateFrom = input.flags["date-from"] as string | undefined;
  const filterDateTo = input.flags["date-to"] as string | undefined;
  const filterRfc = input.flags["rfc"] as string | undefined;
  const filterType = input.flags["type"] as string | undefined;

  let dateFrom: Date | null = null;
  let dateTo: Date | null = null;

  if (filterDateFrom) {
    dateFrom = parseDate(filterDateFrom);
    if (!dateFrom) {
      throw new Error(`Invalid --date-from format, use YYYY-MM-DD. Got: "${filterDateFrom}"`);
    }
  }
  if (filterDateTo) {
    dateTo = parseDate(filterDateTo);
    if (!dateTo) {
      throw new Error(`Invalid --date-to format, use YYYY-MM-DD. Got: "${filterDateTo}"`);
    }
  }

  const entries: SessionListEntry[] = [];

  // Process active files
  const activeFiles = await listSessionFiles(sessionDirPath);
  for (const fileName of activeFiles) {
    const result = await readAndParseSession(sessionDirPath, fileName);
    if (!result) continue;

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const date = String(fm["date"] ?? "");
    const types = Array.isArray(fm["types"]) ? (fm["types"] as SessionType[]) : [];
    const summary = String(fm["summary"] ?? "");
    const relatedRfcs = Array.isArray(fm["relatedRfcs"]) ? (fm["relatedRfcs"] as string[]) : [];

    // Apply filters
    if (filterRfc && !relatedRfcs.includes(filterRfc)) continue;
    if (filterType && !types.includes(filterType as SessionType)) continue;
    if (dateFrom || dateTo) {
      const sessionDate = new Date(date);
      if (isNaN(sessionDate.getTime())) continue;
      const sessionDay = new Date(sessionDate.toISOString().slice(0, 10) + "T00:00:00Z");
      if (dateFrom && sessionDay < dateFrom) continue;
      if (dateTo && sessionDay > dateTo) continue;
    }

    entries.push({
      id,
      date,
      types,
      summary,
      relatedRfcs,
      file: path.join(SESSION_DIR, fileName),
      archived: false,
    });
  }

  // Process archived files
  const archivedFiles = await listArchivedSessionFiles(sessionDirPath);
  for (const fileName of archivedFiles) {
    const result = await readAndParseSession(
      path.join(sessionDirPath, SESSION_ARCHIVE_SUBDIR),
      fileName,
    );
    if (!result) continue;

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const date = String(fm["date"] ?? "");
    const types = Array.isArray(fm["types"]) ? (fm["types"] as SessionType[]) : [];
    const summary = String(fm["summary"] ?? "");
    const relatedRfcs = Array.isArray(fm["relatedRfcs"]) ? (fm["relatedRfcs"] as string[]) : [];

    // Apply filters
    if (filterRfc && !relatedRfcs.includes(filterRfc)) continue;
    if (filterType && !types.includes(filterType as SessionType)) continue;
    if (dateFrom || dateTo) {
      const sessionDate = new Date(date);
      if (isNaN(sessionDate.getTime())) continue;
      const sessionDay = new Date(sessionDate.toISOString().slice(0, 10) + "T00:00:00Z");
      if (dateFrom && sessionDay < dateFrom) continue;
      if (dateTo && sessionDay > dateTo) continue;
    }

    entries.push({
      id,
      date,
      types,
      summary,
      relatedRfcs,
      file: path.join(SESSION_DIR, SESSION_ARCHIVE_SUBDIR, fileName),
      archived: true,
    });
  }

  // Sort by date descending (most recent first)
  entries.sort((a, b) => b.date.localeCompare(a.date));

  if (outputFormat === "pretty") {
    if (entries.length === 0) {
      logger.info("No sessions found matching the given filters.");
    } else {
      logger.section(`Sessions (${entries.length})`);
      for (const entry of entries) {
        const archTag = entry.archived ? " [archived]" : "";
        const typesStr = entry.types.join(", ");
        logger.info(
          `${entry.id}  ${typesStr.padEnd(20)} ${entry.date}  ${entry.summary}${archTag}`,
        );
      }
    }
  }

  return {
    data: {
      command: "session.list",
      status: "ok",
      sessions: entries,
      count: entries.length,
    },
    summary: `${entries.length} session(s) found`,
  };
}
