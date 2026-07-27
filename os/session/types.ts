/*
<MODULE_CONTRACT>
<purpose>
Type definitions and constants for the session documentation domain —
session frontmatter, list/archive/validate/save result shapes, and SES
validation rule identifiers.
</purpose>
<non-goals>
  <item>Do not define handler logic here — that lives in handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial session domain types, constants, and SES rule identifiers.</item>
</CHANGE_SUMMARY>
*/

export const SESSION_DIR = "docs/sessions";
export const SESSION_RAW_SUBDIR = ".raw";
export const SESSION_ARCHIVE_SUBDIR = "archive";
export const SESSION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/;
export const SESSION_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\.md$/;

export const SESSION_TYPES = [
  "mission",
  "grilling",
  "implementation",
  "review",
  "fix",
  "freeform",
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_KNOWN_KEYS = [
  "id",
  "date",
  "duration",
  "types",
  "summary",
  "relatedRfcs",
  "relatedArtifacts",
  "decisions",
  "commits",
  "files",
  "commands",
] as const;

export const SESSION_REQUIRED_KEYS = ["id", "date", "types"] as const;

export const SESSION_REQUIRED_SECTIONS = ["## Transcript"] as const;

// SES validation rules
export const SES_RULES = {
  SES_01: "SES-01",
  SES_02: "SES-02",
  SES_03: "SES-03",
  SES_04: "SES-04",
  SES_05: "SES-05",
} as const;

export type SesRule = (typeof SES_RULES)[keyof typeof SES_RULES];

// ── Session frontmatter (the .md file's YAML frontmatter) ──

export interface SessionFrontmatter {
  id: string;
  date: string;
  duration: string | null;
  types: SessionType[];
  summary: string;
  relatedRfcs: string[];
  relatedArtifacts: string[];
  decisions: string[];
  commits: string[];
  files: string[];
  commands: string[];
}

// ── session.save ──

export interface SessionSaveResult {
  command: "session.save";
  status: "ok";
  file: string;
  rawFile: string;
  rawDeleted: boolean;
  id: string;
  types: SessionType[];
  extractedMetadata: {
    relatedRfcs: string[];
    relatedArtifacts: string[];
    commits: string[];
    files: string[];
    commands: string[];
  };
  dryRun: boolean;
}

export interface SessionSaveSkip {
  rawFile: string;
  reason: string;
}

// ── session.archive ──

export interface SessionArchiveMove {
  id: string;
  file: string;
  from: string;
  to: string;
  ageDays: number;
  direction: "into-archive" | "out-of-archive";
}

export interface SessionArchiveSkip {
  id: string;
  file: string;
  reason: string;
}

export interface SessionArchiveResult {
  command: "session.archive";
  status: "ok";
  moved: SessionArchiveMove[];
  skipped: SessionArchiveSkip[];
  maxAgeDays: number;
  dryRun: boolean;
}

// ── session.validate ──

export interface SessionValidationViolation {
  rule: SesRule;
  file: string;
  message: string;
  severity: "error" | "warning";
}

export interface SessionValidationResult {
  command: "session.validate";
  status: "pass" | "fail";
  violations: SessionValidationViolation[];
  checked: number;
}

// ── session.list ──

export interface SessionListEntry {
  id: string;
  date: string;
  types: SessionType[];
  summary: string;
  relatedRfcs: string[];
  file: string;
  archived: boolean;
}

export interface SessionListResult {
  command: "session.list";
  status: "ok";
  sessions: SessionListEntry[];
  count: number;
}
