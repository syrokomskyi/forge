/*
<MODULE_CONTRACT>
<purpose>
RFC-0334: rfc.supersede.propose — escalation command for blocked implementations.
Scaffolds a new draft RFC with supersedes pre-linked, conflict context, and TODO sections.
</purpose>
<non-goals>
  <item>Does not modify the blocked RFC — supersededBy is set only by humans.</item>
  <item>No automatic conflict detection — agent judgment triggers escalation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0334: initial implementation.</item>
  <item>Post-refactor hardening: supersede proposals resolve archived RFC files by basename id.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";

import { toKebabCase } from "../../../src/utils/string-utils.ts";
import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "../frontmatter-io.ts";
import { collectDecisionLog, scoreDecisions } from "../decision-log.ts";
import { RFC_DIR } from "../types.ts";
import { resolveRfcTemplate } from "./shared.ts";
import type { ConsultedDecision, RfcSupersedeProposeResult } from "../types.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { toIsoDate } from "./shared.ts";

const DNA_REGISTRY_PATH = "docs/architecture-dna.md";
const DNA_HEADING_RE = /^##\s+DNA-(\d+)\b/gm;

async function validateDnaIds(workspaceRoot: string, ids: string[]): Promise<string[]> {
  const errors: string[] = [];
  const registrySrc = await readFile(join(workspaceRoot, DNA_REGISTRY_PATH), "utf-8");
  const knownDna = new Set<string>();
  for (const m of registrySrc.matchAll(DNA_HEADING_RE)) {
    knownDna.add(`DNA-${m[1]}`);
  }
  for (const id of ids) {
    if (id.startsWith("DNA-")) {
      if (!knownDna.has(id)) {
        errors.push(`Unknown DNA invariant: ${id} (not found in ${DNA_REGISTRY_PATH}).`);
      }
    } else if (id.startsWith("RFC-")) {
      const rfcDirPath = join(workspaceRoot, RFC_DIR);
      const files = await listRfcFiles(rfcDirPath);
      const targetFile = files.find((f) => rfcFileMatchesId(f, id));
      if (!targetFile) {
        errors.push(`Unknown RFC reference: ${id} (not found in ${RFC_DIR}).`);
      }
    }
  }
  return errors;
}

export async function runRfcSupersedePropose(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcSupersedeProposeResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);

  const targetId = input.flags["id"] as string | undefined;
  const reason = input.flags["reason"] as string | undefined;
  const invariantStr = input.flags["invariant"] as string | undefined;
  const customTitle = input.flags["title"] as string | undefined;

  if (!targetId) throw new Error("rfc.supersede.propose requires --id flag (e.g. --id RFC-0322).");
  if (!reason) throw new Error("rfc.supersede.propose requires --reason flag.");
  if (!invariantStr)
    throw new Error(
      "rfc.supersede.propose requires --invariant flag (comma-separated DNA-N or RFC-XXXX).",
    );

  // Parse and validate invariant ids
  const invariantIds = invariantStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const idRe = /^(DNA-\d+|RFC-\d{4})$/;
  for (const id of invariantIds) {
    if (!idRe.test(id)) {
      throw new Error(`Malformed invariant id: "${id}". Must match DNA-N or RFC-XXXX.`);
    }
  }

  // Validate invariants exist
  const invariantErrors = await validateDnaIds(workspaceRoot, invariantIds);
  if (invariantErrors.length > 0) {
    throw new Error(invariantErrors.join(" "));
  }

  // Find and validate target RFC
  const files = await listRfcFiles(rfcDirPath);
  const targetFile = files.find((f) => rfcFileMatchesId(f, targetId));
  if (!targetFile) {
    throw new Error(`Target RFC ${targetId} not found. Use rfc.list to see available RFCs.`);
  }

  const targetParsed = await readAndParseRfc(rfcDirPath, targetFile);
  if (!targetParsed) {
    throw new Error(`Could not parse target RFC ${targetId}.`);
  }
  const targetFm = targetParsed.parsed.frontmatter;
  const targetStatus = String(targetFm["status"] ?? "");
  const targetTitle = String(targetFm["title"] ?? "");

  if (targetStatus !== "accepted" && targetStatus !== "implemented") {
    if (targetStatus === "draft" || targetStatus === "reviewing") {
      throw new Error(
        `Target ${targetId} has status "${targetStatus}" — it is not decided yet. Record the concern in review, not via supersession.`,
      );
    }
    throw new Error(`Target ${targetId} has status "${targetStatus}" — it is already closed.`);
  }

  // Determine next RFC id
  let maxId = 0;
  for (const f of files) {
    const bn = basename(f);
    const match = bn.match(/^rfc-(\d{4})/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }
  const nextNum = maxId + 1;
  const paddedNum = String(nextNum).padStart(4, "0");
  const nextSlug = `rfc-${paddedNum}`;
  const nextId = `RFC-${paddedNum}`;

  // Read template
  const templatePath = resolveRfcTemplate(workspaceRoot);
  let templateContent: string;
  try {
    templateContent = await readFile(templatePath, "utf-8");
  } catch {
    throw new Error(`RFC template not found at ${templatePath}.`);
  }

  const today = toIsoDate(new Date());
  const title = customTitle ?? `Supersede ${targetId}: ${targetTitle}`;
  const kebabTitle = toKebabCase(title);
  const fileName = `${nextSlug}-${kebabTitle}.md`;

  // Decision-log consultation (RFC-0329)
  let consultedDecisions: ConsultedDecision[] = [];
  try {
    const logEntries = await collectDecisionLog(rfcDirPath);
    consultedDecisions = scoreDecisions(title, logEntries);
  } catch {
    // graceful degradation
  }

  // Build consultation block
  const invariantList = invariantIds.join(", ");
  const targetFileRel = join(RFC_DIR, targetFile);
  const consultationBlock = `## Context

> **Consultation request (generated by rfc.supersede.propose, ${today})**
>
> - **Blocked RFC:** ${targetId} — "${targetTitle}" (status: ${targetStatus}, ${targetFileRel})
> - **Violated invariant(s):** ${invariantList}
> - **Reason:** ${reason}
> - **Requested decision:** accept this replacement, reject it with clarification, or amend ${targetId}.

TODO(agent): expand — what was attempted, where exactly the conflict surfaces (file paths, contract clauses), and why no conforming implementation exists.`;

  // Build frontmatter seeds
  const supersedesYaml = `supersedes:\n  - ${targetId}`;
  const relatedYaml = `related:\n${invariantIds.map((id) => `  - ${id}`).join("\n")}`;

  // Apply replacements
  let content = templateContent;
  content = content.replace(/^id: RFC-0000$/m, `id: ${nextId}`);
  content = content.replace(/^title: ".*"$/m, `title: "${title}"`);
  content = content.replace(/^kind: \w+$/m, `kind: architecture`);
  content = content.replace(/^scope: \w+$/m, `scope: workspace`);
  content = content.replace(/^createdAt: YYYY-MM-DD$/m, `createdAt: ${today}`);
  content = content.replace(/^updatedAt: YYYY-MM-DD$/m, `updatedAt: ${today}`);
  content = content.replace(/^# RFC-0000: .+$/m, `# ${nextId}: ${title}`);

  // Replace supersedes
  content = content.replace(/^supersedes: \[\]$/m, supersedesYaml);

  // Replace related
  content = content.replace(/^related:\n(  # .*\n)*$/m, relatedYaml);

  // Replace Context section with consultation block
  content = content.replace(/## Context\n[\s\S]*?(?=\n## )/, consultationBlock);

  // Replace Decision section with TODO
  content = content.replace(
    /## Decision\n[\s\S]*?(?=\n## )/,
    `## Decision\n\nTODO(agent): describe the replacement decision that resolves the conflict without violating ${invariantList}.`,
  );

  // Write the file
  const targetPath = join(rfcDirPath, fileName);
  await writeFileAtomic(targetPath, content);

  const relativeFile = join(RFC_DIR, fileName);

  if (outputFormat === "pretty") {
    logger.success(`Created ${nextId}: ${title}`);
    logger.info(`File: ${relativeFile}`);
    logger.info("");
    logger.warn(
      `ESCALATION: human decision required — ${targetId} conflicts with ${invariantList}. ` +
        `Draft created: ${relativeFile}. Implementation of ${targetId} is halted until a human accepts, rejects, or clarifies.`,
    );
    if (consultedDecisions.length > 0) {
      logger.info("Prior decisions to consult:");
      for (const d of consultedDecisions) {
        logger.info(`  ${d.rfcId} [${d.kind}] (score ${d.score}): ${d.title}`);
      }
    }
  }

  return {
    data: {
      command: "rfc.supersede.propose",
      status: "ok",
      file: relativeFile,
      id: nextId,
      supersedesTarget: targetId,
      invariants: invariantIds,
      consultedDecisions,
    },
    summary: `Created ${nextId} proposing to supersede ${targetId} (conflict: ${invariantList})`,
  };
}
