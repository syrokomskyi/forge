/*
<MODULE_CONTRACT>
<purpose>
Type definitions for the mission archive domain — mission directory discovery,
manifest state extraction, and archive result shapes.
</purpose>
<non-goals>
  <item>Do not define archive handler logic here — that lives in handlers/archive.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0573: initial mission archive types.</item>
</CHANGE_SUMMARY>
*/

export const MISSIONS_DIR = "missions";
export const ARCHIVE_DIR_NAME = "archive";

export const MISSION_TERMINAL_STATUSES = ["closed", "aborted"] as const;

export interface MissionArchiveMove {
  missionId: string;
  state: string;
  from: string;
  to: string;
  direction: "into-archive" | "out-of-archive";
}

export interface MissionArchiveSkip {
  missionId: string;
  dir: string;
  reason: string;
}

export interface MissionArchiveResult {
  command: "mission.archive";
  status: "ok";
  moved: MissionArchiveMove[];
  skipped: MissionArchiveSkip[];
  dryRun: boolean;
}
