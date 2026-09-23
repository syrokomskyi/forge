/*
<MODULE_CONTRACT>
<purpose>Compass audit command handlers (plan, record, baseline, validate).
Moved from @warpgogol/site-kernel-checks to @warpgogol/forge for full autonomous
mode (RFC-0556). Drives per-file semantic-truth auditing on a revision cadence (RFC-0352).</purpose>
<non-goals>
  <item>Do not perform semantic comparison inside a command — commands are deterministic; the code-vs-prose judgment is the agent's.</item>
  <item>Do not call an LLM or read any API key.</item>
  <item>Do not replace compass.validate — this adds a heavy truth audit on top.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0352: initial implementation of compass.audit.plan, compass.audit.record, compass.audit.baseline, compass.audit.validate.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @warpgogol/forge for autonomous mode.</item>
  <item>RFC-1094: audit work orders now carry the KEY_DECISIONS block alongside MODULE_CONTRACT and CHANGE_SUMMARY.</item>
  <item>RFC-1139: CLI hint accuracy and agent-safety hygiene — rfc.create hint, EC-14-PARTIAL, amend delegation, ledger scope, sync footer, mission.open remnants</item>
  <item>RFC-1143: validate/plan/record apply filterLedgerEligiblePaths — ledger-ineligible authored paths (missions/, gitignored) are skipped with skippedIneligible diagnostics instead of failing COMPASS-AUDIT-01; record warns but still writes.</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createCompassInventoryEntries } from "./compass-inventory.ts";
import { resolveCompassPolicy } from "../policy.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { getRevisionByPath } from "./git-revision.ts";
import type { CompassInventoryEntry } from "./compass-inventory.ts";
import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { buildGeneratedHeader } from "../../../src/utils/generated-marker.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

const execFileAsync = promisify(execFile);
const LEDGER_PATH = "docs/compass-audit-ledger.generated.yaml";
const DEFAULT_THRESHOLD = 30;
// RFC-1143: cap the skippedPaths diagnostic list so huge ineligible sets do not
// flood the output; the pretty summary appends "and N more" when truncated.
const SKIPPED_PATHS_CAP = 20;

function resolveRevisionThreshold(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type CompassAuditVerdict = "pass" | "repaired" | "baseline";

interface CompassAuditLedgerEntry {
  path: string;
  entityId: string;
  auditedRevision: number;
  auditedHash: string;
  auditedAt: string;
  verdict: CompassAuditVerdict;
  agent: string;
}

interface CompassAuditLedger {
  revisionThreshold: number;
  entries: CompassAuditLedgerEntry[];
}

interface CompassAuditWorkOrderItem {
  path: string;
  currentRevision: number;
  auditedRevision: number | null;
  reason: "never-audited" | "revision-threshold-crossed";
  moduleContract: string;
  keyDecisions: string;
  changeSummary: string;
}

export function isAuditDue(current: number, audited: number | null, threshold: number): boolean {
  if (audited === null) return true;
  return current - audited >= threshold;
}

const _LEDGER_ADVISORY = { ownerCommand: "compass.audit.record" };

function withLedgerAdvisory(ledger: Partial<CompassAuditLedger>): CompassAuditLedger {
  return {
    revisionThreshold: ledger.revisionThreshold ?? DEFAULT_THRESHOLD,
    entries: Array.isArray(ledger.entries) ? ledger.entries : [],
  };
}

async function loadLedger(workspaceRoot: string): Promise<CompassAuditLedger> {
  const abs = resolve(workspaceRoot, LEDGER_PATH);
  try {
    const content = await readFile(abs, "utf8");
    return withLedgerAdvisory(yamlParse(content) as Partial<CompassAuditLedger>);
  } catch {
    return withLedgerAdvisory({});
  }
}

async function saveLedger(workspaceRoot: string, ledger: CompassAuditLedger): Promise<void> {
  const normalized = withLedgerAdvisory(ledger);
  normalized.entries.sort((a, b) => a.path.localeCompare(b.path));
  const abs = resolve(workspaceRoot, LEDGER_PATH);
  await mkdir(resolve(abs, ".."), { recursive: true });
  const header = buildGeneratedHeader({
    ownerCommand: "compass.audit.record",
    filePath: LEDGER_PATH,
  });
  const yaml = header + yamlStringify(normalized) + "\n";
  await writeFileAtomic(abs, yaml);
}

function extractBlock(source: string, tagName: string): string {
  const match = source.match(new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`));
  return match?.[0] ?? "";
}

async function getGitUser(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "user.name"], {
      cwd: workspaceRoot,
    });
    return `human:${stdout.trim()}`;
  } catch {
    return "human:unknown";
  }
}

function getAuthoredEntries(entries: CompassInventoryEntry[]): CompassInventoryEntry[] {
  return entries.filter(
    (e) => e.authoringStatus === "authored" && e.requiredScaffolding !== "none",
  );
}

// RFC-1139: the tracked ledger must not accumulate entries for paths that
// can never be audited long-term — gitignored roots (missions/, dist/) and
// the missions/ tree specifically (workpieces move to archive on close).
// Batch-checks `git check-ignore --stdin` once for all candidate paths.
async function filterLedgerEligiblePaths(
  workspaceRoot: string,
  paths: string[],
): Promise<Set<string>> {
  const eligible = new Set<string>();
  const candidates = paths.filter((p) => !p.startsWith("missions/"));
  let ignored = new Set<string>();
  if (candidates.length > 0) {
    try {
      const stdout = execFileSync("git", ["check-ignore", "--stdin"], {
        cwd: workspaceRoot,
        input: candidates.join("\n"),
        encoding: "utf-8",
      });
      ignored = new Set(stdout.split("\n").filter((l: string) => l.length > 0));
    } catch {
      // check-ignore exits 1 when nothing is ignored — treat all as eligible
      ignored = new Set();
    }
  }
  for (const p of candidates) {
    if (!ignored.has(p)) eligible.add(p);
  }
  return eligible;
}

// RFC-1143: partition authored entries into ledger-eligible and ineligible
// sets. Shared by plan/validate so the predicate lives in exactly one place.
async function partitionLedgerEligibleAuthored(
  workspaceRoot: string,
  authored: CompassInventoryEntry[],
): Promise<{ eligible: CompassInventoryEntry[]; ineligible: CompassInventoryEntry[] }> {
  const eligiblePaths = await filterLedgerEligiblePaths(
    workspaceRoot,
    authored.map((e) => e.path),
  );
  const eligible: CompassInventoryEntry[] = [];
  const ineligible: CompassInventoryEntry[] = [];
  for (const entry of authored) {
    (eligiblePaths.has(entry.path) ? eligible : ineligible).push(entry);
  }
  return { eligible, ineligible };
}

export async function runCompassAuditPlan(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    threshold: number;
    dueCount: number;
    items: CompassAuditWorkOrderItem[];
    skippedIneligible: number;
  }>
> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const policy = resolveCompassPolicy(context.workspaceRoot, context.forgeRoot);
  const entries = await createCompassInventoryEntries(
    context.workspaceRoot,
    input,
    scanRoot,
    policy,
    context.site?.directory,
  );
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

  const threshold = resolveRevisionThreshold(input.flags["threshold"], ledger.revisionThreshold);

  // RFC-1143: drop ledger-ineligible authored paths (missions/, gitignored)
  // before the per-entry revision loop — they can never be audited long-term
  // and must not cost a git call each.
  const { eligible: eligibleAuthored, ineligible } = await partitionLedgerEligibleAuthored(
    context.workspaceRoot,
    authored,
  );
  const skippedIneligible = ineligible.length;

  const ledgerMap = new Map<string, CompassAuditLedgerEntry>();
  for (const e of ledger.entries) {
    ledgerMap.set(e.path, e);
  }

  const items: CompassAuditWorkOrderItem[] = [];

  for (const entry of eligibleAuthored) {
    const ledgerEntry = ledgerMap.get(entry.path);
    const auditedRevision = ledgerEntry?.auditedRevision ?? null;

    const { revision: currentRevision } = await getRevisionByPath(
      context.workspaceRoot,
      entry.path,
    );

    if (!isAuditDue(currentRevision, auditedRevision, threshold)) {
      continue;
    }

    const absPath = resolve(context.workspaceRoot, entry.path);
    const source = await readFile(absPath, "utf8");
    const moduleContract = extractBlock(source, "MODULE_CONTRACT");
    const keyDecisions = extractBlock(source, "KEY_DECISIONS");
    const changeSummary = extractBlock(source, "CHANGE_SUMMARY");

    items.push({
      path: entry.path,
      currentRevision,
      auditedRevision,
      reason: auditedRevision === null ? "never-audited" : "revision-threshold-crossed",
      moduleContract,
      keyDecisions,
      changeSummary,
    });
  }

  items.sort((a, b) => a.path.localeCompare(b.path));

  context.logger.info(
    `[compass.audit.plan] threshold=${threshold}, due=${items.length}, skippedIneligible=${skippedIneligible}`,
  );

  return {
    data: { threshold, dueCount: items.length, items, skippedIneligible },
    exitCode: 0,
    summary: `[compass.audit.plan] ${items.length} files due for audit (threshold=${threshold})`,
    nextSteps:
      items.length > 0
        ? [
            {
              action: `Record an audit: pnpm exec forge run compass.audit.record --file <path> --verdict <verdict> --revision <rev>`,
              kind: "optional",
            },
          ]
        : undefined,
  };
}

export async function runCompassAuditRecord(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    path: string;
    action: "recorded";
  }>
> {
  const rawFilePath = input.flags["file"] as string | undefined;
  const verdict = input.flags["verdict"] as CompassAuditVerdict | undefined;
  const agentFlag = input.flags["agent"] as string | undefined;

  if (!rawFilePath) {
    context.logger.error("[compass.audit.record] --file is required");
    return { exitCode: 1, data: { path: "", action: "recorded" } };
  }

  if (!verdict || !["pass", "repaired", "baseline"].includes(verdict)) {
    context.logger.error("[compass.audit.record] --verdict must be pass|repaired|baseline");
    return { exitCode: 1, data: { path: rawFilePath, action: "recorded" } };
  }

  const filePath = relative(context.workspaceRoot, resolve(process.cwd(), rawFilePath));

  // RFC-1143: warn when recording an audit for a ledger-ineligible path — the
  // entry will be swept by the next baseline run (RFC-1139). Operator intent
  // wins: the write still proceeds.
  const recordEligible = await filterLedgerEligiblePaths(context.workspaceRoot, [filePath]);
  if (!recordEligible.has(filePath)) {
    context.logger.warn(
      `[compass.audit.record] ${filePath}: path is ledger-ineligible (missions/ or gitignored) — this entry will be swept by the next compass.audit.baseline run`,
    );
  }

  const { revision, entityId, contentHash } = await getRevisionByPath(
    context.workspaceRoot,
    filePath,
  );

  const agent = agentFlag ?? (await getGitUser(context.workspaceRoot));
  const ledger = await loadLedger(context.workspaceRoot);

  const existingIdx = ledger.entries.findIndex((e) => e.path === filePath);
  const entry: CompassAuditLedgerEntry = {
    path: filePath,
    entityId: entityId ?? "",
    auditedRevision: revision,
    auditedHash: contentHash,
    auditedAt: new Date().toISOString(),
    verdict,
    agent,
  };

  if (existingIdx >= 0) {
    ledger.entries[existingIdx] = entry;
  } else {
    ledger.entries.push(entry);
  }

  if (!context.dryRun) {
    await saveLedger(context.workspaceRoot, ledger);
  }

  context.logger.info(
    `[compass.audit.record] ${filePath}: verdict=${verdict}, revision=${revision}, agent=${agent}`,
  );

  return {
    data: { path: filePath, action: "recorded" },
    exitCode: 0,
    summary: `[compass.audit.record] ${filePath}: ${verdict} at revision ${revision}`,
    nextSteps: [
      {
        action: `Validate audits: pnpm exec forge run compass.audit.validate`,
        kind: "optional",
      },
    ],
  };
}

export async function runCompassAuditBaseline(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    seeded: number;
    total: number;
  }>
> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const policy = resolveCompassPolicy(context.workspaceRoot, context.forgeRoot);
  const entries = await createCompassInventoryEntries(
    context.workspaceRoot,
    input,
    scanRoot,
    policy,
    context.site?.directory,
  );
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

  // RFC-1139: drop ineligible entries (missions/, gitignored) already in the
  // ledger — self-healing cleanup — and never seed new ones.
  const candidatePaths = [...authored.map((e) => e.path), ...ledger.entries.map((e) => e.path)];
  const eligible = await filterLedgerEligiblePaths(context.workspaceRoot, candidatePaths);
  ledger.entries = ledger.entries.filter((e) => eligible.has(e.path));

  const existingPaths = new Set(ledger.entries.map((e) => e.path));
  let seededCount = 0;

  for (const entry of authored) {
    if (!eligible.has(entry.path) || existingPaths.has(entry.path)) {
      continue;
    }

    const { revision, entityId, contentHash } = await getRevisionByPath(
      context.workspaceRoot,
      entry.path,
    );

    ledger.entries.push({
      path: entry.path,
      entityId: entityId ?? "",
      auditedRevision: revision,
      auditedHash: contentHash,
      auditedAt: new Date().toISOString(),
      verdict: "baseline",
      agent: "system:baseline",
    });
    seededCount++;
  }

  ledger.entries.sort((a, b) => a.path.localeCompare(b.path));

  if (!context.dryRun) {
    await saveLedger(context.workspaceRoot, ledger);
  }

  context.logger.info(
    `[compass.audit.baseline] seeded=${seededCount}, total=${ledger.entries.length}`,
  );

  return {
    data: { seeded: seededCount, total: ledger.entries.length },
    exitCode: 0,
    summary: `[compass.audit.baseline] seeded ${seededCount} entries (total: ${ledger.entries.length})`,
  };
}

export async function runCompassAuditValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    strict: boolean;
    dueCount: number;
    diagnostics: Array<{
      ruleId: string;
      severity: string;
      file: string;
      message: string;
      fix: string;
    }>;
    skippedIneligible: number;
    skippedPaths: string[];
  }>
> {
  const strict = input.flags["strict"] === true;
  const scanRoot = resolveCompassScanRoot(input, context);
  const policy = resolveCompassPolicy(context.workspaceRoot, context.forgeRoot);
  const entries = await createCompassInventoryEntries(
    context.workspaceRoot,
    input,
    scanRoot,
    policy,
    context.site?.directory,
  );
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

  // RFC-1143: drop ledger-ineligible authored paths (missions/, gitignored)
  // before the per-entry revision loop — baseline is forbidden to seed them,
  // so demanding entries is a guaranteed false-positive (COMPASS-AUDIT-01).
  const { eligible: eligibleAuthored, ineligible } = await partitionLedgerEligibleAuthored(
    context.workspaceRoot,
    authored,
  );
  const skippedPaths = ineligible.map((e) => e.path).sort();
  const skippedIneligible = skippedPaths.length;

  const ledgerMap = new Map<string, CompassAuditLedgerEntry>();
  for (const e of ledger.entries) {
    ledgerMap.set(e.path, e);
  }

  const diagnostics: Array<{
    ruleId: string;
    severity: string;
    file: string;
    message: string;
    fix: string;
  }> = [];

  for (const entry of eligibleAuthored) {
    const ledgerEntry = ledgerMap.get(entry.path);
    const auditedRevision = ledgerEntry?.auditedRevision ?? null;

    const { revision: currentRevision } = await getRevisionByPath(
      context.workspaceRoot,
      entry.path,
    );

    if (!isAuditDue(currentRevision, auditedRevision, ledger.revisionThreshold)) {
      continue;
    }

    const severity = strict ? "error" : "warning";
    context.logger[strict ? "error" : "warn"](
      `[compass.audit.validate] COMPASS-AUDIT-01: ${entry.path}: audit overdue (current=${currentRevision}, audited=${auditedRevision ?? "never"}, threshold=${ledger.revisionThreshold})`,
    );
    diagnostics.push({
      ruleId: "COMPASS-AUDIT-01",
      severity,
      file: entry.path,
      message: `Compass audit overdue: ${currentRevision - (auditedRevision ?? 0)} revisions since last audit (threshold=${ledger.revisionThreshold})`,
      fix: "fix: run compass.audit.plan, reconcile the blocks with the code, then compass.audit.record",
    });
  }

  const dueCount = diagnostics.length;
  const hasErrors = strict && dueCount > 0;

  if (skippedIneligible > 0) {
    const shown = skippedPaths.slice(0, SKIPPED_PATHS_CAP);
    const more = skippedIneligible - shown.length;
    context.logger.info(
      `[compass.audit.validate] skipped ${skippedIneligible} ledger-ineligible path(s) (missions/, gitignored)${more > 0 ? ` and ${more} more` : ""}`,
    );
  }

  return {
    data: {
      strict,
      dueCount,
      diagnostics,
      skippedIneligible,
      skippedPaths: skippedPaths.slice(0, SKIPPED_PATHS_CAP),
    },
    exitCode: hasErrors ? 1 : 0,
    summary: dueCount > 0 ? undefined : `[compass.audit.validate] OK (0 files overdue)`,
    nextSteps:
      dueCount > 0
        ? [
            {
              action: `Fix the ${dueCount} overdue file(s) above, then re-run: pnpm exec forge run compass.audit.validate`,
              kind: "required",
            },
          ]
        : undefined,
  };
}
