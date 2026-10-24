/*
<MODULE_CONTRACT>
<purpose>RFC-1390: `checked-by` binding resolution and COMPASS-INVARIANT-02..07
rule evaluation plus the `docs/invariants*.generated.yaml` index/baseline IO
shared by compass.validate and compass.invariants.generate. The pure tagged
`@ai-invariant[INV-<scope>-<NN>]` parser lives in src/compass/invariant-parser.ts
(RFC-1392 extraction, re-exported here). The binding is structural — a binding
names the check; whether the check truly enforces the statement stays a review
concern (DNA-43, RFC-1392).</purpose>
<non-goals>
  <item>Do not register commands — handlers and the module file do that.</item>
  <item>Do not judge semantic adequacy of a bound check — the binding is structural only.</item>
  <item>Do not import from @warpgogol/* — forge is autonomous (FORGE-AUTONOMY-01).</item>
  <item>Do not scan `#`/`;`-style comment syntaxes (.gd, .tscn, .tres) — marker extraction covers `//` line comments, slash-star block comments, and HTML comments only; no such files exist in this workspace.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>"Unbound" means no binding attempted; a declared-but-broken binding reports COMPASS-INVARIANT-04 — a false claim is worse than none.</item>
  <item>Baseline keys are path + sha256(statement); cross-file moves of unbound invariants deliberately flag as new debt (Q-4).</item>
  <item>retiredIds survive regeneration via merge-forward — the generated index is the only store of never-reused ids.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1392: pure parser extracted to src/compass/invariant-parser.ts (re-exported); this module keeps IO, binding resolution, and rule evaluation.</item>
  <item>RFC-1390: tagged invariant grammar, checked-by resolvers, rule table 02..07, index/baseline IO.</item>
  <item>RFC-1390: bind code invariants to enforcing checks (INV-tags, checked-by, baseline, generator)</item>
  <item>RFC-1390: close review findings on invariant binding machinery</item>
  <item>RFC-1390: close round-2 review findings on invariant binding machinery</item>
  <item>RFC-1390: close round-3 review residue on invariant binding machinery</item>
</CHANGE_SUMMARY>
*/

import { isAbsolute, relative, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo } from "../../../src/utils/io.ts";
import { buildGeneratedHeader } from "../../../src/utils/generated-marker.ts";
import {
  baselineKey,
  BINDING_KINDS,
  invariantStatementSha,
  type ParsedInvariant,
} from "../../../src/compass/invariant-parser.ts";
import type { CompassRiskClass } from "../policy.ts";

// The pure parser moved to src/compass/invariant-parser.ts (RFC-1392) so
// cross-package consumers can import it via @warpgogol/forge/compass. These
// re-exports keep existing os/ consumers on this module unchanged.
export {
  baselineKey,
  extractInvariants,
  invariantStatementSha,
  normalizeInvariantStatement,
  INVARIANT_ID_RE,
  VACUOUS_INVARIANT_PATTERNS,
  type InvariantBindingKind,
  type ParsedInvariant,
  type RawBinding,
} from "../../../src/compass/invariant-parser.ts";

const io = ambientIo;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Contracts (RFC-1390 TypeScript contracts section)
// ---------------------------------------------------------------------------

import type { InvariantBindingKind } from "../../../src/compass/invariant-parser.ts";

export interface InvariantBinding {
  kind: InvariantBindingKind;
  /** Workspace-relative path for test/type/proof; RULE-ID for lint. */
  target: string;
  resolved: boolean;
  /** Why resolution failed, when it did — feeds the diagnostic message. */
  failure?: string;
}

export interface CodeInvariant {
  /** null for legacy untagged `// @ai-invariant …` forms. */
  id: string | null;
  /** Tag bracket content present but not matching INVARIANT_ID_RE. */
  malformedId?: string;
  file: string;
  line: number;
  statement: string;
  statementSha256: string;
  bindings: InvariantBinding[];
  /** id !== null && bindings.length > 0 && every binding resolved. */
  bound: boolean;
  riskClass: CompassRiskClass;
  baselined: boolean;
  vacuous: boolean;
}

export interface InvariantIndex {
  schema: "forge/invariant-index@1";
  invariants: CodeInvariant[];
  retiredIds: string[];
}

export interface InvariantBaselineEntry {
  path: string;
  statementSha256: string;
}

export interface InvariantBaseline {
  schema: "forge/invariant-baseline@1";
  entries: InvariantBaselineEntry[];
}

