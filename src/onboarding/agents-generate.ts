/*
<MODULE_CONTRACT>
<purpose>forge.agents.generate — regenerates AGENTS.md deterministically from forge.yaml + skill registry. Carries the standard generated-file marker.</purpose>
<non-goals>
  <item>Do not overwrite a hand-written AGENTS.md (no generated marker) — skip with warning, continue nested (RFC-1150).</item>
  <item>Do not read or modify forge.yaml — only read it via loadForgeConfig.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
  <item>RFC-1500: step 4 — branch-model AGENTS section and consumer docs</item>
  <item>RFC-1539: amend dna-55 and dna-115 for published spec packages

Guides, fo-spec-ingest routing, command descriptions and regenerated command docs, remediation entries for SPEC-15..18 and CONF-07..09; resyncs the stale .agents fo-system-dispatch mirror (ADR-0126 source line).</item>
  <item>RFC-1573: step 6 — detach line in generated Branch model section

forge.agents.generate lists detachable forge commands from their declarations and points agents at gate.run.status --wait.</item>
  <item>RFC-1573: close review REVIEW-CODE-2026-11-12-01 findings

Restore same-line pkg-health-10 suppressions in forge bin/cli.ts (prettier-ignore) and revert unrelated registry.ts reflows; DETACH-01 also matches call sites (slice cap cut mission.close off before runMissionValidate); exempt marker anchored to a non-global line-comment regex; live-source test pins entrypoint resolution and the flow.cut/mission.close negative control; command-modules test; AC-8 literal comment; RFC Deviations DEV-1..3.</item>
  <history>RFC-0391, RFC-0393, RFC-0548, RFC-0549, RFC-0551, RFC-0611, RFC-0640, RFC-0643, RFC-0664, RFC-1097, RFC-1253, RFC-1255, RFC-1365</history>
</CHANGE_SUMMARY>
*/

import * as fs from "../utils/sync-fs.ts";
import { resolveIo } from "../utils/io.ts";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadForgeConfig, resolveBinding, resolveForgePackageRoot, resolveForgeRoot, type ForgeConfig } from "../config/forge-config.ts";
import { resolveAllTerminology } from "../profiles/terminology-utils.ts";
import { FORGE_SKILLS } from "../registry.ts";
import { alignMarkdownTable, buildGeneratedHeader, hasEditableGeneratedMarker, hasGeneratedMarker, mergeEditableGenerated, writeFileIfChanged } from "../utils/index.ts";
import { generateNestedAgentsMd } from "./nested-agents-generate.ts";
import { injectSemanticLayerBlock, semanticLayerLines } from "./compass-docs/semantic-layer-block.ts";
import { resolveWorkspaceTypes } from "./workspace-discovery.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../types.ts";

type BehavioralRegister = "business" | "creative";

/**
 * RFC-1500: the repository's command prefix for generated flow instructions —
 * derived from the first resolvable `bindings.commands` value by cutting at
 * the dotted command token (`pnpm exec forge rfc.validate …` → `pnpm exec
 * forge`; `pnpm exec werkstatt run rfc.validate …` → `pnpm exec werkstatt
 * run`). Falls back to `pnpm exec forge`.
 */
function resolveCommandPrefix(config: ForgeConfig): string {
  const candidates = [
    "commands.validateRfc",
    "commands.specValidate",
    "commands.sessionSave",
    "commands.implementStamp",
    "commands.validateAdr",
  ];
  for (const key of candidates) {
    const value = resolveBinding(config, key);
    if (typeof value !== "string" || value.trim() === "") continue;
    const tokens = value.trim().split(/\s+/);
    const idx = tokens.findIndex((t) => /^[a-z][\w-]*\.[\w.-]+$/.test(t));
    if (idx > 0) return tokens.slice(0, idx).join(" ");
  }
  return "pnpm exec forge";
}

