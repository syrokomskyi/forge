/*
<MODULE_CONTRACT>
<purpose>RFC-1578: `correctness.manifest.validate` — checks the product
correctness manifest (`forge/correctness-manifest@1`) and the `correctness`
section of forge.yaml: CORR-01 presence, CORR-02 schema, CORR-03 ref
resolution, CORR-04 code anchors, CORR-05 oracle ↔ checked-by binding,
CORR-06 seam substrate minimums, CORR-07 capture provenance, CORR-08
requirement/DNA coverage, CORR-09 exemption shape. `mode: exempt` evaluates
no rule.</purpose>
<non-goals>
  <item>Do not run oracles, freeze them, or attest substrates — RFC-1580.</item>
  <item>Do not write the manifest or any other file — read-only.</item>
  <item>Do not parse `@ai-invariant` markers directly — anchors.ts delegates to the RFC-1390 parser.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Unparseable YAML is CORR-01 (the manifest is effectively absent); a parsed document that violates the schema is CORR-02.</item>
  <item>A provider entry's L1/L2 oracle satisfies the minimum only when every capture it declares has a valid, unexpired sidecar.</item>
  <item>The clock is injectable so CORR-07 is testable without sleeping.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial validator, rules CORR-01..09.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

import { BINDING_KINDS } from "../../../src/compass/invariant-parser.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { buildAnchorIndex } from "../anchors.ts";
import {
  CAPTURE_SIDECAR_SUFFIX,
  CORRECTNESS_ENTRY_ID_RE,
  SEAM_MINIMUM,
  correctnessCaptureSchema,
  correctnessManifestSchema,
  substrateRank,
  type CorrectnessEntry,
  type CorrectnessManifest,
  type CorrectnessOracle,
  type CorrectnessRuleId,
  type CorrectnessValidateResult,
  type CorrectnessViolation,
  type CoverageCounts,
  type Substrate,
} from "../manifest-schema.ts";
import { readDnaIds, readRequirementsDocument, resolveRfcRef } from "../references.ts";
import {
  listWorkspaceFiles,
  normalizeCheckRef,
  normalizeRelPath,
  readCorrectnessSettings,
} from "../workspace.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CAPTURE_EXPIRY_WARNING_DAYS = 7;

export interface ValidateOptions {
  /** Wall clock for CORR-07 (defaults to Date.now()). */
  now?: number;
}

export interface CaptureStatus {
  capture: string;
  ok: boolean;
  expiringSoon: boolean;
  problem?: string;
}

/** Evaluate one capture file's sidecar provenance and freshness. */
export function evaluateCapture(
  workspaceRoot: string,
  capture: string,
  now: number,
): CaptureStatus {
  const rel = normalizeRelPath(capture);
  try {
    readFileSync(path.join(workspaceRoot, rel));
  } catch {
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `capture file ${rel} is missing`,
    };
  }
  // Canonical sidecar: `<capture file>.capture.yaml`; the extension-less
  // spelling (`draft.json` → `draft.capture.yaml`) is accepted too.
  const candidates = [
    ...new Set([
      `${rel}${CAPTURE_SIDECAR_SUFFIX}`,
      `${rel.replace(/\.[^./]+$/, "")}${CAPTURE_SIDECAR_SUFFIX}`,
    ]),
  ];
  let raw: string | null = null;
  let used = candidates[0]!;
  for (const c of candidates) {
    try {
      raw = readFileSync(path.join(workspaceRoot, c), "utf8");
      used = c;
      break;
    } catch {
      // try next spelling
    }
  }
  if (raw === null) {
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `capture ${rel} has no sidecar (${candidates.join(" or ")})`,
    };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `sidecar ${used} is not YAML: ${(err as Error).message}`,
    };
  }
  const parsed = correctnessCaptureSchema.safeParse(doc);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `sidecar ${used} lacks required provenance (${fields}); needs schema, recordedAt, provider, model, ttlDays, origin`,
    };
  }
  const recorded = Date.parse(parsed.data.recordedAt);
  if (Number.isNaN(recorded)) {
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `sidecar ${used} recordedAt "${parsed.data.recordedAt}" is not a timestamp`,
    };
  }
  const expiresAt = recorded + parsed.data.ttlDays * DAY_MS;
  if (now > expiresAt) {
    const ageDays = Math.floor((now - recorded) / DAY_MS);
    return {
      capture: rel,
      ok: false,
      expiringSoon: false,
      problem: `capture ${rel} is ${ageDays} days old, past its ttlDays ${parsed.data.ttlDays} — re-record it on the live provider`,
    };
  }
  const expiringSoon = expiresAt - now <= CAPTURE_EXPIRY_WARNING_DAYS * DAY_MS;
  return { capture: rel, ok: true, expiringSoon };
}