export const INVARIANT_INDEX_PATH = "docs/invariants.generated.yaml";
export const INVARIANT_BASELINE_PATH = "docs/invariants.baseline.generated.yaml";
export const VALIDATOR_INVENTORY_PATH = "docs/validator-inventory.generated.yaml";

// ---------------------------------------------------------------------------
// Index + baseline IO
// ---------------------------------------------------------------------------

export function resolveInvariantPaths(
  workspaceRoot: string,
  compassOverrides?: {
    invariants?: { indexPath?: string; baselinePath?: string };
  },
): { indexPath: string; baselinePath: string } {
  const overrides = compassOverrides?.invariants;
  return {
    indexPath: resolve(workspaceRoot, overrides?.indexPath ?? INVARIANT_INDEX_PATH),
    baselinePath: resolve(workspaceRoot, overrides?.baselinePath ?? INVARIANT_BASELINE_PATH),
  };
}

/**
 * Loaders return null ONLY when the artifact is absent (ENOENT) — a corrupt
 * or shape-wrong file is an integrity error and throws, never reads as
 * "no baseline yet" (which would silently re-seed or downgrade the ratchet).
 */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export async function loadInvariantIndex(indexPath: string): Promise<InvariantIndex | null> {
  let raw: string;
  try {
    raw = await io.readFile(indexPath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = yamlParse(raw) as Partial<InvariantIndex> | null;
  if (!parsed || !Array.isArray(parsed.invariants)) {
    throw new Error(`malformed invariant index at ${indexPath}`);
  }
  return {
    schema: "forge/invariant-index@1",
    invariants: (parsed.invariants ?? []) as CodeInvariant[],
    retiredIds: Array.isArray(parsed.retiredIds) ? (parsed.retiredIds as string[]) : [],
  };
}

export async function loadInvariantBaseline(
  baselinePath: string,
): Promise<InvariantBaseline | null> {
  let raw: string;
  try {
    raw = await io.readFile(baselinePath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = yamlParse(raw) as Partial<InvariantBaseline> | null;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`malformed invariant baseline at ${baselinePath}`);
  }
  return {
    schema: "forge/invariant-baseline@1",
    entries: (parsed.entries as InvariantBaselineEntry[]).filter(
      (e) => typeof e?.path === "string" && typeof e?.statementSha256 === "string",
    ),
  };
}

export function serializeInvariantIndex(index: InvariantIndex): string {
  return (
    buildGeneratedHeader({
      filePath: INVARIANT_INDEX_PATH,
      ownerCommand: "compass.invariants.generate",
    }) + yamlStringify(index, { indent: 2 })
  );
}

export function serializeInvariantBaseline(baseline: InvariantBaseline): string {
  return (
    buildGeneratedHeader({
      filePath: INVARIANT_BASELINE_PATH,
      ownerCommand: "compass.invariants.generate",
    }) +
    `# Re-seeding is forbidden; entries leave only via --shrink.\n` +
    yamlStringify(baseline, { indent: 2 })
  );
}

// ---------------------------------------------------------------------------
// Binding resolution + rule evaluation
// ---------------------------------------------------------------------------

export interface BindingResolutionContext {
  workspaceRoot: string;
  /** Rule ids present in the validator inventory; null when the file is missing. */
  lintRuleIds: Set<string> | null;
}

async function resolveOneBinding(
  binding: InvariantBinding,
  invariant: Pick<CodeInvariant, "id" | "file" | "line">,
  ctx: BindingResolutionContext,
): Promise<void> {
  if (binding.kind === "lint") {
    if (ctx.lintRuleIds === null) {
      binding.resolved = false;
      binding.failure = "validator-inventory-missing";
      return;
    }
    binding.resolved = ctx.lintRuleIds.has(binding.target);
    if (!binding.resolved)
      binding.failure = `rule id ${binding.target} absent from validator inventory`;
    return;
  }

  // test / type / proof — file must exist and contain the literal invariant id.
  if (!invariant.id) {
    binding.resolved = false;
    binding.failure = "binding on an untagged invariant has no id to check for";
    return;
  }
  const abs = resolve(ctx.workspaceRoot, binding.target);
  const root = resolve(ctx.workspaceRoot);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    binding.resolved = false;
    binding.failure = `binding target ${binding.target} escapes the workspace root`;
    return;
  }
  let content: string | null = null;
  try {
    content = await io.readFile(abs);
  } catch {
    content = null;
  }
  if (content === null) {
    binding.resolved = false;
    binding.failure = `bound file ${binding.target} does not exist`;
    return;
  }
  binding.resolved = new RegExp(`${escapeRegExp(invariant.id)}\\b`).test(content);
  if (!binding.resolved) {
    binding.failure = `${binding.target} does not contain the invariant id ${invariant.id}`;
  }
}

export async function resolveInvariantBindings(
  invariants: ParsedInvariant[],
  file: string,
  riskClass: CompassRiskClass,
  baseline: Set<string>,
  ctx: BindingResolutionContext,
): Promise<CodeInvariant[]> {
  const out: CodeInvariant[] = [];
  for (const parsed of invariants) {
    const bindings: InvariantBinding[] = parsed.rawBindings.map((raw) => ({
      kind: raw.kind as InvariantBindingKind,
      target: raw.target,
      resolved: false,
      failure: BINDING_KINDS.has(raw.kind as InvariantBindingKind)
        ? undefined
        : `unknown binding kind "${raw.kind}"`,
    }));
    if (parsed.malformedCheckedBy) {
      bindings.push({
        kind: "test",
        target: "(checked-by: …)",
        resolved: false,
        failure: "checked-by group is not the trailing parenthesised group of the statement",
      });
    }

    const invariant: CodeInvariant = {
      id: parsed.id,
      malformedId: parsed.malformedId,
      file,
      line: parsed.line,
      statement: parsed.statement,
      statementSha256: invariantStatementSha(parsed.statement),
      bindings,
      bound: false,
      riskClass,
      baselined: baseline.has(baselineKey(file, invariantStatementSha(parsed.statement))),
      vacuous: parsed.vacuous,
    };

    for (const binding of bindings) {
      if (binding.failure) continue; // unknown kind — stays unresolved
      await resolveOneBinding(binding, invariant, ctx);
    }

    invariant.bound =
      invariant.id !== null && bindings.length > 0 && bindings.every((b) => b.resolved);
    out.push(invariant);
  }
  return out;
}

export function baselineSet(baseline: InvariantBaseline | null): Set<string> {
  return new Set((baseline?.entries ?? []).map((e) => baselineKey(e.path, e.statementSha256)));
}

/**
 * Loads the lint-rule corpus for `lint:` bindings. Returns null when the
 * validator inventory is absent — callers downgrade the affected bindings to
 * a warning instead of an unresolved-binding error (fresh workshops stay
 * advisory until `validator.inventory.generate` has run).
 */
export async function loadLintRuleIds(workspaceRoot: string): Promise<Set<string> | null> {
  let raw: string;
  try {
    raw = await io.readFile(resolve(workspaceRoot, VALIDATOR_INVENTORY_PATH));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = yamlParse(raw);
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "rules" && Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") ids.add(item);
          }
        } else {
          visit(value);
        }
      }
    }
  };
  visit(parsed);
  return ids;
}