// RFC-0643: Template placeholder substitution for {{terminology.key}} patterns
export function substituteTemplate(
  content: string,
  terminology: Record<string, string>,
): string {
  return content.replace(
    /\{\{terminology\.(\w+)\}\}/g,
    (_, key: string) => terminology[key] ?? key,
  );
}

// RFC-0643: Template context for root AGENTS.md generation
export interface TemplateContext {
  terminology: Record<string, string>;
  register: BehavioralRegister;
  domain: string | null;
  workspaceType?: string;
}

// RFC-0643: Root template paths.
// Templates ship in the tarball under src/onboarding/templates/ but tsc never
// copies .md files into dist/ — resolve via the package root so both the source
// layout (src/onboarding/) and compiled layout (dist/src/onboarding/) work.
const TEMPLATES_DIR = path.join(
  resolveForgePackageRoot(import.meta.dirname),
  "src",
  "onboarding",
  "templates",
);
const BUSINESS_ROOT_TEMPLATE = path.join(TEMPLATES_DIR, "root-agents-business.md");
const CREATIVE_ROOT_TEMPLATE = path.join(TEMPLATES_DIR, "root-agents-creative.md");

// Behavioral layer template paths
const BEHAVIORAL_LAYER_CORE_TEMPLATE = path.join(TEMPLATES_DIR, "behavioral-layer-core.md");
const BEHAVIORAL_LAYER_EXTENDED_TEMPLATE = path.join(TEMPLATES_DIR, "behavioral-layer-extended.md");

export function selectRootTemplate(
  register: BehavioralRegister,
  profile?: StackProfile,
): string {
  // Profile-driven root template (rootAgentsMdTemplate)
  if (profile?.rootAgentsMdTemplate) {
    const templateRel = profile.rootAgentsMdTemplate;
    // Path traversal guard: reject absolute paths and ..
    if (!path.isAbsolute(templateRel) && !templateRel.includes("..")) {
      const forgeRoot = resolveForgePackageRoot(import.meta.dirname);
      const profilesDir = path.join(forgeRoot, "profiles");
      const templatePath = path.resolve(profilesDir, templateRel);
      // Ensure resolved path is within profiles directory
      if (templatePath.startsWith(profilesDir + path.sep) || templatePath === profilesDir) {
        try {
          return fs.readFileSync(templatePath, "utf8");
        } catch {
          // Template file not found — fall through to register-based template
        }
      }
    }
  }
  try {
    const templatePath = register === "creative" ? CREATIVE_ROOT_TEMPLATE : BUSINESS_ROOT_TEMPLATE;
    return fs.readFileSync(templatePath, "utf8");
  } catch {
    // Template file not found — fall back to empty string (dynamic sections will still be appended)
    return "";
  }
}

function replaceProjectPlaceholders(
  template: string,
  config: ReturnType<typeof loadForgeConfig>,
  dynamicSections: string,
): string {
  let result = template;
  result = result.replace(/\{\{projectName\}\}/g, config.project.name);
  result = result.replace(/\{\{projectStack\}\}/g, config.project.stack.length > 0 ? config.project.stack.join(", ") : "(none)");
  result = result.replace(/\{\{projectPm\}\}/g, config.project.packageManager);
  result = result.replace(/\{\{rfcsDir\}\}/g, config.paths.rfcsDir);
  result = result.replace(/\{\{adrsDir\}\}/g, config.paths.adrsDir);
  result = result.replace(/\{\{plansDir\}\}/g, config.paths.plansDir);
  result = result.replace(/\{\{auditsDir\}\}/g, config.paths.auditsDir);
  result = result.replace(/\{\{specsDir\}\}/g, config.paths.specsDir);
  result = result.replace(/\{\{skillsDir\}\}/g, config.paths.skillsDir);
  result = result.replace(/\{\{dynamicSections\}\}/g, dynamicSections);
  return result;
}

