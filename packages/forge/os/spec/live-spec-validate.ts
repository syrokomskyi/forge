/*
<MODULE_CONTRACT>
<purpose>spec.live.validate handler — validates all living specs in docs/specs/live/
with rules V-LS-01..05 (RFC-0711).</purpose>
<non-goals>
  <item>Do not merge or list — use spec.live.merge / spec.live.list.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.validate handler with V-LS-01..05 rules.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import { listRfcFiles, readAndParseRfc } from "../rfc/frontmatter-io.ts";
import { RFC_DIR } from "../rfc/types.ts";
import type {
  LivingSpecViolation,
  SpecLiveValidateResult,
  LivingSpecHistoryEntry,
} from "./live-spec-types.ts";

const LIVE_SPECS_DIR = "docs/specs/live";

const REQUIRED_FM_FIELDS = ["domain", "title", "lastMergedRfc", "updatedAt", "createdAt", "history"];

export async function runSpecLiveValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecLiveValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const liveSpecsDir = path.join(workspaceRoot, LIVE_SPECS_DIR);
  const rfcDir = path.join(workspaceRoot, RFC_DIR);

  const violations: LivingSpecViolation[] = [];
  let specsChecked = 0;

  const domains = new Set<string>();

  const archivedRfcIds = new Set<string>();
  const rfcFiles = await listRfcFiles(rfcDir);
  for (const file of rfcFiles) {
    const parsed = await readAndParseRfc(rfcDir, file);
    if (parsed) {
      const id = String(parsed.parsed.frontmatter["id"] ?? "").trim();
      const status = String(parsed.parsed.frontmatter["status"] ?? "").trim();
      if (id && (status === "implemented" || status === "rejected" || status === "superseded")) {
        archivedRfcIds.add(id);
      }
    }
  }

  if (!existsSync(liveSpecsDir)) {
    const result: SpecLiveValidateResult = {
      command: "spec.live.validate",
      status: "pass",
      violations: [],
      specsChecked: 0,
    };
    if (outputFormat === "pretty") {
      logger.info("spec.live.validate: no living specs directory — pass (empty)");
    }
    return {
      data: result,
      exitCode: 0,
      summary: "spec.live.validate: 0 living specs — pass",
    };
  }

  const files = await fs.readdir(liveSpecsDir);
  const specFiles = files.filter((f) => f.endsWith(".md") && f !== "README.md");

  for (const file of specFiles) {
    specsChecked++;
    const filePath = path.join(liveSpecsDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      violations.push({ rule: "V-LS-01", message: `${file}: no valid frontmatter block`, domain: file });
      continue;
    }

    const fm = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
    const domain = String(fm["domain"] ?? "");

    for (const field of REQUIRED_FM_FIELDS) {
      if (!(field in fm) || fm[field] === undefined || fm[field] === null) {
        violations.push({
          rule: "V-LS-01",
          message: `${file}: missing required field "${field}"`,
          domain,
        });
      }
    }

    if (domain && file !== `${domain}.md`) {
      violations.push({
        rule: "V-LS-02",
        message: `${file}: domain "${domain}" does not match filename`,
        domain,
      });
    }

    const lastMergedRfc = String(fm["lastMergedRfc"] ?? "");
    if (lastMergedRfc && !archivedRfcIds.has(lastMergedRfc)) {
      violations.push({
        rule: "V-LS-03",
        message: `${file}: lastMergedRfc "${lastMergedRfc}" is not an archived RFC`,
        domain,
      });
    }

    const history = Array.isArray(fm["history"]) ? (fm["history"] as LivingSpecHistoryEntry[]) : [];
    for (const entry of history) {
      if (entry.rfc && !archivedRfcIds.has(entry.rfc)) {
        violations.push({
          rule: "V-LS-04",
          message: `${file}: history entry "${entry.rfc}" is not an archived RFC`,
          domain,
        });
      }
    }

    if (domain) {
      if (domains.has(domain)) {
        violations.push({
          rule: "V-LS-05",
          message: `duplicate domain "${domain}" found in multiple files`,
          domain,
        });
      }
      domains.add(domain);
    }
  }

  const hasFailures = violations.length > 0;
  const result: SpecLiveValidateResult = {
    command: "spec.live.validate",
    status: hasFailures ? "fail" : "pass",
    violations,
    specsChecked,
  };

  if (outputFormat === "pretty") {
    if (hasFailures) {
      logger.error(`spec.live.validate: ${violations.length} violation(s) across ${specsChecked} spec(s)`);
      for (const v of violations) {
        logger.error(`  ${v.rule}: ${v.message}`);
      }
    } else {
      logger.success(`spec.live.validate: all ${specsChecked} living spec(s) pass`);
    }
  }

  return {
    data: result,
    exitCode: hasFailures ? 1 : 0,
    summary: hasFailures
      ? `spec.live.validate: ${violations.length} violation(s)`
      : `spec.live.validate: ${specsChecked} spec(s) — pass`,
  };
}
