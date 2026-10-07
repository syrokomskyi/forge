/*
<MODULE_CONTRACT>
<purpose>spec.live.validate handler — validates all living specs in docs/specs/live/
with rules V-LS-01..08 (RFC-0711, RFC-1230). Detection layer only — repair routes
to spec.live.rebuild (V-LS-06/07) or spec.live.merge --id (V-LS-08), never hand-edits.</purpose>
<non-goals>
  <item>Do not merge or list — use spec.live.merge / spec.live.list.</item>
  <item>Do not repair — validators are read-only; spec.live.rebuild is the repair path.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.validate handler with V-LS-01..05 rules.</item>
  <item>RFC-1230: added V-LS-06 (duplicate namespaced headings), V-LS-07 (duplicate history RFCs), V-LS-08 (archive coverage — implemented liveSpec RFC absent from spec history).</item>
  <item>RFC-1230: step 3 — V-LS-06/07/08 living-spec rules

V-LS-06 flags duplicated (RFC-XXXX) headings, V-LS-07 duplicated history[].rfc entries — both repair via spec.live.rebuild. V-LS-08 flags implemented liveSpec RFCs under archive/implemented/ absent from the domain spec's history (or missing spec file) — repair via spec.live.merge --id. Validator stays read-only.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com></item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import { existsSync } from "../../src/utils/sync-fs.ts";
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
import { deriveDomain, parseHeadings } from "./live-spec-shared.ts";

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
  const specsByDomain = new Map<string, { file: string; historyRfcIds: Set<string> }>();

  const archivedRfcIds = new Set<string>();
  const archivedImplementedLiveSpecRfcs: Array<{ id: string; domain: string }> = [];
  const rfcFiles = await listRfcFiles(rfcDir);
  for (const file of rfcFiles) {
    const parsed = await readAndParseRfc(rfcDir, file);
    if (parsed && 'parsed' in parsed) {
      const id = String(parsed.parsed.frontmatter["id"] ?? "").trim();
      const status = String(parsed.parsed.frontmatter["status"] ?? "").trim();
      if (id && (status === "implemented" || status === "rejected" || status === "superseded")) {
        archivedRfcIds.add(id);
      }
      // V-LS-08 tracks only RFCs physically under archive/implemented/ — an
      // implemented-but-not-yet-archived RFC must not fire a false positive.
      if (id && file.startsWith("archive/implemented/") && parsed.parsed.frontmatter["liveSpec"]) {
        const liveSpecDomain = deriveDomain(parsed.parsed.frontmatter);
        if (liveSpecDomain) {
          archivedImplementedLiveSpecRfcs.push({ id, domain: liveSpecDomain });
        }
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

  const files = (await fs.readdir(liveSpecsDir)).map((e) => e.name);
  const specFiles = files.filter((f) => f.endsWith(".md") && f !== "README.md");

  for (const file of specFiles) {
    specsChecked++;
    const filePath = path.join(liveSpecsDir, file);
    const content = await fs.readFile(filePath);
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
    const historyRfcIds = new Set<string>();
    for (const entry of history) {
      if (entry.rfc && !archivedRfcIds.has(entry.rfc)) {
        violations.push({
          rule: "V-LS-04",
          message: `${file}: history entry "${entry.rfc}" is not an archived RFC`,
          domain,
        });
      }
      if (entry.rfc) historyRfcIds.add(entry.rfc);
    }

    // V-LS-06: duplicate RFC-namespaced headings (###+ ending in ` (RFC-XXXX)`)
    // — one diagnostic per extra occurrence. Full namespaced text is compared,
    // so distinct RFCs never collide.
    const headingCounts = new Map<string, number>();
    for (const h of parseHeadings(content.slice(match[0].length))) {
      if (!/\(RFC-\d{4}\)$/.test(h.text)) continue;
      const seen = (headingCounts.get(h.text) ?? 0) + 1;
      headingCounts.set(h.text, seen);
      if (seen > 1) {
        violations.push({
          rule: "V-LS-06",
          message: `${file}: duplicate section "${h.text}" (occurrence ${seen}) — repair via spec.live.rebuild`,
          domain,
        });
      }
    }

    // V-LS-07: duplicate history[].rfc — one diagnostic per duplicated id.
    const rfcCounts = new Map<string, number>();
    for (const entry of history) {
      if (!entry.rfc) continue;
      rfcCounts.set(entry.rfc, (rfcCounts.get(entry.rfc) ?? 0) + 1);
    }
    for (const [rfcId, count] of rfcCounts) {
      if (count > 1) {
        violations.push({
          rule: "V-LS-07",
          message: `${file}: history contains ${count} entries for "${rfcId}" — repair via spec.live.rebuild`,
          domain,
        });
      }
    }

    if (domain) {
      specsByDomain.set(domain, { file, historyRfcIds });
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

  // V-LS-08 (coverage): every archived implemented RFC carrying liveSpec must
  // appear in the history[] of its domain's living spec — also fires when that
  // domain's spec file does not exist. Repair: spec.live.merge --id <rfc>.
  for (const { id, domain } of archivedImplementedLiveSpecRfcs) {
    const spec = specsByDomain.get(domain);
    if (!spec) {
      violations.push({
        rule: "V-LS-08",
        message: `${id}: living spec for domain "${domain}" does not exist — repair via spec.live.merge --id ${id}`,
        domain,
      });
    } else if (!spec.historyRfcIds.has(id)) {
      violations.push({
        rule: "V-LS-08",
        message: `${spec.file}: archived RFC "${id}" (liveSpec) is absent from history[] — repair via spec.live.merge --id ${id}`,
        domain,
      });
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
      logger.error(`spec.live.validate: ${violations.length} violation${violations.length === 1 ? "" : "s"} across ${specsChecked} spec(s)`);
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
      ? `spec.live.validate: ${violations.length} violation${violations.length === 1 ? "" : "s"}`
      : `spec.live.validate: ${specsChecked} spec(s) — pass`,
  };
}
