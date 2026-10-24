/*
<MODULE_CONTRACT>
<purpose>RFC-1390: `compass.invariants.generate` — projects every `@ai-invariant`
in the workspace into `docs/invariants.generated.yaml` and manages the
shrink-only `docs/invariants.baseline.generated.yaml`. `--seed` writes the
baseline once; `--shrink` removes resolved/deleted entries and refuses to add;
plain runs refresh the index with retiredIds merged forward.</purpose>
<non-goals>
  <item>Do not prove or check the invariant statements — binding is structural only.</item>
  <item>Do not grandfather new unbound invariants — there is deliberately no add path.</item>
  <item>Do not import from @warpgogol/* — forge is autonomous (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>--shrink refuses to write when unbound debt is absent from the baseline — new debt stays visible, never silently absorbed.</item>
  <item>retiredIds = previous retiredIds ∪ (prior ids missing now) — merged forward on every regeneration.</item>
  <item>Scoped scans (--workpiece/--site/--packages/--package or a site-bound context) are preview-only — a partial-corpus seed/shrink/index write would corrupt the workspace-rooted key space or retire out-of-scope ids.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1390: generator handler — index projection, seed/shrink baseline, retiredIds merge-forward.</item>
  <item>RFC-1390: bind code invariants to enforcing checks (INV-tags, checked-by, baseline, generator)</item>
  <item>RFC-1390: close review findings on invariant binding machinery</item>
  <item>RFC-1390: close round-2 review findings on invariant binding machinery</item>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { resolveIo } from "../../../src/utils/io.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { createCompassInventoryEntries, getEntrySource } from "./compass-inventory.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { resolveCompassPolicy } from "../policy.ts";
import {
  baselineKey,
  baselineSet,
  extractInvariants,
  loadInvariantBaseline,
  loadInvariantIndex,
  loadLintRuleIds,
  resolveInvariantBindings,
  resolveInvariantPaths,
  serializeInvariantBaseline,
  serializeInvariantIndex,
  type CodeInvariant,
  type InvariantBaseline,
  type InvariantIndex,
} from "./invariant-bindings.ts";

interface GenerateResult {
  mode: "index" | "seed" | "shrink";
  dryRun: boolean;
  total: number;
  bound: number;
  unbound: number;
  baselined: number;
  vacuous: number;
  retiredIds: number;
  filesModified: string[];
}

async function collectInvariants(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  baselineKeys: Set<string>,
  lintRuleIds: Set<string> | null,
  scanRoot: string | undefined,
): Promise<CodeInvariant[]> {
  const io = resolveIo(context.io);
  const policy = resolveCompassPolicy(context.workspaceRoot, context.forgeRoot);
  const entries = await createCompassInventoryEntries(
    context.workspaceRoot,
    input,
    scanRoot,
    policy,
    context.site?.directory,
  );

  const invariants: CodeInvariant[] = [];
  for (const entry of entries) {
    if (entry.authoringStatus !== "authored" || entry.requiredScaffolding === "none") continue;
    const absPath = resolve(context.workspaceRoot, entry.path);
    const source = getEntrySource(entry) ?? (await io.readFile(absPath));
    const parsed = extractInvariants(source);
    if (parsed.length === 0) continue;
    invariants.push(
      ...(await resolveInvariantBindings(parsed, entry.path, entry.riskClass, baselineKeys, {
        workspaceRoot: context.workspaceRoot,
        lintRuleIds,
      })),
    );
  }
  return invariants;
}

export async function runCompassInvariantsGenerate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<GenerateResult>> {
  const io = resolveIo(context.io);
  let compassOverrides: Parameters<typeof resolveInvariantPaths>[1];
  try {
    compassOverrides = loadForgeConfig(context.workspaceRoot, context.forgeRoot).bindings?.compass;
  } catch {
    compassOverrides = undefined;
  }
  const paths = resolveInvariantPaths(context.workspaceRoot, compassOverrides);
  const seed = input.flags["seed"] === true;
  const shrink = input.flags["shrink"] === true;
  const dryRun = context.dryRun === true || input.flags["dry-run"] === true;

  if (seed && shrink) {
    return {
      exitCode: 1,
      summary: `[compass.invariants.generate] --seed and --shrink are mutually exclusive — seed writes the baseline once, shrink only removes from it`,
    };
  }

  // The index and baseline are whole-workspace artifacts keyed by
  // workspace-relative paths. A scoped scan (--workpiece/--site/--packages/
  // --package, or an implicitly site-bound context) sees a different corpus
  // and key space: --seed would write a partial baseline, --shrink would wipe
  // every out-of-scope entry, and an index write would retire out-of-scope
  // ids. Scoped runs are preview-only.
  const scanRoot = resolveCompassScanRoot(input, context);
  if (scanRoot !== undefined && !dryRun) {
    return {
      exitCode: 1,
      summary:
        `[compass.invariants.generate] scoped scans write nothing — index and baseline are whole-workspace artifacts. ` +
        `Rerun with --dry-run to preview this scope, or drop the scope flag to update the workspace artifacts.`,
    };
  }

  const baseline = await loadInvariantBaseline(paths.baselinePath);
  const previousIndex = await loadInvariantIndex(paths.indexPath);
  const lintRuleIds = await loadLintRuleIds(context.workspaceRoot);
  const invariants = await collectInvariants(
    input,
    context,
    baselineSet(baseline),
    lintRuleIds,
    scanRoot,
  );

  const currentIds = new Set(invariants.map((i) => i.id).filter((id): id is string => !!id));
  const previousIds = new Set(
    (previousIndex?.invariants ?? []).map((i) => i.id).filter((id): id is string => !!id),
  );
  const retiredIds = [
    ...new Set([
      ...(previousIndex?.retiredIds ?? []),
      ...[...previousIds].filter((id) => !currentIds.has(id)),
    ]),
  ].sort();

  const index: InvariantIndex = {
    schema: "forge/invariant-index@1",
    invariants,
    retiredIds,
  };

  const relIndex = paths.indexPath.startsWith(context.workspaceRoot)
    ? paths.indexPath.slice(context.workspaceRoot.length + 1)
    : paths.indexPath;
  const relBaseline = paths.baselinePath.startsWith(context.workspaceRoot)
    ? paths.baselinePath.slice(context.workspaceRoot.length + 1)
    : paths.baselinePath;

  const filesModified: string[] = [];
  const data = (mode: GenerateResult["mode"]): GenerateResult => ({
    mode,
    dryRun,
    total: invariants.length,
    bound: invariants.filter((i) => i.bound).length,
    unbound: invariants.filter((i) => i.bindings.length === 0).length,
    baselined: invariants.filter((i) => i.baselined).length,
    vacuous: invariants.filter((i) => i.vacuous).length,
    retiredIds: retiredIds.length,
    filesModified,
  });

  if (seed) {
    if (baseline !== null) {
      return {
        exitCode: 1,
        data: data("seed"),
        summary: `[compass.invariants.generate] --seed refused: baseline already exists at ${relBaseline}`,
      };
    }
    const newBaseline: InvariantBaseline = {
      schema: "forge/invariant-baseline@1",
      entries: invariants
        .filter((i) => i.bindings.length === 0)
        .map((i) => ({ path: i.file, statementSha256: i.statementSha256 }))
        .sort((a, b) =>
          baselineKey(a.path, a.statementSha256).localeCompare(
            baselineKey(b.path, b.statementSha256),
          ),
        ),
    };
    if (!dryRun) {
      await writeFileIfChanged(paths.baselinePath, serializeInvariantBaseline(newBaseline), io);
      filesModified.push(relBaseline);
    }
    if (!dryRun) {
      await writeFileIfChanged(paths.indexPath, serializeInvariantIndex(index), io);
      filesModified.push(relIndex);
    }
    return {
      exitCode: 0,
      data: data("seed"),
      summary: `[compass.invariants.generate] seeded baseline with ${newBaseline.entries.length} unbound entr${newBaseline.entries.length === 1 ? "y" : "ies"}`,
    };
  }

  if (shrink) {
    if (baseline === null) {
      return {
        exitCode: 1,
        data: data("shrink"),
        summary: `[compass.invariants.generate] --shrink refused: no baseline at ${relBaseline}; run --seed first`,
      };
    }
    // Refuse to absorb NEW unbound debt silently: an unbound invariant absent
    // from the baseline is new debt — bind it instead (AC-6).
    const currentUnbound = invariants.filter((i) => i.bindings.length === 0);
    const existingKeys = baselineSet(baseline);
    const newDebt = currentUnbound.filter(
      (i) => !existingKeys.has(baselineKey(i.file, i.statementSha256)),
    );
    if (newDebt.length > 0) {
      context.logger.error(
        `[compass.invariants.generate] --shrink would add ${newDebt.length} entr${
          newDebt.length === 1 ? "y" : "ies"
        } to the baseline — refused. New unbound invariants are not grandfathered:\n` +
          newDebt.map((i) => `  ${i.file}:${i.line} ${i.statement.slice(0, 60)}`).join("\n"),
      );
      return {
        exitCode: 1,
        data: data("shrink"),
        summary: `[compass.invariants.generate] --shrink refused to add ${newDebt.length} entr${newDebt.length === 1 ? "y" : "ies"}`,
      };
    }
    const kept = baseline.entries.filter((e) =>
      currentUnbound.some(
        (i) => baselineKey(i.file, i.statementSha256) === baselineKey(e.path, e.statementSha256),
      ),
    );
    const removed = baseline.entries.length - kept.length;
    if (!dryRun && removed > 0) {
      await writeFileIfChanged(
        paths.baselinePath,
        serializeInvariantBaseline({ schema: "forge/invariant-baseline@1", entries: kept }),
        io,
      );
      filesModified.push(relBaseline);
    }
    if (!dryRun) {
      await writeFileIfChanged(paths.indexPath, serializeInvariantIndex(index), io);
      filesModified.push(relIndex);
    }
    return {
      exitCode: 0,
      data: data("shrink"),
      summary: `[compass.invariants.generate] --shrink removed ${removed} baseline entr${removed === 1 ? "y" : "ies"} (${kept.length} remain)`,
    };
  }

  if (!dryRun) {
    await writeFileIfChanged(paths.indexPath, serializeInvariantIndex(index), io);
    filesModified.push(relIndex);
  }
  return {
    exitCode: 0,
    data: data("index"),
    summary: `[compass.invariants.generate] ${dryRun ? "previewed" : "wrote"} ${relIndex} — ${invariants.length} invariant(s), ${data("index").bound} bound`,
  };
}