function emptyCoverage(): CoverageCounts {
  return { total: 0, anchored: 0, exempt: 0, silent: 0 };
}

/** Pure-ish core: evaluate the workspace's correctness manifest. */
export async function validateCorrectnessManifest(
  workspaceRoot: string,
  options: ValidateOptions = {},
): Promise<CorrectnessValidateResult> {
  const now = options.now ?? Date.now();
  const settings = readCorrectnessSettings(workspaceRoot);
  const violations: CorrectnessViolation[] = [];
  const add = (
    rule: CorrectnessRuleId,
    severity: "error" | "warning",
    message: string,
    extra: { entry?: string; ref?: string } = {},
  ) => violations.push({ rule, severity, message, ...extra });

  const result = (
    status: CorrectnessValidateResult["status"],
    coverage = { req: emptyCoverage(), dna: emptyCoverage() },
  ): CorrectnessValidateResult => ({
    command: "correctness.manifest.validate",
    mode: settings.mode,
    tier: settings.tier,
    status,
    manifest: settings.manifestPath,
    coverage,
    violations,
  });

  for (const bad of settings.invalid) {
    const allowed = bad.key === "mode" ? "warn, enforce, exempt" : "standard, high, formal";
    add(
      "CORR-02",
      "error",
      `forge.yaml correctness.${bad.key} "${String(bad.value)}" is invalid — expected one of: ${allowed}`,
    );
  }

  if (settings.mode === "exempt") {
    if (settings.manifestPath) {
      add(
        "CORR-02",
        "error",
        `correctness.mode is exempt but bindings.paths.correctnessManifest is set (${settings.manifestPath}) — a repository without a product runtime declares no manifest; drop one of the two`,
      );
    }
    return result(violations.some((v) => v.severity === "error") ? "fail" : "exempt");
  }

  const gated = settings.mode === "enforce" ? "error" : "warning";
  if (settings.configError) {
    add("CORR-01", gated, `forge.yaml is not readable: ${settings.configError}`);
  }
  if (settings.mode === "enforce" && !settings.checkRun) {
    add(
      "CORR-01",
      "error",
      "correctness.mode is enforce but bindings.commands.checkRun is unset — bind the command that runs one oracle ({file} placeholder)",
    );
  }

  // ── Load the manifest (CORR-01 / CORR-02) ──────────────────────────────
  let manifest: CorrectnessManifest | null = null;
  if (!settings.manifestPath) {
    add(
      "CORR-01",
      gated,
      "bindings.paths.correctnessManifest is unset — the product declares no correctness manifest",
    );
  } else {
    let raw: string | null = null;
    try {
      raw = readFileSync(path.join(workspaceRoot, settings.manifestPath), "utf8");
    } catch {
      add("CORR-01", gated, `correctness manifest ${settings.manifestPath} does not exist`);
    }
    if (raw !== null) {
      let doc: unknown;
      let parsedYaml = true;
      try {
        doc = parseYaml(raw);
      } catch (err) {
        parsedYaml = false;
        add(
          "CORR-01",
          gated,
          `correctness manifest ${settings.manifestPath} is not valid YAML: ${(err as Error).message}`,
        );
      }
      if (parsedYaml) {
        const parsed = correctnessManifestSchema.safeParse(doc ?? {});
        if (parsed.success) {
          manifest = parsed.data;
        } else {
          for (const issue of parsed.error.issues) {
            add(
              "CORR-02",
              "error",
              `manifest schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
            );
          }
        }
      }
    }
  }

  // ── Reference roots ─────────────────────────────────────────────────────
  const reqDoc = readRequirementsDocument(workspaceRoot, settings.compassDocs);
  const dnaIds = readDnaIds(workspaceRoot, settings.invariantsFile);
  const reqIds = new Set(reqDoc.ids);
  const dnaSet = new Set(dnaIds);

  const entries: CorrectnessEntry[] = manifest?.entries ?? [];
  const exemptions = manifest?.exemptions ?? [];

  if (manifest) {
    const files = await listWorkspaceFiles(workspaceRoot);
    const anchorIndex = entries.length > 0 ? buildAnchorIndex(workspaceRoot, files) : null;

    // CORR-02: support globs must match files.
    for (const glob of manifest.support) {
      const matcher = picomatch(normalizeRelPath(glob), { dot: true });
      if (!files.some((f) => matcher(f))) {
        add("CORR-02", "error", `support glob "${glob}" matches no file`);
      }
    }

    const seenIds = new Set<string>();
    for (const entry of entries) {
      const e = { entry: entry.id };
      // CORR-02 entry shape.
      if (!CORRECTNESS_ENTRY_ID_RE.test(entry.id)) {
        add("CORR-02", "error", `entry id "${entry.id}" does not match CM-<scope>-<NN>`, e);
      }
      if (seenIds.has(entry.id)) add("CORR-02", "error", `duplicate entry id ${entry.id}`, e);
      seenIds.add(entry.id);
      if (entry.source === "domain" && !entry.statement) {
        add("CORR-02", "error", `${entry.id}: a domain entry needs a statement`, e);
      }
      if (entry.source !== "domain" && !entry.ref) {
        add("CORR-02", "error", `${entry.id}: a ${entry.source} entry needs a ref`, e);
      }

      // CORR-03 ref resolution.
      if (entry.ref && entry.source !== "domain") {
        const ref = entry.ref;
        if (entry.source === "req" && !reqIds.has(ref)) {
          add(
            "CORR-03",
            "error",
            reqDoc.path
              ? `${entry.id}: requirement ${ref} is not declared in ${reqDoc.path}`
              : `${entry.id}: requirement ${ref} cannot resolve — no compass doc has <document-id>requirements</document-id>`,
            { ...e, ref },
          );
        } else if (entry.source === "dna" && !dnaSet.has(ref)) {
          add(
            "CORR-03",
            "error",
            `${entry.id}: ${ref} is not declared in ${settings.invariantsFile ?? "bindings.paths.invariantsFile (unset)"}`,
            { ...e, ref },
          );
        } else if (entry.source === "rfc-ac" || entry.source === "fixed-input") {
          const res = resolveRfcRef(
            workspaceRoot,
            settings.rfcsDir,
            ref,
            entry.source === "rfc-ac" ? "AC" : "FI",
          );
          if (!res.ok) add("CORR-03", "error", `${entry.id}: ${res.reason}`, { ...e, ref });
        }
      }

      // CORR-04 anchors.
      const bound = new Set<string>();
      for (const anchorId of entry.anchors) {
        const records = anchorIndex?.anchors.get(anchorId) ?? [];
        if (records.length === 0) {
          add(
            "CORR-04",
            "error",
            `${entry.id}: anchor ${anchorId} is declared by no @ai-invariant[${anchorId}] in the repository`,
            e,
          );
          continue;
        }
        const refs = records.flatMap((r) => r.checkedBy);
        if (refs.length === 0) {
          add(
            "CORR-04",
            "error",
            `${entry.id}: anchor ${anchorId} (${records[0]!.file}:${records[0]!.line}) has no checked-by binding`,
            e,
          );
        }
        for (const r of refs) bound.add(r);
      }

      // CORR-05 oracle ↔ checked-by.
      for (const oracle of entry.oracles) {
        const kind = oracle.check.includes(":")
          ? oracle.check.slice(0, oracle.check.indexOf(":")).trim()
          : "";
        if (!BINDING_KINDS.has(kind as never)) {
          add(
            "CORR-05",
            "error",
            `${entry.id}: oracle check "${oracle.check}" is not an RFC-1390 binding reference (test:, type:, lint:, proof:)`,
            e,
          );
          continue;
        }
        if (!bound.has(normalizeCheckRef(oracle.check))) {
          add(
            "CORR-05",
            "error",
            `${entry.id}: oracle ${oracle.check} is not named in the checked-by binding of any anchor of the entry (${entry.anchors.join(", ")})`,
            e,
          );
        }
      }

      // CORR-07 captures (provider entries) and CORR-06 substrate.
      const captureOk = new Map<CorrectnessOracle, boolean>();
      if (entry.seam === "provider") {
        for (const oracle of entry.oracles) {
          let allOk = (oracle.captures ?? []).length > 0;
          for (const capture of oracle.captures ?? []) {
            const status = evaluateCapture(workspaceRoot, capture, now);
            if (!status.ok) {
              allOk = false;
              add("CORR-07", "error", `${entry.id}: ${status.problem}`, e);
            } else if (status.expiringSoon) {
              add(
                "CORR-07",
                "warning",
                `${entry.id}: capture ${status.capture} expires within ${CAPTURE_EXPIRY_WARNING_DAYS} days — schedule a refresh`,
                e,
              );
            }
          }
          captureOk.set(oracle, allOk);
        }
      }
      const minimum = SEAM_MINIMUM[entry.seam];
      const effective = (o: CorrectnessOracle): Substrate | null => {
        if (entry.seam !== "provider") return o.substrate;
        if (o.substrate === "L3") return "L3";
        if ((o.substrate === "L1" || o.substrate === "L2") && captureOk.get(o)) return "L3";
        return null;
      };
      const best = entry.oracles
        .map((o) => effective(o))
        .filter((l): l is Substrate => l !== null)
        .sort((a, b) => substrateRank(b) - substrateRank(a))[0];
      const bestDeclared = [...entry.oracles].sort(
        (a, b) => substrateRank(b.substrate) - substrateRank(a.substrate),
      )[0]!.substrate;
      if (
        entry.seam !== "other" &&
        (best === undefined || substrateRank(best) < substrateRank(minimum))
      ) {
        add(
          "CORR-06",
          "error",
          entry.seam === "provider"
            ? `${entry.id}: seam provider requires L3, or L1/L2 with a fresh capture; best oracle is ${bestDeclared}${bestDeclared === "L0" ? "" : " without a valid capture"}`
            : `${entry.id}: seam ${entry.seam} requires ${minimum}; best oracle is ${bestDeclared}`,
          e,
        );
      }
    }

    // CORR-09 exemptions.
    for (const ex of exemptions) {
      if (ex.kind === "unverifiable" && !ex.reason?.trim()) {
        add("CORR-09", "error", `exemption ${ex.ref}: unverifiable needs a reason`, {
          ref: ex.ref,
        });
      }
      if (ex.kind === "deferred" && !ex.task?.trim()) {
        add("CORR-09", "error", `exemption ${ex.ref}: deferred needs a task`, { ref: ex.ref });
      }
      if (!reqIds.has(ex.ref) && !dnaSet.has(ex.ref)) {
        add("CORR-09", "error", `exemption ${ex.ref} resolves to no requirement id or DNA id`, {
          ref: ex.ref,
        });
      }
    }
  }

  // ── CORR-08 coverage ─────────────────────────────────────────────────────
  const anchoredReq = new Set(
    entries.filter((x) => x.source === "req" && x.ref).map((x) => x.ref!),
  );
  const anchoredDna = new Set(
    entries.filter((x) => x.source === "dna" && x.ref).map((x) => x.ref!),
  );
  const exempted = new Set(exemptions.map((x) => x.ref));
  const coverageOf = (ids: string[], anchored: Set<string>, label: string): CoverageCounts => {
    const counts = { total: ids.length, anchored: 0, exempt: 0, silent: 0 };
    for (const id of ids) {
      if (anchored.has(id)) counts.anchored += 1;
      else if (exempted.has(id)) counts.exempt += 1;
      else {
        counts.silent += 1;
        add("CORR-08", gated, `${label} ${id} has no manifest entry and no exemption`, { ref: id });
      }
    }
    return counts;
  };
  if (!reqDoc.path) {
    add(
      "CORR-08",
      "warning",
      "no compass requirements document — none of bindings.paths.compassDocs has <document-id>requirements</document-id> (expected docs/requirements.xml)",
    );
  }
  const coverage = {
    req: coverageOf(reqDoc.ids, anchoredReq, "requirement"),
    dna: coverageOf(dnaIds, anchoredDna, "DNA"),
  };

  return result(violations.some((v) => v.severity === "error") ? "fail" : "pass", coverage);
}

export async function runCorrectnessManifestValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CorrectnessValidateResult>> {
  const data = await validateCorrectnessManifest(context.workspaceRoot);
  const errors = data.violations.filter((v) => v.severity === "error").length;
  const warnings = data.violations.length - errors;
  if (context.outputFormat === "pretty") {
    for (const v of data.violations) {
      const line = `${v.rule} ${v.message}`;
      if (v.severity === "error") context.logger.error(line);
      else context.logger.warn(line);
    }
  }
  const summary =
    data.status === "exempt"
      ? "correctness.manifest.validate: exempt (correctness.mode: exempt — layer A does not apply)"
      : `correctness.manifest.validate: ${data.status} (mode ${data.mode}, ${errors} error(s), ${warnings} warning(s); req ${data.coverage.req.anchored}/${data.coverage.req.total} anchored, dna ${data.coverage.dna.anchored}/${data.coverage.dna.total} anchored)`;
  return { data, summary, exitCode: data.status === "fail" ? 1 : 0 };
}
