/*
<MODULE_CONTRACT>
<purpose>Maintains packages/os/site-kernel/src/rfc/handlers/list-create.ts as an authored site-kernel authored module so agents can evolve it without rediscovering local boundaries.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1139: CLI hint accuracy and agent-safety hygiene — rfc.create hint, EC-14-PARTIAL, amend delegation, ledger scope, sync footer, mission.open remnants</item>
  <item>RFC-1139: second hint fix (rfc.list empty-state) + read-only test fix</item>
  <item>RFC-1364: robust rfc index generation — bounded retry, RFC-IDX-04, atomic writes</item>
  <item>RFC-1467: block rfc.create on terminal-kind near-duplicates until --revisit acknowledges + V-52 validate mirror</item>
  <item>RFC-1467: address review r1 findings — object-shaped colliding payload, cite all colliding siblings, reviewBand field, supersede.propose escalation, flag-shape guard</item>
  <history>RFC-0303, RFC-1097, RFC-1138</history>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../../src/utils/io.ts";
import { writeFileSync } from "../../../src/utils/sync-fs.ts";
import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { existsSync } from "node:fs";
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
import {
  collectDecisionLog,
  scoreDecisions,
  REPROPOSED_SCORE,
  REVIEW_SCORE,
  TERMINAL_KINDS,
} from "../decision-log.ts";
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
  const filterBatch = input.flags["batch"] as string | undefined;

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
    if (filterBatch && String(fm["batch"] ?? "") !== filterBatch) continue;

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
      batch: fm["batch"] ? String(fm["batch"]) : undefined,
      dependsOn: Array.isArray(fm["dependsOn"]) ? (fm["dependsOn"] as string[]) : undefined,
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
    nextSteps:
      entries.length === 0
        ? [
            {
              action: `Create a new RFC: pnpm exec werkstatt run rfc.create --title "..."`,
              kind: "optional",
            },
          ]
        : undefined,
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

  const templatePath = resolveRfcTemplate(workspaceRoot);
  let templateContent: string;
  try {
    templateContent = await fs.readFile(templatePath);
  } catch {
    throw new Error(`RFC template not found at ${templatePath}.`);
  }

  const kebabTitle = toKebabCase(title);

  // RFC-0329: consult decision log before scaffolding. RFC-1467: scoring
  // runs untruncated for the collision bands — the `consultedDecisions`
  // payload stays capped at the display limit.
  let consultedDecisions: ConsultedDecision[] = [];
  let scoredAll: ConsultedDecision[] = [];
  try {
    const logEntries = await collectDecisionLog(rfcDirPath);
    scoredAll = scoreDecisions(title, logEntries, Number.MAX_SAFE_INTEGER);
    consultedDecisions = scoredAll.slice(0, 5);
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

  // RFC-1467: near-duplicate gate — terminal-kind hits (rejected-rfc /
  // superseded-rfc) at or above the reproposal threshold block creation
  // until --revisit acknowledges one of the colliding ids; the review band
  // (REVIEW_SCORE..REPROPOSED_SCORE-1) cites hits via `related` + a NEEDS
  // CLARIFICATION marker. rejected-alternative stays informational.
  const revisitRaw = input.flags["revisit"];
  const revisit =
    typeof revisitRaw === "string" ? revisitRaw.trim().toUpperCase() || undefined : undefined;
  // Best-score-per-id — the same RFC can collide via multiple log entries.
  const byId = (hits: ConsultedDecision[]): ConsultedDecision[] => {
    const best = new Map<string, ConsultedDecision>();
    for (const h of hits) {
      const prev = best.get(h.rfcId);
      if (!prev || h.score > prev.score) best.set(h.rfcId, h);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.rfcId.localeCompare(b.rfcId));
  };
  const colliding = byId(
    scoredAll.filter((d) => TERMINAL_KINDS.has(d.kind) && d.score >= REPROPOSED_SCORE),
  );
  const collidingIds = colliding.map((d) => d.rfcId);
  const reviewBand = byId(
    scoredAll.filter(
      (d) =>
        TERMINAL_KINDS.has(d.kind) && d.score >= REVIEW_SCORE && d.score < REPROPOSED_SCORE,
    ),
  );
  const reviewBandIds = reviewBand.map((d) => d.rfcId);

  if (revisit && !collidingIds.includes(revisit)) {
    const remedy =
      collidingIds.length > 0
        ? `--revisit must name a colliding precedent — valid candidates: ${collidingIds.join(", ")}.`
        : "No terminal-kind precedent collides with this title — drop --revisit and scaffold normally.";
    if (outputFormat === "pretty") {
      logger.error(`rfc.create refused: ${remedy}`);
    }
    return {
      data: {
        command: "rfc.create",
        status: "blocked",
        blocked: true,
        colliding,
        remedy,
        consultedDecisions,
      },
      summary: `rfc.create refused: ${remedy}`,
      exitCode: 1,
    };
  }

  if (collidingIds.length > 0 && !revisit) {
    const remedy =
      `Re-run with --revisit ${collidingIds[0]} to acknowledge the precedent — the scaffold will cite it ` +
      `in related with a NEEDS CLARIFICATION marker and the draft's Decision must state why it differs ` +
      `from the rejection/supersession rationale. If this is genuinely different work, sharpen the title ` +
      `so it no longer collides at the reproposal threshold (score ≥ ${REPROPOSED_SCORE}).`;
    if (outputFormat === "pretty") {
      logger.error(
        `rfc.create blocked: ${collidingIds.length} terminal precedent(s) collide — ${collidingIds.join(", ")}`,
      );
      logger.error(remedy);
    }
    return {
      data: {
        command: "rfc.create",
        status: "blocked",
        blocked: true,
        colliding,
        remedy,
        consultedDecisions,
      },
      summary: `rfc.create blocked: terminal precedent ${collidingIds.join(", ")} collides — re-run with --revisit ${collidingIds[0]} to acknowledge`,
      exitCode: 1,
    };
  }

  // Ids cited in the scaffold's `related`: EVERY colliding precedent (a
  // --revisit acknowledges the gate, but sibling collisions still need
  // citation or the draft is born failing V-52) plus every review-band hit.
  const citedIds = [...new Set([...collidingIds, ...reviewBandIds])].sort();

  // RFC-1138: atomic id allocation — scan → claim the id via wx on a
  // title-independent `rfc-NNNN.claim` file → write the real file → release.
  // The claim must be on the id, not the filename: two creates with different
  // titles produce different filenames, so a wx write on the target path can
  // never collide. `.claim` files are invisible to listRfcFiles (.md-only),
  // so they don't pollute rfc.list or the maxId scan. Stale claims (crashed
  // create) are reclaimed after CLAIM_STALE_MS.
  const MAX_CREATE_ATTEMPTS = 10;
  const CLAIM_STALE_MS = 30_000;
  let nextId = "";
  let relativeFile = "";
  let allocated = false;

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
  let candidate = maxId + 1;

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
    const paddedNum = String(candidate).padStart(4, "0");
    const nextSlug = `rfc-${paddedNum}`;
    nextId = `RFC-${paddedNum}`;
    const fileName = `${nextSlug}-${kebabTitle}.md`;
    const claimPath = path.join(rfcDirPath, `${nextSlug}.claim`);

    try {
      writeFileSync(claimPath, `${process.pid}\n`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Stale claim (crashed create) → reclaim and retry the same id.
        // Live claim → another create holds this id — move to the next.
        const st = await fs.stat(claimPath).catch(() => null);
        if (st && Date.now() - st.mtimeMs > CLAIM_STALE_MS) {
          await fs.rm(claimPath);
        } else {
          candidate++;
        }
        continue;
      }
      throw err;
    }

    try {
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
      // RFC-1467: cite the acknowledged/review-band precedents in `related`
      // and leave a NEEDS CLARIFICATION marker in the Decision section.
      if (citedIds.length > 0) {
        const relatedEntries = citedIds.map((id) => `  - ${id}`).join("\n");
        content = /^related:$/m.test(content)
          ? content.replace(/^related:$/m, `related:\n${relatedEntries}`)
          : content.replace(/^related: \[\]$/m, `related:\n${relatedEntries}`);
        const siblingCollisions = collidingIds.filter((id) => id !== revisit);
        const marker = revisit
          ? `> NEEDS CLARIFICATION: ${revisit} is a rejected/superseded precedent acknowledged via --revisit — the Decision must state why this proposal differs from the earlier rejection or supersession rationale.` +
            (siblingCollisions.length > 0
              ? `\n> NEEDS CLARIFICATION: additional terminal precedent(s) ${siblingCollisions.join(", ")} collide at the reproposal threshold — the Decision must also distinguish them.`
              : "") +
            (reviewBandIds.length > 0
              ? `\n> NEEDS CLARIFICATION: near-duplicate precedent(s) ${reviewBandIds.join(", ")} scored in the review band — cite them or distinguish scope in the Decision.`
              : "")
          : `> NEEDS CLARIFICATION: near-duplicate precedent(s) ${reviewBandIds.join(", ")} scored in the review band — cite them or distinguish scope in the Decision.`;
        content = content.replace(/^## Decision$/m, `## Decision\n\n${marker}\n`);
      }
      content = content.replace(/^# RFC-0000: .+$/m, `# ${nextId}: ${title}`);

      const targetPath = path.join(rfcDirPath, fileName);
      // RFC-1364: atomic write (temp + rename) so concurrent readers never
      // observe a half-written RFC. The claim file already guarantees single
      // id allocation; the existence check preserves the old `wx` behavior
      // of failing loudly when the target somehow exists.
      if (existsSync(targetPath)) {
        throw Object.assign(new Error(`rfc target already exists: ${fileName}`), {
          code: "EEXIST",
        });
      }
      await writeFileAtomic(targetPath, content);
      relativeFile = path.join(RFC_DIR, fileName);
      allocated = true;
    } finally {
      await fs.rm(claimPath);
    }
    if (allocated) break;
  }

  if (!allocated) {
    throw new Error(
      `rfc.create: id allocation failed after ${MAX_CREATE_ATTEMPTS} attempts — concurrent creates keep claiming the next id`,
    );
  }

  if (outputFormat === "pretty") {
    logger.success(`Created ${nextId}: ${title}`);
    logger.info(`File: ${relativeFile}`);
    logger.info(`Template: full`);
    if (revisit) {
      logger.info(`Acknowledged precedent via --revisit: ${revisit} (cited in related)`);
    }
    if (reviewBandIds.length > 0) {
      logger.info(
        `Near-duplicate precedent(s) cited in related: ${reviewBandIds.join(", ")} — distinguish or cite them in the Decision`,
      );
    }
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
      ...(colliding.length > 0 ? { colliding, blocked: false } : {}),
      ...(reviewBand.length > 0 ? { reviewBand } : {}),
    },
    summary: `Created ${nextId}: ${title}`,
    nextSteps: [
      {
        action: `Validate the RFC: pnpm exec werkstatt run rfc.validate --id ${nextId}`,
        kind: "optional",
      },
    ],
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
    nextSteps: [
      {
        action: `Create the RFC: pnpm exec forge run rfc.create --title "..."`,
        kind: "optional",
      },
    ],
  };
}