// ---------------------------------------------------------------------------
// COMPASS-INVARIANT-02..07 rule evaluation
// ---------------------------------------------------------------------------

export interface InvariantDiagnostic {
  ruleId:
    | "COMPASS-INVARIANT-02"
    | "COMPASS-INVARIANT-03"
    | "COMPASS-INVARIANT-04"
    | "COMPASS-INVARIANT-05"
    | "COMPASS-INVARIANT-06"
    | "COMPASS-INVARIANT-07";
  severity: "warning" | "error";
  file: string;
  message: string;
  fix: string;
}

function describe(invariant: CodeInvariant): string {
  return (
    invariant.id ?? invariant.malformedId ?? `@ai-invariant at ${invariant.file}:${invariant.line}`
  );
}

/**
 * Corpus-wide evaluation: `invariants` is the flattened list across all files,
 * `baseline` the shrink-only baseline (null when absent), `baselinePresent`
 * distinguishes absent-file from empty-file for the 06 downgrade.
 */
export function evaluateInvariantRules(
  invariants: CodeInvariant[],
  baseline: InvariantBaseline | null,
  retiredIds: Set<string>,
): InvariantDiagnostic[] {
  const diagnostics: InvariantDiagnostic[] = [];
  const baselineKeys = baselineSet(baseline);

  // COMPASS-INVARIANT-05 — duplicate ids and retired-id reuse (corpus-wide).
  const byId = new Map<string, CodeInvariant[]>();
  for (const inv of invariants) {
    if (inv.id) byId.set(inv.id, [...(byId.get(inv.id) ?? []), inv]);
  }
  for (const inv of invariants) {
    if (!inv.id) continue;
    if (retiredIds.has(inv.id)) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-05",
        severity: "error",
        file: inv.file,
        message: `invariant id ${inv.id} was previously retired — ids are never reused`,
        fix: `fix: pick a fresh INV-<scope>-<NN> id; retired ids stay reserved in docs/invariants.generated.yaml`,
      });
    } else if ((byId.get(inv.id) ?? []).length > 1) {
      const peers = byId
        .get(inv.id)!
        .map((other) => `${other.file}:${other.line}`)
        .join(", ");
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-05",
        severity: "error",
        file: inv.file,
        message: `duplicate invariant id ${inv.id} (also at ${peers})`,
        fix: `fix: keep one declaration and renumber the others — ids are unique workspace-wide`,
      });
    }
  }

  for (const inv of invariants) {
    // COMPASS-INVARIANT-04 — malformed id or unresolved binding (error).
    if (inv.malformedId !== undefined) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-04",
        severity: "error",
        file: inv.file,
        message: `malformed invariant id "${inv.malformedId}" — expected INV-<scope>-<NN> (kebab scope, 2-3 digit tail)`,
        fix: `fix: rename to a well-formed id, e.g. INV-${(inv.file.split("/").at(-2) ?? "scope").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-01`,
      });
    }
    for (const binding of inv.bindings) {
      if (binding.resolved) continue;
      if (binding.failure === "validator-inventory-missing") {
        diagnostics.push({
          ruleId: "COMPASS-INVARIANT-04",
          severity: "warning",
          file: inv.file,
          message: `lint binding ${binding.kind}:${binding.target} on ${describe(inv)} is unverifiable — validator inventory absent`,
          fix: `fix: run validator.inventory.generate, then re-run compass.validate`,
        });
        continue;
      }
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-04",
        severity: "error",
        file: inv.file,
        message: `unresolved binding ${binding.kind}:${binding.target} on ${describe(inv)} — ${binding.failure}`,
        fix: inv.id
          ? `fix: name the invariant id ${inv.id} inside the bound file, or correct the binding target`
          : `fix: tag the invariant with an id and name it inside the bound file, or correct the binding target`,
      });
    }

    const unbound = inv.bindings.length === 0; // no binding ATTEMPT — broken attempts report 04 only
    const baselined = baselineKeys.has(baselineKey(inv.file, inv.statementSha256));

    if (unbound && baselined) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-02",
        severity: "warning",
        file: inv.file,
        message: `unbound invariant ${describe(inv)} is tracked by the baseline — bind a check to retire it`,
        fix: `fix: add (checked-by: test:<path>) pointing at a file containing the id literal`,
      });
    } else if (unbound && baseline === null) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-06",
        severity: "warning",
        file: inv.file,
        message: `unbound invariant ${describe(inv)} and no baseline exists yet`,
        fix: `fix: run compass.invariants.generate --seed, or bind the invariant`,
      });
    } else if (unbound) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-06",
        severity: inv.riskClass === "high" ? "error" : "warning",
        file: inv.file,
        message: `unbound invariant ${describe(inv)} is absent from the baseline${inv.riskClass === "high" ? " (high-risk file)" : ""}`,
        fix: `fix: add (checked-by: test:<path>|type:<path>|lint:<RULE-ID>|proof:<path>) — new unbound invariants are not grandfathered`,
      });
    }

    if (inv.vacuous) {
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-03",
        severity: "warning",
        file: inv.file,
        message: `vacuous invariant statement: "${inv.statement.slice(0, 80)}"`,
        fix: `fix: reword into a falsifiable constraint (what must never or always hold)`,
      });
    }
  }

  // COMPASS-INVARIANT-07 — stale baseline entries: the recorded unbound
  // invariant is now bound-attempting, deleted, or reworded. Advisory until
  // --shrink reconciles the file.
  if (baseline) {
    const currentKeys = new Set(
      invariants
        .filter((inv) => inv.bindings.length === 0)
        .map((inv) => baselineKey(inv.file, inv.statementSha256)),
    );
    const boundOrGone = new Set(
      invariants.map((inv) => baselineKey(inv.file, inv.statementSha256)),
    );
    for (const entry of baseline.entries) {
      const key = baselineKey(entry.path, entry.statementSha256);
      if (currentKeys.has(key)) continue;
      const reason = boundOrGone.has(key)
        ? "now carries a checked-by binding"
        : "no longer present";
      diagnostics.push({
        ruleId: "COMPASS-INVARIANT-07",
        severity: "warning",
        file: entry.path,
        message: `stale baseline entry — invariant ${reason}; run compass.invariants.generate --shrink`,
        fix: `fix: run compass.invariants.generate --shrink`,
      });
    }
  }

  return diagnostics;
}
