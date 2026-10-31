/*
<MODULE_CONTRACT>
<purpose>
RFC-1466: scar.migrate — move a friction-scar bullet from an AGENTS.md file
into docs/remediation-catalog.custom.yaml. Writes the fragment entry
(ruleText, frictionIds, diagnosticCodes?, migratedFrom, migratedAt,
originLine), updates the cited friction records' catalogRefs, removes the
bullet (empty sections collapse), and journals refusals.
</purpose>
<non-goals>
  <item>Never auto-resolves invariant-shaped content without --force — the refusal is journaled.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1466: scar bullet → remediation fragment migration with invariant refusal + journal</item>
  <item>RFC-1466: bound the instruction layer — instructions.budget.validate, scar.migrate, catalog fragment merge</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { isScar, loadBudget } from "./budget-validate.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ScarMigrateData {
  command: "scar.migrate";
  status: "migrated" | "refused";
  entryId?: string;
  removedBullet?: string;
  frictionIds: string[];
  reason?: string;
}

const FRAGMENT_PATH = "docs/remediation-catalog.custom.yaml";
const INVARIANT_RE =
  /\b(MUST|SHALL|NEVER|ALWAYS|invariant|forbidden|prohibited|hard guard|blocking)\b/i;

interface FragmentEntry {
  id: string;
  ruleText: string;
  frictionIds?: string[];
  diagnosticCodes?: string[];
  migratedFrom: string;
  migratedAt: string;
  originLine: number;
}

interface FragmentFile {
  entries: FragmentEntry[];
  refusals?: { file: string; line: number; reason: string; at: string }[];
}

function flagId(flags: Record<string, unknown>): string | undefined {
  const v = flags["catalog-remedy"] ?? flags["catalogRemedy"];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export async function runScarMigrate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ScarMigrateData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const file = input.flags["file"] as string | undefined;
  const line = Number(input.flags["line"]);
  if (!file || !Number.isInteger(line) || line < 1) {
    throw new Error("scar.migrate requires --file <path> --line <n>");
  }
  if (path.isAbsolute(file) || file.includes("..")) {
    throw new Error("scar.migrate --file must be a relative workspace path");
  }
  const rel = file.split(path.sep).join("/");
  const force = input.flags["force"] === true;
  const entryId = flagId(input.flags as Record<string, unknown>);
  const frictionIds = (input.flags["friction"] as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => /^F-\d{4}$/.test(s)) ?? [];
  const diagnosticCodes = (input.flags["diagnostic-codes"] as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const src = await io.readFile(path.join(root, rel)).catch(() => null);
  if (src === null) throw new Error(`scar.migrate: no file at ${rel}`);
  const lines = src.split("\n");
  const bullet = lines[line - 1];
  if (!bullet?.startsWith("- ")) {
    throw new Error(`scar.migrate: ${rel}:${line} is not a bullet — target a scar bullet line`);
  }
  if (!isScar(bullet)) {
    throw new Error(
      `scar.migrate refuses: ${rel}:${line} does not classify as a scar (no failure provenance) — invariants belong in prose`,
    );
  }

  // Invariant refusal — exempt-section membership OR invariant keywords.
  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  const budget = loadBudget(forgeYaml === null ? null : yamlParse(forgeYaml)?.instructions?.budget);
  let section = "";
  for (let i = line - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^#{2,3}\s+(.*)$/);
    if (m) { section = m[1]!.trim(); break; }
  }
  const invariantShaped =
    budget.exemptSections.some((s) => section.toLowerCase() === s.toLowerCase()) ||
    INVARIANT_RE.test(bullet);

  const fragmentPath = path.join(root, FRAGMENT_PATH);
  const fragmentSrc = await io.readFile(fragmentPath).catch(() => null);
  const fragment: FragmentFile = fragmentSrc
    ? ((yamlParse(fragmentSrc) as FragmentFile | null) ?? { entries: [] })
    : { entries: [] };
  fragment.entries ??= [];
  fragment.refusals ??= [];

  if (invariantShaped && !force) {
    const refusal = {
      file: rel,
      line,
      reason: `invariant-shaped bullet${section ? ` (section "${section}")` : ""} — pass --force to override`,
      at: new Date().toISOString(),
    };
    fragment.refusals.push(refusal);
    await io.mkdir(path.dirname(fragmentPath));
    await io.writeFile(fragmentPath, yamlStringify(fragment));
    return {
      data: {
        command: "scar.migrate",
        status: "refused",
        frictionIds: [],
        reason: refusal.reason,
      },
      summary: `scar.migrate refused — invariant-shaped bullet at ${rel}:${line}`,
      exitCode: 1,
    };
  }

  // Fragment entry — append or extend the named entry.
  const id = entryId ?? `SCAR-${String(fragment.entries.length + 1).padStart(4, "0")}`;
  const ruleText = bullet.replace(/^-\s+/, "").trim();
  const existing = fragment.entries.find((e) => e.id === id);
  if (existing) {
    if (!existing.ruleText.includes(ruleText)) existing.ruleText += ` ${ruleText}`;
    existing.frictionIds = [...new Set([...(existing.frictionIds ?? []), ...frictionIds])];
    existing.originLine = line;
    existing.migratedAt = new Date().toISOString();
  } else {
    fragment.entries.push({
      id,
      ruleText,
      frictionIds,
      diagnosticCodes,
      migratedFrom: `${rel}:${line}`,
      migratedAt: new Date().toISOString(),
      originLine: line,
    });
  }
  await io.mkdir(path.dirname(fragmentPath));
  await io.writeFile(fragmentPath, yamlStringify(fragment));

  // Friction registry — catalogRefs on the cited entries.
  if (frictionIds.length > 0) {
    const frictionsPath = path.join(root, "docs", "frictions.yaml");
    const frictionsSrc = await io.readFile(frictionsPath).catch(() => null);
    if (frictionsSrc !== null) {
      const registry = (yamlParse(frictionsSrc) ?? []) as Record<string, unknown>[];
      let changed = false;
      for (const entry of registry) {
        if (typeof entry.id === "string" && frictionIds.includes(entry.id)) {
          const refs = new Set([...(entry.catalogRefs as string[] | undefined) ?? []]);
          if (!refs.has(id)) {
            refs.add(id);
            entry.catalogRefs = [...refs];
            changed = true;
          }
        }
      }
      if (changed) await io.writeFile(frictionsPath, yamlStringify(registry));
    }
  }

  // Remove the bullet line (and collapse a now-empty heading's bullet run).
  lines.splice(line - 1, 1);
  // collapse double blank lines left behind
  for (let i = line - 1; i > 0 && i < lines.length; ) {
    if (lines[i] === "" && lines[i - 1] === "") lines.splice(i, 1);
    else break;
  }
  await io.writeFile(path.join(root, rel), lines.join("\n"));

  if (context.outputFormat === "pretty") {
    context.logger.success(`Migrated ${rel}:${line} → catalog entry ${id}`);
  }
  return {
    data: {
      command: "scar.migrate",
      status: "migrated",
      entryId: id,
      removedBullet: bullet,
      frictionIds,
    },
    summary: `Migrated scar bullet ${rel}:${line} → ${id}`,
    exitCode: 0,
  };
}
