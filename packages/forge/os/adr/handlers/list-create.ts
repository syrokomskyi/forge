/*
<MODULE_CONTRACT>
<purpose>ADR list and create handlers mirroring the RFC domain.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: create ADR list and create handlers mirroring the RFC domain.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { toKebabCase } from "../../../src/utils/string-utils.ts";
import { listAdrFiles, readAndParseAdr } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type {
  AdrListEntry,
  AdrListResult,
  AdrCreateResult,
  AdrStatus,
  AdrScope,
} from "../types.ts";
import { ADR_DIR, ADR_TEMPLATE_FILE, ADR_SCOPES, ADR_STATUSES } from "../types.ts";

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runAdrList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdrListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const adrDirPath = path.join(workspaceRoot, ADR_DIR);

  const filterStatus = input.flags["status"] as string | undefined;
  const filterScope = input.flags["scope"] as string | undefined;
  const filterDecider = input.flags["decider"] as string | undefined;

  const files = await listAdrFiles(adrDirPath);
  const entries: AdrListEntry[] = [];

  for (const fileName of files) {
    const result = await readAndParseAdr(adrDirPath, fileName);
    if (!result) continue;

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const status = String(fm["status"] ?? "") as AdrStatus;
    const scope = String(fm["scope"] ?? "") as AdrScope;
    const decider = String(fm["decider"] ?? "");

    if (filterStatus && status !== filterStatus) continue;
    if (filterScope && scope !== filterScope) continue;
    if (filterDecider && decider !== filterDecider) continue;

    entries.push({
      id,
      title: String(fm["title"] ?? ""),
      status,
      scope,
      decider,
      updatedAt: String(fm["updatedAt"] ?? ""),
      file: path.join(ADR_DIR, fileName),
    });
  }

  if (outputFormat === "pretty") {
    if (entries.length === 0) {
      logger.info("No ADRs found matching the given filters.");
    } else {
      logger.section(`ADRs (${entries.length})`);
      for (const entry of entries) {
        logger.info(
          `${entry.id}  ${entry.status.padEnd(12)} ${entry.scope.padEnd(10)} ${entry.decider.padEnd(20)} ${entry.title}`,
        );
      }
    }
  }

  return {
    data: {
      command: "adr.list",
      status: "ok",
      count: entries.length,
      entries,
    },
    summary: `${entries.length} ADR(s) found`,
  };
}

export async function runAdrCreate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdrCreateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const adrDirPath = path.join(workspaceRoot, ADR_DIR);

  const title = input.flags["title"] as string | undefined;
  if (!title) {
    throw new Error(
      'adr.create requires --title flag, e.g. --title="Use DuckDB for local analytics"',
    );
  }

  const scope = (input.flags["scope"] as string | undefined) ?? "package";
  const decider = (input.flags["decider"] as string | undefined) ?? "architecture";
  const status = (input.flags["status"] as string | undefined) ?? "proposed";
  const relatedRaw = input.flags["related"] as string | undefined;

  if (!ADR_SCOPES.includes(scope as AdrScope)) {
    throw new Error(`Invalid scope: ${scope}. Must be one of: ${ADR_SCOPES.join(", ")}`);
  }
  if (!ADR_STATUSES.includes(status as AdrStatus)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${ADR_STATUSES.join(", ")}`);
  }

  const files = await listAdrFiles(adrDirPath);
  let maxId = 0;
  for (const f of files) {
    const basename = path.basename(f);
    const match = basename.match(/^adr-(\d{4})/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }
  const nextNum = maxId + 1;
  const paddedNum = String(nextNum).padStart(4, "0");
  const nextSlug = `adr-${paddedNum}`;
  const nextId = `ADR-${paddedNum}`;

  const templateRelPath = ADR_TEMPLATE_FILE;
  const templatePath = path.join(workspaceRoot, templateRelPath);
  let templateContent: string;
  try {
    templateContent = await fs.readFile(templatePath, "utf-8");
  } catch {
    throw new Error(
      `ADR template not found at ${templateRelPath}. Ensure docs/adrs/ contains the template.`,
    );
  }

  const today = toIsoDate(new Date());
  const kebabTitle = toKebabCase(title);
  const fileName = `${nextSlug}-${kebabTitle}.md`;

  let content = templateContent;
  content = content.replace(/^id: ADR-0000$/m, `id: ${nextId}`);
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  content = content.replace(/^title: ".*"$/m, `title: "${escapedTitle}"`);
  content = content.replace(/^status: \w+$/m, `status: ${status}`);
  content = content.replace(/^scope: \w+$/m, `scope: ${scope}`);
  content = content.replace(/^decider: \w+$/m, `decider: ${decider}`);
  content = content.replace(/^createdAt: YYYY-MM-DD$/m, `createdAt: ${today}`);
  content = content.replace(/^updatedAt: YYYY-MM-DD$/m, `updatedAt: ${today}`);
  content = content.replace(/^# ADR-0000: .+$/m, `# ${nextId}: ${title}`);

  const relatedIds = relatedRaw
    ? relatedRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (relatedIds.length > 0) {
    content = content.replace(
      /^related:\s*\n\s*- RFC-0001\s*$/m,
      `related:\n${relatedIds.map((id) => `  - ${id}`).join("\n")}`,
    );
  } else {
    content = content.replace(/^related:\s*\n\s*- RFC-0001\s*$/m, `related: []`);
  }

  try {
    await fs.mkdir(adrDirPath, { recursive: true });
  } catch {
    // ignore
  }

  const targetPath = path.join(adrDirPath, fileName);
  await fs.writeFile(targetPath, content, "utf-8");

  const relativeFile = path.join(ADR_DIR, fileName);

  if (outputFormat === "pretty") {
    logger.success(`Created ${nextId}: ${title}`);
    logger.info(`File: ${relativeFile}`);
    logger.info(`Status: ${status} (only the named decider may change status)`);
  }

  return {
    data: {
      command: "adr.create",
      status: "ok",
      file: relativeFile,
      id: nextId,
    },
    summary: `Created ${nextId}: ${title}`,
  };
}
