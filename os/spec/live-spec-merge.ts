/*
<MODULE_CONTRACT>
<purpose>spec.live.merge handler — extracts deltas from an RFC's ## Design section,
classifies them as ADDED/MODIFIED/REMOVED, applies to a living spec with RFC-namespaced
headings, and writes atomically (RFC-0711). Idempotent since RFC-1230: an RFC already
present in spec history[] is skipped as already-merged unless --force re-merges it.</purpose>
<non-goals>
  <item>Do not handle docs.archive integration — that is in core.module.ts.</item>
  <item>Do not validate living specs — that is spec.live.validate.</item>
  <item>Do not repair corrupted specs — that is spec.live.rebuild.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.merge handler with delta extraction, classification, and atomic writes.</item>
  <item>RFC-0957: namespace headings by RFC ID, remove conflict detection (structurally impossible with namespacing).</item>
  <item>RFC-1230: idempotent merge — already-merged gate keyed on spec history[], --force surgical re-merge via removeNamespacedSections, fail-fast on spec file with unparseable frontmatter; pure helpers moved to live-spec-shared.ts.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import { existsSync } from "../../src/utils/sync-fs.ts";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import { writeFileIfChanged, buildGeneratedHeader } from "../../src/utils/index.ts";
import { parseRfcFile } from "../rfc/frontmatter-io.ts";
import { RFC_DIR } from "../rfc/types.ts";
import type {
  LivingSpec,
  DeltaOperation,
  SpecLiveMergeResult,
} from "./live-spec-types.ts";
import {
  LIVE_SPECS_DIR,
  extractDesignSection,
  parseHeadings,
  deriveDomain,
  parseLivingSpec,
  serializeLivingSpec,
  findHeadingInSpec,
  applyDeltasToSpecBody,
  namespaceHeadings,
  removeNamespacedSections,
  findRfcFile,
  seedSpecPrefix,
} from "./live-spec-shared.ts";

export async function runSpecLiveMerge(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecLiveMergeResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcId = String(input.flags["id"] ?? "");
  const force = input.flags["force"] === true;
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  if (!rfcId) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: "spec.live.merge: --id flag is required",
    };
  }

  const rfcDir = path.join(workspaceRoot, RFC_DIR);
  const rfcFile = await findRfcFile(rfcDir, rfcId);

  if (!rfcFile) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: `spec.live.merge: RFC ${rfcId} not found in ${RFC_DIR}`,
    };
  }

  const rfcContent = await fs.readFile(path.join(rfcDir, rfcFile));
  const parsed = parseRfcFile(rfcContent);
  const fm = parsed.frontmatter;

  const status = String(fm["status"] ?? "").trim();
  if (status !== "implemented") {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: `spec.live.merge: RFC ${rfcId} has status "${status}", must be "implemented"`,
    };
  }

  const domain = deriveDomain(fm);
  if (!domain) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 0,
      summary: `spec.live.merge: RFC ${rfcId} has no liveSpec field — skipping (no-op)`,
    };
  }

  const rawDesignSection = extractDesignSection(parsed.body);
  if (!rawDesignSection) {
    return {
      data: {
        command: "spec.live.merge",
        domain,
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 0,
      summary: `spec.live.merge: RFC ${rfcId} has no ## Design section — skipping (no-op)`,
    };
  }

  const designSection = namespaceHeadings(rawDesignSection, rfcId);
  const rfcHeadings = parseHeadings(designSection);
  const liveSpecsDir = path.join(workspaceRoot, LIVE_SPECS_DIR);
  const specFilePath = path.join(liveSpecsDir, `${domain}.md`);

  let existingSpec: LivingSpec | null = null;
  if (existsSync(specFilePath)) {
    const specContent = await fs.readFile(specFilePath);
    existingSpec = parseLivingSpec(specContent);
    // A spec file whose frontmatter cannot be parsed must not be silently
    // overwritten by the creation path — that would discard its history[].
    if (!existingSpec) {
      return {
        data: {
          command: "spec.live.merge",
          domain,
          operation: "modified",
          deltas: [],
          conflicts: [],
          dryRun,
        },
        exitCode: 1,
        summary: `spec.live.merge: ${domain}.md exists but has no valid frontmatter — inspect or repair via spec.live.rebuild`,
      };
    }
  }

  // RFC-1230: idempotency gate — an RFC already in history[] is a no-op unless
  // --force surgically re-merges (strips its namespaced sections + old entries).
  if (existingSpec) {
    const alreadyMerged = existingSpec.history.some((h) => h.rfc === rfcId);
    if (alreadyMerged && !force) {
      const result: SpecLiveMergeResult = {
        command: "spec.live.merge",
        domain,
        operation: "already-merged",
        deltas: [],
        conflicts: [],
        dryRun,
      };
      if (outputFormat === "pretty") {
        logger.info(
          `spec.live.merge: ${rfcId} already merged into "${domain}" — skipping (use --force to re-merge)`,
        );
      }
      return {
        data: result,
        exitCode: 0,
        summary: `spec.live.merge: ${rfcId} already merged into ${domain}`,
      };
    }
    if (force) {
      existingSpec = {
        ...existingSpec,
        body: removeNamespacedSections(existingSpec.body, rfcId),
        history: existingSpec.history.filter((h) => h.rfc !== rfcId),
      };
    }
  }

  const operations: DeltaOperation[] = [];
  const today = new Date().toISOString().slice(0, 10);

  if (!existingSpec) {
    for (const heading of rfcHeadings) {
      operations.push({ type: "added", heading: heading.text, rfc: rfcId });
    }

    const header = buildGeneratedHeader({
      filePath: specFilePath,
      ownerCommand: "spec.live.merge",
      commandPrefix: "pnpm exec werkstatt run",
    });

    const newSpec: LivingSpec = {
      domain,
      title: `Living Spec: ${domain}`,
      lastMergedRfc: rfcId,
      updatedAt: today,
      createdAt: today,
      history: [{ rfc: rfcId, mergedAt: today, operation: "created" }],
      body: `${seedSpecPrefix(domain, header)}${designSection}`,
    };

    if (!dryRun) {
      await fs.mkdir(liveSpecsDir);
      await writeFileIfChanged(specFilePath, serializeLivingSpec(newSpec));
    }

    const result: SpecLiveMergeResult = {
      command: "spec.live.merge",
      domain,
      operation: "created",
      deltas: operations,
      conflicts: [],
      dryRun,
    };

    if (outputFormat === "pretty") {
      logger.success(
        `spec.live.merge: created living spec for domain "${domain}" from ${rfcId} (${operations.length} deltas)${dryRun ? " [dry-run]" : ""}`,
      );
    }

    return { data: result, exitCode: 0, summary: `spec.live.merge: created ${domain} from ${rfcId}`, nextSteps: [{ action: `Validate the living spec: pnpm exec forge run spec.live.validate`, kind: "optional" }] };
  }

  for (const heading of rfcHeadings) {
    const existing = findHeadingInSpec(existingSpec, heading.text);
    if (existing) {
      operations.push({ type: "modified", heading: heading.text, rfc: rfcId });
    } else {
      operations.push({ type: "added", heading: heading.text, rfc: rfcId });
    }
  }

  const updatedBody = applyDeltasToSpecBody(existingSpec.body, rfcHeadings, operations);

  const updatedSpec: LivingSpec = {
    ...existingSpec,
    lastMergedRfc: rfcId,
    updatedAt: today,
    history: [
      ...existingSpec.history,
      { rfc: rfcId, mergedAt: today, operation: "modified" },
    ],
    body: updatedBody,
  };

  if (!dryRun) {
    await writeFileIfChanged(specFilePath, serializeLivingSpec(updatedSpec));
  }

  const result: SpecLiveMergeResult = {
    command: "spec.live.merge",
    domain,
    operation: "modified",
    deltas: operations,
    conflicts: [],
    dryRun,
  };

  if (outputFormat === "pretty") {
    logger.success(
      `spec.live.merge: modified living spec for domain "${domain}" from ${rfcId} (${operations.length} deltas)${dryRun ? " [dry-run]" : ""}`,
    );
  }

  return { data: result, exitCode: 0, summary: `spec.live.merge: modified ${domain} from ${rfcId}`, nextSteps: [{ action: `Validate the living spec: pnpm exec forge run spec.live.validate`, kind: "optional" }] };
}
