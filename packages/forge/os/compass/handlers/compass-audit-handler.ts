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
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCompassInventoryEntries } from "./compass-inventory.ts";
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
  changeSummary: string;
}

export function isAuditDue(current: number, audited: number | null, threshold: number): boolean {
  if (audited === null) return true;
  return current - audited >= threshold;
}

const LEDGER_ADVISORY = { ownerCommand: "compass.audit.record" };

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

export async function runCompassAuditPlan(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    threshold: number;
    dueCount: number;
    items: CompassAuditWorkOrderItem[];
  }>
> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

  const threshold = resolveRevisionThreshold(input.flags["threshold"], ledger.revisionThreshold);

  const ledgerMap = new Map<string, CompassAuditLedgerEntry>();
  for (const e of ledger.entries) {
    ledgerMap.set(e.path, e);
  }

  const items: CompassAuditWorkOrderItem[] = [];

  for (const entry of authored) {
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
    const changeSummary = extractBlock(source, "CHANGE_SUMMARY");

    items.push({
      path: entry.path,
      currentRevision,
      auditedRevision,
      reason: auditedRevision === null ? "never-audited" : "revision-threshold-crossed",
      moduleContract,
      changeSummary,
    });
  }

  items.sort((a, b) => a.path.localeCompare(b.path));

  context.logger.info(`[compass.audit.plan] threshold=${threshold}, due=${items.length}`);

  return {
    data: { threshold, dueCount: items.length, items },
    exitCode: 0,
    summary: `[compass.audit.plan] ${items.length} files due for audit (threshold=${threshold})`,
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
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

  const existingPaths = new Set(ledger.entries.map((e) => e.path));
  let seededCount = 0;

  for (const entry of authored) {
    if (existingPaths.has(entry.path)) {
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
  }>
> {
  const strict = input.flags["strict"] === true;
  const scanRoot = resolveCompassScanRoot(input, context);
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);
  const authored = getAuthoredEntries(entries);
  const ledger = await loadLedger(context.workspaceRoot);

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

  for (const entry of authored) {
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

  return {
    data: { strict, dueCount, diagnostics },
    exitCode: hasErrors ? 1 : 0,
    summary: dueCount > 0 ? undefined : `[compass.audit.validate] OK (0 files overdue)`,
  };
}
