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
  <item>RFC-1466: bound the instruction layer — instructions.budget.validate, scar.migrate, catalog fragment merge</item>
  <item>RFC-1466: apply r1 repairs — fragment remedies reachable via lookupRemediation, pending-marker ordering, comment-preserving catalogRefs</item>
  <item>RFC-1466: apply r2 repairs — extend-path diagnosticCodes merge, publishConfig exports, marker idempotency, walk-up fragment resolution</item>
  <item>RFC-1466: apply r3 repairs — block-style catalogRefs append, marker-stack strip, remedy id whitelist</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
  <history>RFC-1466</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { LegacyRecordMutationError, updateFriction } from "../../friction/store.ts";
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
  unmatchedFrictions?: string[];
  /** RFC-1590: cited ids still in the unmigrated legacy registry — the
   * command never writes it; friction.migrate first, then re-run. */
  legacyFrictions?: string[];
  pending?: boolean;
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
  if (!/(^|\/)AGENTS\.md$/.test(file)) {
    throw new Error(
      "scar.migrate --file must target an AGENTS.md file — the command only migrates instruction-layer scars",
    );
  }
  const rel = file.split(path.sep).join("/");
  const force = input.flags["force"] === true;
  const entryId = flagId(input.flags as Record<string, unknown>);
  const frictionRaw =
    (input.flags["friction"] as string | undefined)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const malformed = frictionRaw.filter((s) => !/^F-\d{4}$/.test(s));
  if (malformed.length > 0) {
    throw new Error(
      `scar.migrate: malformed friction id(s) ${malformed.join(", ")} — expected F-XXXX`,
    );
  }
  const frictionIds = frictionRaw;
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

  const fragmentPath = path.join(root, FRAGMENT_PATH);
  const fragmentSrc = await io.readFile(fragmentPath).catch(() => null);
  const fragment: FragmentFile = fragmentSrc
    ? ((yamlParse(fragmentSrc) as FragmentFile | null) ?? { entries: [] })
    : { entries: [] };
  fragment.entries ??= [];
  fragment.refusals ??= [];
  const journalRefusal = async (reason: string): Promise<ForgeCommandResult<ScarMigrateData>> => {
    fragment.refusals!.push({ file: rel, line, reason, at: new Date().toISOString() });
    await io.mkdir(path.dirname(fragmentPath));
    await io.writeFile(fragmentPath, yamlStringify(fragment));
    return {
      data: { command: "scar.migrate", status: "refused", frictionIds: [], reason },
      summary: `scar.migrate refused — ${reason} at ${rel}:${line}`,
      exitCode: 1,
    };
  };
  if (!isScar(bullet)) {
    return journalRefusal(
      "not scar-classified (no failure provenance) — invariants belong in prose",
    );
  }

  // Invariant refusal — exempt-section membership OR invariant keywords.
  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  const budget = loadBudget(forgeYaml === null ? null : yamlParse(forgeYaml)?.instructions?.budget);
  let section = "";
  for (let i = line - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^#{2,3}\s+(.*)$/);
    if (m) {
      section = m[1]!.trim();
      break;
    }
  }
  const invariantShaped =
    budget.exemptSections.some((s) => section.toLowerCase() === s.toLowerCase()) ||
    INVARIANT_RE.test(bullet);

  if (invariantShaped && !force) {
    return journalRefusal(
      `invariant-shaped bullet${section ? ` (section "${section}")` : ""} — pass --force to override`,
    );
  }

  // Fragment entry — append or extend the named entry.
  const markerMatch = bullet.match(/<!--\s*migrates-to:\s*(\S+)\s+pending\s*-->/);
  const id =
    entryId ?? markerMatch?.[1] ?? `SCAR-${String(fragment.entries.length + 1).padStart(4, "0")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) {
    throw new Error(`scar.migrate: --catalog-remedy id "${id}" must match [A-Za-z0-9-]+`);
  }
  const ruleText = bullet
    .replace(/^-\s+/, "")
    .replace(/\s*<!--\s*migrates-to:[^>]*-->\s*/g, "")
    .trim();
  const existing = fragment.entries.find((e) => e.id === id);
  if (existing) {
    if (!existing.ruleText.includes(ruleText)) existing.ruleText += ` ${ruleText}`;
    existing.frictionIds = [...new Set([...(existing.frictionIds ?? []), ...frictionIds])];
    existing.diagnosticCodes = [
      ...new Set([...(existing.diagnosticCodes ?? []), ...(diagnosticCodes ?? [])]),
    ];
    existing.migratedFrom = `${rel}:${line}`;
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

  // Friction registry — catalogRefs on the cited entries (RFC-1590:
  // per-record store updates; a legacy-resident record is left for
  // friction.migrate — commands never write the legacy file).
  const unmatchedFrictions: string[] = [];
  const legacyFrictions: string[] = [];
  for (const fid of frictionIds) {
    try {
      await updateFriction(
        root,
        fid,
        (rec) => {
          const refs = new Set(rec.catalogRefs ?? []);
          refs.add(id);
          return { ...rec, catalogRefs: [...refs] };
        },
        io,
      );
    } catch (e) {
      if (e instanceof LegacyRecordMutationError) legacyFrictions.push(fid);
      else unmatchedFrictions.push(fid);
    }
  }

  // RFC-1466 ordering: an unbound remedy (no diagnosticCodes, no --force)
  // keeps the prose with a pending marker — the catalog entry exists but the
  // bullet stays until a blocking diagnostic carries the remedy code.
  const unbound = (diagnosticCodes?.length ?? 0) === 0 && !force;
  if (unbound) {
    const cleanBullet = bullet.replace(/\s*<!--\s*migrates-to:[^>]*-->\s*/g, "");
    lines[line - 1] = `${cleanBullet} <!-- migrates-to: ${id} pending -->`;
  } else {
    lines.splice(line - 1, 1);
    // drop orphaned sub-bullets / continuation lines more indented than the bullet
    const baseIndent = bullet.match(/^\s*/)![0].length;
    while (line - 1 < lines.length) {
      const next = lines[line - 1]!;
      if (next.trim() === "") break;
      if (/^\s*- /.test(next) && next.match(/^\s*/)![0].length > baseIndent)
        lines.splice(line - 1, 1);
      else if (
        next.match(/^\s+\S/) &&
        !next.startsWith("- ") &&
        next.match(/^\s*/)![0].length > baseIndent
      )
        lines.splice(line - 1, 1);
      else break;
    }
    // collapse double blank lines left behind
    for (let i = line - 1; i > 0 && i < lines.length;) {
      if (lines[i] === "" && lines[i - 1] === "") lines.splice(i, 1);
      else break;
    }
    // collapse an emptied section: nearest heading above the removal point is
    // orphaned when the next non-blank line is another heading or EOF.
    let h = line - 2;
    while (h >= 0 && lines[h]!.trim() === "") h--;
    if (h >= 0 && /^#{1,6}\s/.test(lines[h]!)) {
      const next = lines.find((l, j) => j > h && l.trim() !== "");
      if (!next || /^#{1,6}\s/.test(next)) lines.splice(h, 1);
    }
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
      removedBullet: unbound ? undefined : bullet,
      frictionIds,
      unmatchedFrictions: unmatchedFrictions.length > 0 ? unmatchedFrictions : undefined,
      legacyFrictions: legacyFrictions.length > 0 ? legacyFrictions : undefined,
      pending: unbound ? true : undefined,
    },
    summary: unbound
      ? `Catalog entry ${id} created; scar bullet ${rel}:${line} kept with pending marker (unbound remedy)`
      : `Migrated scar bullet ${rel}:${line} → ${id}`,
    exitCode: 0,
  };
}