function readRegister(workspaceRoot: string): BehavioralRegister {
  const prefsPath = path.join(workspaceRoot, "PREFERENCES.md");
  try {
    const content = fs.readFileSync(prefsPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      if (fm["register"] === "creative") return "creative";
    }
  } catch {
    // PREFERENCES.md missing or unreadable — default to business
  }
  return "business";
}

/** resolveForgeRoot throws when neither layout exists — routing-table
 *  extraction is best-effort, so an unresolvable root yields an empty table. */
function safeResolveForgeRoot(workspaceRoot: string): string | undefined {
  try {
    return resolveForgeRoot(workspaceRoot);
  } catch {
    return undefined;
  }
}

function extractTriggerPhrases(
  forgeRoot: string | undefined,
): Array<{ name: string; triggerPhrases: string[] }> {
  // Consumer packages have no packages/forge — the root must come from the
  // runtime context (or the installed package), never a hardcoded monorepo path.
  if (!forgeRoot) return [];
  const result: Array<{ name: string; triggerPhrases: string[] }> = [];
  for (const skill of FORGE_SKILLS) {
    if (skill.category !== "fo") continue;
    const skillPath = path.join(forgeRoot, skill.path);
    try {
      const content = fs.readFileSync(skillPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      if (Array.isArray(fm["triggerPhrases"])) {
        result.push({
          name: skill.name,
          triggerPhrases: (fm["triggerPhrases"] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          ),
        });
      }
    } catch {
      // SKILL.md not found or unreadable — skip
    }
  }
  return result;
}

// RFC-1154: emits the full aligned table (header + separator + rows) since
// column widths depend on substituted trigger rows — the template carries only
// the {{triggersTable}} placeholder, no static header lines.
function generateTriggersTable(
  triggerPhrases: Array<{ name: string; triggerPhrases: string[] }>,
): string {
  const rows: string[][] = [];
  for (const { name, triggerPhrases: skillTriggers } of triggerPhrases) {
    if (skillTriggers.length === 0) continue;
    const display = skillTriggers.map((t) => `"${t}"`).join(", ");
    rows.push([display, `\`${name}\``]);
  }
  // Always emit the header + separator — even with zero trigger rows the
  // section documents the routing contract (matches pre-RFC-1154 behavior).
  return alignMarkdownTable(["Operator says something like", "Skill"], rows) + "\n";
}

function generateBehavioralLayer(
  register: BehavioralRegister,
  forgeRoot: string | undefined,
): string {
  const triggerPhrases = extractTriggerPhrases(forgeRoot);

  let template: string;
  try {
    template = fs.readFileSync(BEHAVIORAL_LAYER_CORE_TEMPLATE, "utf8").trimEnd();
  } catch {
    return "";
  }

  const triggersTable = generateTriggersTable(triggerPhrases);

  let extendedLayer = "";
  if (register === "creative") {
    try {
      extendedLayer = fs.readFileSync(BEHAVIORAL_LAYER_EXTENDED_TEMPLATE, "utf8").trimEnd() + "\n\n";
    } catch {
      // Extended template missing — skip
    }
  }

  const result = template
    .replace(/\{\{triggersTable\}\}/g, triggersTable)
    .replace(/\{\{register\}\}/g, register)
    .replace(/\{\{extendedLayer\}\}/g, extendedLayer);

  return result;
}

interface AgentsGenerateResult {
  command: string;
  status: "pass" | "fail";
  configPath: string;
  generated: string[];
  skipped: string[];
  /** Hand-written files that accepted the marker-guarded semantic-layer block. */
  injected: string[];
  errors: string[];
  renderedFiles?: { [relPath: string]: string };
  details?: Array<{ path: string; domain?: string; register?: string; workspaceType?: string }>;
  // RFC-1150: set when the root AGENTS.md was skipped (hand-written, no marker)
  rootSkipped?: boolean;
  rootSkipReason?: string;
}

export async function runAgentsGenerate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AgentsGenerateResult>> {
  const { workspaceRoot, logger, outputFormat, dryRun } = context;
  const fio = resolveIo(context.io);

  let config;
  try {
    config = loadForgeConfig(workspaceRoot, context.forgeRoot);
  } catch (err) {
    const msg = (err as Error).message;
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: {
        command: "forge.agents.generate",
        status: "fail",
        configPath: "forge.yaml",
        generated: [],
        skipped: [],
        injected: [],
        errors: [msg],
      },
      exitCode: 1,
      summary: `forge.agents.generate: failed — ${msg}`,
    };
  }

  const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");

  // Edit guard: never overwrite a hand-written AGENTS.md — skip the root file
  // with a warning and continue to nested generation (RFC-1150, non-fatal).
  let rootSkipped = false;
  if (!dryRun && (await fio.exists(agentsMdPath))) {
    const existing = await fio.readFile(agentsMdPath);
    if (!hasGeneratedMarker(existing)) {
      rootSkipped = true;
      if (outputFormat === "pretty") {
        logger.warn(
          "AGENTS.md exists without a generated marker — skipping root file (hand-written). Nested AGENTS.md generation continues.",
        );
      }
    }
  }

  // Generate AGENTS.md content
  const header = buildGeneratedHeader({
    filePath: "AGENTS.md",
    ownerCommand: "forge.agents.generate",
    commandPrefix: "forge",
    editable: true,
  });

  // RFC-0643: determine register from PREFERENCES.md or profile
  const register = readRegister(workspaceRoot);

  // Build dynamic sections (skills table, capabilities, behavioral layer)
  const dynamicLines: string[] = [];

  // RFC-1253: Compass corpus read-first block — only when the binding
  // resolves non-empty (DNA-90: instructions live where agents read them).
  // Marker-wrapped so hand-written files that pasted it stay refreshable.
  const compassDocsReadFirst = resolveBinding(config, "paths.compassDocs");
  const semanticLayerDocs = (Array.isArray(compassDocsReadFirst) ? compassDocsReadFirst : []).filter(
    (d): d is string => typeof d === "string",
  );
  const semanticLayerBlock =
    semanticLayerDocs.length > 0 ? semanticLayerLines(semanticLayerDocs).join("\n") : "";
  if (semanticLayerBlock) {
    dynamicLines.push(semanticLayerBlock);
    dynamicLines.push("");
  }

  // Skills table (RFC-1154: emitted prettier-normal via alignMarkdownTable)
  dynamicLines.push("## Skills");
  dynamicLines.push("");
  dynamicLines.push(
    alignMarkdownTable(
      ["Name", "Category", "Invocation", "Concerns"],
      FORGE_SKILLS.map((skill) => [skill.name, skill.category, skill.invocation, skill.concerns]),
    ),
  );
  dynamicLines.push("");

  // Capabilities section (RFC-0393)
  if (config.bindings) {
    dynamicLines.push("## Capabilities");
    dynamicLines.push("");
    dynamicLines.push("Bindings resolved from `forge.yaml`:");
    dynamicLines.push("");

    const bindingKeys = [
      "commands.validateRfc",
      "commands.validateAdr",
      "commands.typecheck",
      "commands.test",
      "commands.scopedBuild",
      "commands.specValidate",
      "commands.sessionSave",
      "paths.invariantsFile",
      "paths.reviewsDir",
      "paths.handoffsDir",
      "paths.sessionsDir",
    ];

    const capabilityRows: string[][] = bindingKeys.map((key) => {
      const value = resolveBinding(config, key);
      const status = value === null ? "absent" : "resolved";
      const display = value === null ? "—" : typeof value === "string" ? `\`${value}\`` : String(value);
      return [key, status, display];
    });

    // compassDocs array
    const compassDocs = resolveBinding(config, "paths.compassDocs");
    if (Array.isArray(compassDocs) && compassDocs.length > 0) {
      capabilityRows.push(["paths.compassDocs", "resolved", compassDocs.map((d) => `\`${d}\``).join(", ")]);
    } else {
      capabilityRows.push(["paths.compassDocs", "absent", "—"]);
    }

    dynamicLines.push(alignMarkdownTable(["Key", "Status", "Value"], capabilityRows));

    // terminology
    if (config.bindings.terminology && Object.keys(config.bindings.terminology).length > 0) {
      dynamicLines.push("");
      dynamicLines.push("**Terminology:**");
      dynamicLines.push("");
      for (const [term, value] of Object.entries(config.bindings.terminology)) {
        dynamicLines.push(`- ${term}: ${value}`);
      }
    }

    dynamicLines.push("");
  }

  // Behavioral layer section (RFC-0548)
  const behavioralLayer = generateBehavioralLayer(
    register,
    context.forgeRoot ?? safeResolveForgeRoot(workspaceRoot),
  );
  dynamicLines.push(behavioralLayer);
  dynamicLines.push("");

  // RFC-0664: Project memory layer read discipline
  dynamicLines.push("## Project memory layer");
  dynamicLines.push("");
  dynamicLines.push("`.agents/memory/MEMORY.md` is the curated hot store (versioned). `.agents/memory/daily/YYYY-MM-DD.md` are append-only warm logs (git-ignored).");
  dynamicLines.push("");
  dynamicLines.push("**Session-start read discipline (advisory):** At session start, read `MEMORY.md` (always), then `daily/<today>.md` and `daily/<yesterday>.md` (if present). Older daily files are cold — use grep when a task references past context.");
  dynamicLines.push("");

  // RFC-1500 step 4: adopted repositories carry the fixed-branch-model rules —
  // emitted only when isFlowAdopted reports adoption (committed develop +
  // managed block). The probe is advisory: generation never fails on it.
  try {
    const { isFlowAdopted } = await import("../../os/flow/index.ts");
    const { topLevel } = await import("../../os/flow/git.ts");
    const repoRoot = (await topLevel(workspaceRoot, fio)) ?? workspaceRoot;
    if (await isFlowAdopted(repoRoot, fio)) {
      const prefix = resolveCommandPrefix(config);
      dynamicLines.push("## Branch model");
      dynamicLines.push("");
      dynamicLines.push(`- Every session starts with \`${prefix} flow.open --kind session --slug <slug>\`; work and commit only in the returned worktree. The guard refuses commits on \`develop\` and \`main\`.`);
      dynamicLines.push(`- \`${prefix} flow.integrate --branch <name>\` (operator) rebases, gates and fast-forwards \`develop\`; \`${prefix} flow.discard\` drops a session.`);
      dynamicLines.push(`- Releases are \`${prefix} flow.cut\` (repository line) and \`${prefix} flow.cut --lines <line>\` (package lines); nothing leaves the machine except \`${prefix} flow.push --digest <id>\` after the operator has read \`${prefix} flow.digest\`.`);
      // RFC-1573: the detachable set comes from the command declarations
      // (one module list shared with bin/cli.ts), never a hand-kept copy.
      const { loadForgeCommandModules } = await import("../command-modules.ts");
      const detachable = (await loadForgeCommandModules())
        .flatMap((m) => m.commands)
        .filter((c) => c.detachable === true)
        .map((c) => c.name)
        .sort();
      if (detachable.length > 0) {
        const list = detachable.map((n) => `\`${n}\``).join(", ");
        // The tail is a plain string on purpose: RFC-1573 AC-8 probes this source for the unescaped literal.
        dynamicLines.push(`- Multi-minute commands (${list}) take \`--detach\`: it prints a run id and returns at once; then \`${prefix} gate.run.status --id <runId> --wait 600\`. Exit 0 from \`--detach\` means started, not passed — read \`data.runs[0].status\`.` + " Never a background shell or `timeout`.");
      }
      dynamicLines.push("- Never edit `forge/registry.yaml`, `forge/journal.jsonl` or `forge/*.lock` in the git directory.");
      dynamicLines.push("");
    }
  } catch {
    // Flow probe failed (no git, unreadable repo) — section omitted.
  }

  // RFC-1365 (DNA-115): declared contract producers carry the golden-conformance
  // convention — emitted only when forge.yaml declares contractProducers[].
  if ((config.contractProducers ?? []).length > 0) {
    dynamicLines.push("## Golden conformance for declared contract producers");
    dynamicLines.push("");
    dynamicLines.push("This repository declares `contractProducers[]` in `forge.yaml` — every declared producer MUST keep a working golden-conformance path: `emit` writes the bundle into the forge-provided dir (`{bundle}` argv placeholder / `FORGE_CONFORMANCE_BUNDLE_DIR`), the optional `mirror` leg re-checks the same bundle, and the `consumer` leg invokes the authoritative consumer validator — the installed bin of a published validator package (`consumer.package`, exact-pinned devDependency, never self-skips — RFC-1539) or, for consumers without a published validator, inside the sibling checkout `consumer.root` (DNA-115).");
    dynamicLines.push("");
    dynamicLines.push("- One execution path serves both surfaces: `forge.conformance.run --producer <id>` (or `--all`) for operator/CI runs, and the `@warpgogol/forge/conformance` helper (`consumerAvailable` + `runProducerConformance`) for vitest wrappers — never hand-roll spawn/mkdtemp/skip plumbing in producer tests.");
    dynamicLines.push("- An absent `consumer.root` self-skips with an explicit verdict; use `--require-consumer` or `FORGE_CONFORMANCE_REQUIRE=1` in environments where the checkout is guaranteed so the guard fails closed instead of silently degrading.");
    dynamicLines.push("- `forge.conformance.validate` lints declarations fail-closed (CONF-01..06): schema + `{bundle}` placeholders, test wiring, argv path resolution, absent consumer.root (warning), duplicate ids, missing mirror (warning).");
    dynamicLines.push("- Never vendor or re-implement consumer validation rules — the consumer argv is the authority; emit/mirror agreeing while both diverge from the consumer is the defect class this exists to catch.");
    dynamicLines.push("");
    dynamicLines.push("Naming: golden contract conformance (this, cross-repo producer side) ≠ component-runtime conformance (in-repo capability contracts) ≠ content golden baselines ≠ verbund fixture conformance.");
    dynamicLines.push("");
  }

  // RFC-0643: Load root template, replace project placeholders, insert dynamic sections
  const profile = config.profile as StackProfile | undefined;
  const rootTemplate = selectRootTemplate(register, profile);
  const dynamicSections = dynamicLines.join("\n");
  let content = replaceProjectPlaceholders(rootTemplate, config, dynamicSections);

  // Prepend generated header (above template content) — header ends in a
  // newline, so a single "\n" here yields the prettier-normal one blank line.
  content = header + "\n" + content;

  // RFC-0643: Apply terminology substitution on final assembled content
  const resolvedTerminology = resolveAllTerminology(config, profile);
  content = substituteTemplate(content, resolvedTerminology);

  const generated: string[] = [];
  const skipped: string[] = [];
  const injected: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};
  const details: Array<{ path: string; domain?: string; register?: string; workspaceType?: string }> = [];
  details.push({
    path: "AGENTS.md",
    domain: profile?.domain,
    register,
  });

  if (dryRun) {
    renderedFiles["AGENTS.md"] = content;
    generated.push("AGENTS.md");
  } else if (rootSkipped) {
    // Marker-guarded opt-in: a hand-written root carrying the semantic-layer
    // sentinel (or a pasted marked region) gets the block refreshed —
    // surrounding prose is never touched.
    let rootInjected = false;
    if (semanticLayerBlock) {
      try {
        const existing = await fio.readFile(agentsMdPath);
        const injection = injectSemanticLayerBlock(existing, semanticLayerBlock);
        if (injection.changed) {
          await writeFileIfChanged(agentsMdPath, injection.content, fio);
          rootInjected = true;
        }
      } catch {
        // Unreadable — leave the hand-written file alone.
      }
    }
    skipped.push(`AGENTS.md (hand-written${rootInjected ? " — semantic-layer injected" : ""})`);
    if (rootInjected) injected.push("AGENTS.md");
  } else {
    // RFC-1153: merge instead of overwrite — preserve the custom tail below
    // the forge:custom boundary; fail-closed skip when no boundary resolves.
    let existing: string | null = null;
    if (await fio.exists(agentsMdPath)) {
      try {
        existing = await fio.readFile(agentsMdPath);
      } catch {
        // Unreadable — treat as absent; merge will emit a fresh file.
      }
    }
    let merged = mergeEditableGenerated(content, existing, "AGENTS.md");
    if (merged === null) {
      if (existing !== null && !hasEditableGeneratedMarker(existing)) {
        // RFC-0081/RFC-1153: restrictive-marker file is fully generator-owned —
        // upgrade it to the editable boundary contract (fresh render + marker).
        merged = mergeEditableGenerated(content, null, "AGENTS.md");
      } else {
        skipped.push("AGENTS.md (unmapped-customization)");
        if (outputFormat === "pretty") {
          logger.warn(
            "AGENTS.md has custom content but no resolvable boundary — skipping root file (unmapped-customization). Add <!-- forge:custom --> to set the boundary.",
          );
        }
      }
    }
    if (merged !== null) {
      await writeFileIfChanged(agentsMdPath, merged, fio);
      generated.push("AGENTS.md");
      if (outputFormat === "pretty") {
        logger.success(`Generated ${path.relative(workspaceRoot, agentsMdPath)}`);
      }
    }
  }

  // Nested AGENTS.md generation (RFC-0611)
  // RFC-0640/RFC-0643: resolveWorkspaceTypes prefers config.profile (loaded by
  // loadForgeConfig), falls back to the stack-based catalog lookup.
  let forgeRootForTypes: string | undefined;
  try {
    forgeRootForTypes = resolveForgeRoot(workspaceRoot);
  } catch {
    // forge root not resolvable — fallback to hardcoded detection
  }
  const workspaceTypes = resolveWorkspaceTypes(config, forgeRootForTypes);
  const nestedResult = await generateNestedAgentsMd(workspaceRoot, config, dryRun, workspaceTypes, fio);
  generated.push(...nestedResult.generated);
  skipped.push(...nestedResult.skipped);
  injected.push(...nestedResult.injected);
  Object.assign(renderedFiles, nestedResult.renderedFiles);

  // RFC-0643: add details for nested files
  for (const rel of nestedResult.generated) {
    details.push({
      path: rel,
      domain: profile?.domain,
      workspaceType: nestedResult.workspaceTypeMap?.[rel],
    });
  }

  if (!dryRun && outputFormat === "pretty") {
    for (const rel of nestedResult.generated) {
      logger.success(`Generated ${rel}`);
    }
    for (const rel of nestedResult.skipped) {
      logger.warn(`Skipped ${rel}`);
    }
  }

  return {
    data: {
      command: "forge.agents.generate",
      status: "pass",
      configPath: "forge.yaml",
      generated,
      skipped,
      injected,
      errors: [],
      details,
      ...(rootSkipped ? { rootSkipped: true, rootSkipReason: "hand-written" } : {}),
      ...(dryRun ? { renderedFiles } : {}),
    },
    exitCode: 0,
    summary: dryRun
      ? `forge.agents.generate: [dry-run] would generate ${generated.length} file(s), skip ${skipped.length}`
      : `forge.agents.generate: OK — ${generated.length} file(s) generated, ${skipped.length} skipped${injected.length > 0 ? `, ${injected.length} semantic-layer injected` : ""}${rootSkipped ? " (root AGENTS.md hand-written — skipped)" : ""}`,
  };
}
