/*
<MODULE_CONTRACT>
<purpose>
RFC-1053: Generate per-session skill effectiveness metrics as structured YAML.
Extracts skill invocations from parsed ATIF messages (not rendered markdown)
with approximate durations from message timestamps. Writes to
docs/metrics/sessions/<session-id>.metrics.yaml via writeFileAtomic.
</purpose>
<non-goals>
  <item>Does not parse the rendered markdown transcript — uses AtifMessage[] directly.</item>
  <item>Does not block session.save on metrics failure — caller wraps in try/catch.</item>
  <item>Does not extract skill durations with precision — all durations are approximate.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1053: initial generateSessionMetrics pure function using ATIF metadata.</item>
</CHANGE_SUMMARY>
*/

import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { stringify as yamlStringify } from "yaml";

import { METRICS_DIR, type SessionMetrics, type SessionSkillInvocation, type SessionDocumentRef, type InsightSummary } from "../types.ts";
import type { AtifMessage } from "../atif-parser.ts";

// ─── Skill name extraction ───────────────────────────────────────────────────

const SKILL_PATTERN = /\b(fo-[a-z]+(?:-[a-z]+)*)\b/g;

const KNOWN_SKILLS = new Set([
  "fo-idea",
  "fo-idea-audit",
  "fo-idea-enhance",
  "fo-idea-plan",
  "fo-idea-implement",
  "fo-idea-create-rfc",
  "fo-idea-create-adr",
  "fo-idea-i-just-want-to-see-the-plan",
  "fo-idea-i-just-want-to-see-the-result",
  "fo-idea-status",
  "fo-idea-audit",
  "fo-review",
  "fo-fix",
  "fo-session-retro",
  "fo-session-save",
  "fo-doc-audit",
  "fo-architecture",
  "fo-compass-annotate",
  "fo-explore",
  "fo-extract-dna",
  "fo-handoff",
  "fo-harvest",
  "fo-knowledge-distill",
  "fo-memory-sync",
  "fo-qa",
  "fo-step-commit",
  "fo-triage",
  "fo-add-tests",
]);

function extractSkillInvocations(messages: AtifMessage[]): SessionSkillInvocation[] {
  const invocations: SessionSkillInvocation[] = [];
  const seenSkills = new Map<string, { firstMsgIndex: number; lastMsgIndex: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const matches = [...msg.content.matchAll(SKILL_PATTERN)];
    const skillNames = new Set(matches.map((m) => m[1]!));
    for (const skill of skillNames) {
      if (!KNOWN_SKILLS.has(skill)) continue;
      const existing = seenSkills.get(skill);
      if (existing) {
        existing.lastMsgIndex = i;
      } else {
        seenSkills.set(skill, { firstMsgIndex: i, lastMsgIndex: i });
      }
    }
  }

  for (const [skill, indices] of seenSkills) {
    const firstMsg = messages[indices.firstMsgIndex]!;
    const lastMsg = messages[indices.lastMsgIndex]!;
    let approximateDurationMs: number | null = null;

    if (firstMsg.timestamp && lastMsg.timestamp) {
      const firstTime = new Date(firstMsg.timestamp).getTime();
      const lastTime = new Date(lastMsg.timestamp).getTime();
      if (!isNaN(firstTime) && !isNaN(lastTime)) {
        approximateDurationMs = Math.max(0, lastTime - firstTime);
      }
    }

    invocations.push({ skill, approximateDurationMs });
  }

  return invocations;
}

// ─── Document references ─────────────────────────────────────────────────────

async function extractDocumentRefs(
  workspaceRoot: string,
  relatedRfcs: string[],
): Promise<SessionDocumentRef[]> {
  const refs: SessionDocumentRef[] = [];
  const metricsRfcDir = join(workspaceRoot, METRICS_DIR, "rfcs");

  let existingMetricsFiles: string[] = [];
  try {
    existingMetricsFiles = await readdir(metricsRfcDir);
  } catch {
    // No metrics directory yet
  }

  for (const rfcId of relatedRfcs) {
    const rfcLower = rfcId.toLowerCase();
    const metricsFileName = `${rfcLower}.metrics.yaml`;
    const hasMetrics = existingMetricsFiles.includes(metricsFileName);
    refs.push({
      rfcId,
      status: "unknown",
      metricsFile: hasMetrics ? `${METRICS_DIR}/rfcs/${metricsFileName}` : null,
    });
  }

  return refs;
}

// ─── Insight extraction ──────────────────────────────────────────────────────

function extractInsights(messages: AtifMessage[]): InsightSummary | null {
  let total = 0;
  const byCategory: Record<string, number> = {};

  for (const msg of messages) {
    const lowerContent = msg.content.toLowerCase();
    if (!lowerContent.includes("insight")) continue;

    const categoryPattern = /(?:category|type|route):\s*([a-z-]+)/gi;
    let match;
    while ((match = categoryPattern.exec(msg.content)) !== null) {
      const category = match[1]!.trim();
      total++;
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }
  }

  if (total === 0) return null;
  return { total, byCategory };
}

// ─── Duration calculation ────────────────────────────────────────────────────

function computeSessionDurationMs(messages: AtifMessage[]): number {
  const timestamps = messages
    .map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : null))
    .filter((t): t is number => t !== null && !isNaN(t));

  if (timestamps.length < 2) return 0;
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  return Math.max(0, max - min);
}

// ─── Main function ───────────────────────────────────────────────────────────

export async function generateSessionMetrics(
  workspaceRoot: string,
  sessionId: string,
  messages: AtifMessage[],
  sessionFrontmatter: {
    date?: string;
    relatedRfcs?: string[];
    commits?: string[];
  },
  logger: { warn: (msg: string) => void },
): Promise<string> {
  const skills = extractSkillInvocations(messages);
  const documents = await extractDocumentRefs(workspaceRoot, sessionFrontmatter.relatedRfcs ?? []);
  const insights = extractInsights(messages);
  const durationMs = computeSessionDurationMs(messages);

  const metrics: SessionMetrics = {
    sessionId,
    generatedAt: new Date().toISOString(),
    date: sessionFrontmatter.date ?? new Date().toISOString().split("T")[0]!,
    durationMs,
    approximateDurations: true,
    documents,
    skills,
    insights,
    commits: sessionFrontmatter.commits ?? [],
  };

  const yamlContent = yamlStringify(metrics, { lineWidth: 120 });
  const metricsFilePath = join(
    workspaceRoot,
    METRICS_DIR,
    "sessions",
    `${sessionId}.metrics.yaml`,
  );
  await mkdir(dirname(metricsFilePath), { recursive: true });
  await writeFileAtomic(metricsFilePath, yamlContent);

  return `${METRICS_DIR}/sessions/${sessionId}.metrics.yaml`;
}
