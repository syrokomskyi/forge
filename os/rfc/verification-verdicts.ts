/*
<MODULE_CONTRACT>
<purpose>
RFC-1458: ingest release-evidence verdicts into rfc.verification.emit. Scans
the per-release verdict files under releases/<id>/.test-evidence/ for
werkstatt:verdict/v1 records whose requirement matches the emitted RFC's AC
criteria and attaches
the newest record per criterion to the probe record as externalVerdict —
external-origin evidence alongside the git-derived origin.
</purpose>
<non-goals>
  <item>Do not decide stamp outcomes — implement-stamp owns tier rules; ingest only attaches records.</item>
  <item>Do not fail on absent or malformed verdict files — ingestion is a best-effort read path.</item>
  <item>Do not re-execute probes — a verdict never turns a failing probe green; it is context.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Newest wins per criterion — flat across channels, ordered by observedAt; channel stays on the record.</item>
  <item>Local wire-shape type is redeclared — forge is autonomous (FORGE-AUTONOMY-01) and may not import werkstatt-shared at runtime.</item>
  <item>Unparseable files and non-record entries are skipped silently — a corrupt release directory must not block emit.</item>
  <item>Attachment is volatile evidence context — checkEvidenceEnvelope never compares externalVerdict.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1458: initial — verdict wire shape, release scan, newest-per-criterion ingest, probe-record attachment.</item>
  <item>RFC-1458: emit requirement-mapped verdict events from deploy.smoke.run</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";
import type { WorkspaceIO } from "../../src/types.ts";
import type { ReleaseVerdictEvidence, VerificationEvidenceProbeRecord } from "./types.ts";

const VERDICT_GLOB = "releases/*/.test-evidence/verdicts.json";
const VERDICT_SCHEMA = "werkstatt:verdict/v1";
const VALID_OUTCOMES = new Set(["pass", "fail", "inconclusive"]);

/** Minimal wire shape — mirrors werkstatt:verdict/v1 without a runtime import. */
interface VerdictWireRecord {
  schema?: unknown;
  requirement?: unknown;
  check?: unknown;
  outcome?: unknown;
  releaseId?: unknown;
  site?: unknown;
  channel?: unknown;
  observedAt?: unknown;
  detail?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function toVerdictEvidence(raw: VerdictWireRecord): ReleaseVerdictEvidence | null {
  if (raw.schema !== VERDICT_SCHEMA) return null;
  if (
    !isString(raw.requirement) ||
    !isString(raw.check) ||
    !isString(raw.releaseId) ||
    !isString(raw.site) ||
    !isString(raw.channel) ||
    !isString(raw.observedAt)
  ) {
    return null;
  }
  if (typeof raw.outcome !== "string" || !VALID_OUTCOMES.has(raw.outcome)) return null;
  return {
    requirement: raw.requirement,
    check: raw.check,
    outcome: raw.outcome as ReleaseVerdictEvidence["outcome"],
    releaseId: raw.releaseId,
    site: raw.site,
    channel: raw.channel,
    observedAt: raw.observedAt,
    ...(isString(raw.detail) ? { detail: raw.detail } : {}),
  };
}

/**
 * Scan release evidence for verdicts matching `<rfcId>/<criterion>` and attach
 * the newest record per criterion to its probe record. Absent files, absent
 * matches, and malformed entries are a silent no-op.
 */
export async function attachVerdictEvidence(input: {
  workspaceRoot: string;
  io: WorkspaceIO;
  rfcId: string;
  records: VerificationEvidenceProbeRecord[];
}): Promise<number> {
  const { workspaceRoot, io, rfcId, records } = input;
  const files = await io.glob(VERDICT_GLOB, { cwd: workspaceRoot });
  if (files.length === 0) return 0;

  // Newest verdict per requirement id across all releases/channels.
  const newest = new Map<string, ReleaseVerdictEvidence>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await io.readFile(join(workspaceRoot, file)));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const verdict = toVerdictEvidence((entry ?? {}) as VerdictWireRecord);
      if (!verdict || !verdict.requirement.startsWith(`${rfcId}/`)) continue;
      const prev = newest.get(verdict.requirement);
      if (!prev || verdict.observedAt > prev.observedAt) newest.set(verdict.requirement, verdict);
    }
  }
  if (newest.size === 0) return 0;

  let attached = 0;
  for (const record of records) {
    if (!record.probe.criterion) continue;
    const verdict = newest.get(`${rfcId}/${record.probe.criterion}`);
    if (verdict) {
      record.externalVerdict = verdict;
      attached++;
    }
  }
  return attached;
}
