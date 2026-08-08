/*
<MODULE_CONTRACT>
<purpose>Maintains packages/os/site-kernel/src/rfc/handlers/list-create.ts as an authored site-kernel authored module so agents can evolve it without rediscovering local boundaries.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted list and create handlers from handlers.ts into handlers/list-create.ts.</item>
  <item>Post-refactor hardening: require explicit satisfies DNA traces for new architecture/contract RFC drafts.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { toKebabCase } from "../../../src/utils/string-utils.ts";
import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type {
  RfcListEntry,
  RfcListResult,
  RfcCreateResult,
  RfcNextIdResult,
  RfcStatus,
  RfcKind,
  RfcScope,
} from "../types.ts";
import { RFC_DIR, RFC_KINDS, RFC_SCOPES, RFC_METADATA_CUTOFF } from "../types.ts";
import { DNA_DOCS, loadInvariantIds, toIsoDate, resolveRfcTemplate } from "./shared.ts";
import { collectDecisionLog, scoreDecisions } from "../decision-log.ts";
import type { ConsultedDecision } from "../types.ts";

function parseSatisfiesFlag(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function assertSatisfiesIdsExist(workspaceRoot: string, satisfies: string[]): Promise<void> {
  if (satisfies.length === 0) return;

  const validDnaIds = await loadInvariantIds(workspaceRoot, DNA_DOCS, "DNA");
  const errors: string[] = [];

  for (const id of satisfies) {
    if (!/^DNA-\d+$/.test(id)) {
      errors.push(`Malformed satisfies entry: "${id}". Must match DNA-N.`);
      continue;
    }
    if (!validDnaIds.has(parseInt(id.slice(4), 10))) {
      errors.push(`Unknown DNA invariant: ${id} (not found in ${DNA_DOCS.join(", ")}).`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

export async function runRfcList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const filterStatus = input.flags["status"] as string | undefined;
  const filterKind = input.flags["kind"] as string | undefined;
  const filterOwner = input.flags["owner"] as string | undefined;

  const files = await listRfcFiles(rfcDirPath);
  const entries: RfcListEntry[] = [];

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) continue;

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const status = String(fm["status"] ?? "") as RfcStatus;
    const kind = String(fm["kind"] ?? "") as RfcKind;
    const scope = String(fm["scope"] ?? "") as RfcScope;
    const owners = Array.isArray(fm["owners"]) ? (fm["owners"] as string[]) : [];

    if (filterStatus && status !== filterStatus) continue;
    if (filterKind && kind !== filterKind) continue;
    if (filterOwner && !owners.includes(filterOwner)) continue;

    entries.push({
      id,
      title: String(fm["title"] ?? ""),
      status,
      kind,
      scope,
      owners,
      createdAt: String(fm["createdAt"] ?? ""),
      updatedAt: String(fm["updatedAt"] ?? ""),
      file: path.join(RFC_DIR, fileName),
    });
  }

  if (outputFormat === "pretty") {
    if (entries.length === 0) {
      logger.info("No RFCs found matching the given filters.");
    } else {
      logger.section(`RFCs (${entries.length})`);
      for (const entry of entries) {
        const ownerStr = entry.owners.join(", ");
        logger.info(
          `${entry.id}  ${entry.status.padEnd(12)} ${entry.kind.padEnd(14)} ${entry.title}  [${ownerStr}]`,
        );
      }
    }
  }

  return {
    data: {
      command: "rfc.list",
      status: "ok",
      count: entries.length,
      entries,
    },
    summary: `${entries.length} RFC(s) found`,
  };
}

export async function runRfcCreate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcCreateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const title = input.flags["title"] as string | undefined;
  if (!title) {
    throw new Error(
      'rfc.create requires --title flag, e.g. --title "Add structure.validate command"',
    );
  }

  const kind = (input.flags["kind"] as string | undefined) ?? "architecture";
  const scope = (input.flags["scope"] as string | undefined) ?? "workspace";
  const satisfies = parseSatisfiesFlag(input.flags["satisfies"]);

  if (!RFC_KINDS.includes(kind as RfcKind)) {
    throw new Error(`Invalid kind: ${kind}. Must be one of: ${RFC_KINDS.join(", ")}`);
  }
  if (!RFC_SCOPES.includes(scope as RfcScope)) {
    throw new Error(`Invalid scope: ${scope}. Must be one of: ${RFC_SCOPES.join(", ")}`);
  }

  const today = toIsoDate(new Date());
  const requiresSatisfies =
    today >= RFC_METADATA_CUTOFF && (kind === "architecture" || kind === "contract");

  if (requiresSatisfies && satisfies.length === 0) {
    throw new Error(
      `rfc.create requires --satisfies DNA-N for ${kind} RFCs created on or after ${RFC_METADATA_CUTOFF} (RFC-0331).`,
    );
  }
  await assertSatisfiesIdsExist(workspaceRoot, satisfies);

  const files = await listRfcFiles(rfcDirPath);
  let maxId = 0;
  for (const f of files) {
    const basename = path.basename(f);
    const match = basename.match(/^rfc-(\d{4})/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }
  const nextNum = maxId + 1;
  const paddedNum = String(nextNum).padStart(4, "0");
  const nextSlug = `rfc-${paddedNum}`;
  const nextId = `RFC-${paddedNum}`;

  const templatePath = resolveRfcTemplate(workspaceRoot);
  let templateContent: string;
  try {
    templateContent = await fs.readFile(templatePath, "utf-8");
  } catch {
    throw new Error(`RFC template not found at ${templatePath}.`);
  }

  const kebabTitle = toKebabCase(title);
  const fileName = `${nextSlug}-${kebabTitle}.md`;

  // RFC-0329: consult decision log before scaffolding
  let consultedDecisions: ConsultedDecision[] = [];
  try {
    const logEntries = await collectDecisionLog(rfcDirPath);
    consultedDecisions = scoreDecisions(title, logEntries);
  } catch {
    // graceful degradation — never block creation
  }

  if (outputFormat === "pretty") {
    if (consultedDecisions.length > 0) {
      logger.info("Prior decisions to consult:");
      for (const d of consultedDecisions) {
        logger.info(`  ${d.rfcId} [${d.kind}] (score ${d.score}): ${d.title}`);
      }
    } else {
      logger.info("No related prior decisions found.");
    }
  }

  let content = templateContent;
  content = content.replace(/^id: RFC-0000$/m, `id: ${nextId}`);
  content = content.replace(/^title: ".*"$/m, `title: "${title}"`);
  content = content.replace(/^kind: \w+$/m, `kind: ${kind}`);
  content = content.replace(/^scope: \w+$/m, `scope: ${scope}`);
  content = content.replace(/^createdAt: YYYY-MM-DD$/m, `createdAt: ${today}`);
  content = content.replace(/^updatedAt: YYYY-MM-DD$/m, `updatedAt: ${today}`);
  if (satisfies.length > 0) {
    content = content.replace(
      /^satisfies: \[\]$/m,
      `satisfies:\n${satisfies.map((id) => `  - ${id}`).join("\n")}`,
    );
  }
  content = content.replace(/^# RFC-0000: .+$/m, `# ${nextId}: ${title}`);

  const targetPath = path.join(rfcDirPath, fileName);
  await fs.writeFile(targetPath, content, "utf-8");

  const relativeFile = path.join(RFC_DIR, fileName);

  if (outputFormat === "pretty") {
    logger.success(`Created ${nextId}: ${title}`);
    logger.info(`File: ${relativeFile}`);
    logger.info(`Template: full`);
    logger.info("Status: draft (only a human with role 'architecture' may change status)");
  }

  return {
    data: {
      command: "rfc.create",
      status: "ok",
      file: relativeFile,
      id: nextId,
      satisfies,
      consultedDecisions,
    },
    summary: `Created ${nextId}: ${title}`,
  };
}

export async function runRfcNextId(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcNextIdResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const files = await listRfcFiles(rfcDirPath);
  let maxId = 0;
  for (const f of files) {
    const basename = path.basename(f);
    const match = basename.match(/^rfc-(\d{4})/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }

  const nextNumber = maxId + 1;
  const paddedNum = String(nextNumber).padStart(4, "0");
  const nextId = `RFC-${paddedNum}`;
  const maxExistingId = maxId > 0 ? `RFC-${String(maxId).padStart(4, "0")}` : "none";

  if (outputFormat === "pretty") {
    logger.info(`Next free RFC number: ${nextId} (scanned ${files.length} files)`);
  }

  return {
    data: {
      command: "rfc.next-id",
      nextId,
      nextNumber,
      maxExistingId,
      scannedFiles: files.length,
    },
    summary: `Next RFC number: ${nextId}`,
  };
}
