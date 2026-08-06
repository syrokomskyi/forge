/*
<MODULE_CONTRACT>
<purpose>
Defines types and constants for managing exploration notes: statuses,
frontmatter shape, list/show/archive result types.
</purpose>
<non-goals>
  <item>Do not implement exploration processing logic here.</item>
  <item>Do not handle user input or command execution.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial exploration types and constants.</item>
</CHANGE_SUMMARY>
*/

export type ExplorationStatus = "open" | "explored" | "archived";

export const EXPLORATION_STATUSES: readonly ExplorationStatus[] = [
  "open",
  "explored",
  "archived",
] as const;

export interface ExplorationNote {
  id: string;
  title: string;
  createdAt: string;
  status: ExplorationStatus;
  related: string[];
  body: string;
}

export interface ExplorationListEntry {
  id: string;
  title: string;
  status: ExplorationStatus;
  createdAt: string;
}

export interface ExplorationListResult {
  command: "exploration.list";
  status: "ok";
  count: number;
  explorations: ExplorationListEntry[];
}

export interface ExplorationShowResult {
  command: "exploration.show";
  status: "ok" | "error";
  note: ExplorationNote;
}

export interface ExplorationArchiveResult {
  command: "exploration.archive";
  status: "ok" | "error";
  id: string;
  previousStatus: string;
  newStatus: "archived";
  related: string[];
}

export const EXPLORATION_DIR = "docs/explorations";

export const EXPLORATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
