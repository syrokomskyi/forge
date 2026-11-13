/*
<MODULE_CONTRACT>
<purpose>RFC-1580 `correctness.gate` pipeline — (1) validate the manifest at
HEAD (RFC-1578), (2) weakening diff against the frozen set at `--base`,
(3) oracle origin, (4) tier, (5) run non-self oracles through the frozen
`checkRun`, (6) substrate attestation, (7) anchor events, (8) coverage,
(9) bundle, (10) verdict: enforce refuses on any error; warn downgrades
CORR-GATE-03..08; CORR-GATE-02 refuses in both modes unless an isolated
weakening session is accepted.</purpose>
<non-goals>
  <item>Never runs in-process inside flow.integrate — the primary install spawns it.</item>
  <item>No writes except the bundle under the git common dir.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial gate pipeline.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
</CHANGE_SUMMARY>
*/

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ANCHOR_EVENTS_FILE,
  ATTESTATION_FILE,
  CAPTURES_FILE,
  type AnchorEventResult,
  type SubstrateAttestation,
} from "../../../src/correctness/index.ts";
import { schemaHashOf } from "../../../src/correctness/schema-hash.ts";
import { closeSchemas, discoverSchemas } from "../audit/schema-db.ts";
import { loadSnapshot } from "../audit/snapshot.ts";
import { declaredWriters } from "../audit/state-transitions-coverage.ts";
import { evaluateCapture, validateCorrectnessManifest } from "../handlers/validate.ts";
import { SEAM_MINIMUM, substrateRank, type Substrate } from "../manifest-schema.ts";
import { listWorkspaceFiles, normalizeRelPath, readCorrectnessSettings } from "../workspace.ts";
import {
  anchorWeakenings,
  byteWeakenings,
  diffWeakenings,
  readFrozenSet,
  readHeadSide,
} from "./frozen.ts";
import { deriveOrigin, readReviewRecords } from "./origin.ts";
import { checkTarget, GateRepo, sha256 } from "./repo.ts";
import { runOracle } from "./runner.ts";
import {
  BUNDLE_LIMITATIONS,
  CORRECTNESS_BUNDLE_SCHEMA,
  DEFAULT_ORACLE_REVIEWS_DIR,
  DEFAULT_ORACLE_TIMEOUT_MS,
  type BundleEntry,
  type BundleOracle,
  type CorrectnessBundle,
  type CorrectnessGateResult,
  type GateRuleId,
  type GateViolation,
  type Weakening,
} from "./types.ts";

export interface GateOptions {
  base: string;
  acceptWeakening?: string;
  /** Override the bundle directory (tests); default `<git-common-dir>/forge/gate-reports`. */
  bundleDir?: string;
  /** Proof checker for `tier: formal` (`proof:` oracles); default: forge proof.check in-process. */
  proveSpec?: (specRel: string) => Promise<"proved" | string>;
  /** Forge version recorded in the bundle. */
  forgeVersion?: string;
  forgePath?: string;
}

export type GateOutcome =
  | { ok: true; result: CorrectnessGateResult; bundle: CorrectnessBundle }
  | { ok: false; usageError: string };

const DOWNGRADE_IN_WARN: ReadonlySet<GateRuleId> = new Set([
  "CORR-GATE-03",
  "CORR-GATE-04",
  "CORR-GATE-05",
  "CORR-GATE-06",
  "CORR-GATE-07",
  "CORR-GATE-08",
]);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function defaultProve(root: string, specRel: string): Promise<string> {
  const { runProofCheckCommand } = await import("../../formal/handlers/proof-check.ts");
  const res = await runProofCheckCommand(
    { argv: [], flags: { spec: specRel } },
    {
      workspaceRoot: root,
      dryRun: false,
      outputFormat: "json",
      logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
    },
  );
  const verdict = (res.data?.verdict as { verdict?: string } | null)?.verdict;
  return verdict ?? "error";
}

export async function runCorrectnessGate(root: string, options: GateOptions): Promise<GateOutcome> {
  const repo = new GateRepo(root);
  const base = await repo.revParse(options.base);
  if (!base)
    return { ok: false, usageError: `--base ${options.base} does not resolve to a commit` };
  const head = (await repo.revParse("HEAD")) ?? "HEAD";
  const settings = readCorrectnessSettings(root);
  const violations: GateViolation[] = [];
  const add = (rule: GateRuleId, message: string, extra: { entry?: string; check?: string } = {}) =>
    violations.push({ rule, severity: "error", message, ...extra });

  // The gate runs oracles on the working tree but derives origin from HEAD.
  const dirty =
    (await repo.git.run(["status", "--porcelain", "--untracked-files=no"]))?.trim() ?? "";
  if (dirty.length > 0) {
    violations.push({
      rule: "CORR-GATE-01",
      severity: "warning",
      message:
        "the session worktree has uncommitted tracked changes — oracles ran on the working tree while origins were derived from HEAD",
    });
  }

  // (1) Validate at HEAD.
  const validation = await validateCorrectnessManifest(root);
  const mode = validation.mode;
  const bundleBase = {
    schema: CORRECTNESS_BUNDLE_SCHEMA,
    repository: settings.config?.project?.name ?? path.basename(root),
    base,
    head,
    mode,
    tier: validation.tier,
    gateBuild: {
      forge: options.forgeVersion ?? "unknown",
      path: options.forgePath ?? "$FLOW_PRIMARY/node_modules/.bin/forge",
    },
    limitations: BUNDLE_LIMITATIONS,
  };
  const finish = async (
    status: CorrectnessGateResult["status"],
    entries: BundleEntry[],
    weakenings: (Weakening & { accepted: boolean })[],
    accepted: string | null,
  ): Promise<GateOutcome> => {
    const bundle: CorrectnessBundle = { ...bundleBase, entries, weakenings, violations };
    const dir =
      options.bundleDir ??
      path.join((await repo.commonDir()) ?? path.join(root, ".git"), "forge", "gate-reports");
    mkdirSync(dir, { recursive: true });
    // RFC-1532 naming (`<branch>-<ts>…json`) so the gate-report retention pruner covers bundles.
    const branch = (
      (await repo.git.run(["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "detached"
    ).replace(/[^A-Za-z0-9._-]+/g, "-");
    const runId = `${branch}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${process.pid}`;
    const bundlePath = path.join(dir, `${runId}.correctness.json`);
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    return {
      ok: true,
      bundle,
      result: {
        command: "correctness.gate",
        mode,
        status,
        bundlePath,
        violations,
        weakenings,
        acceptedWeakening: accepted,
      },
    };
  };
  // (2) Frozen set first: `mode: exempt` ends the gate only when the base was
  // exempt too — a session cannot exempt itself (that is a CORR-GATE-02).
  const frozen = await readFrozenSet(repo, base);
  if (validation.status === "exempt" && frozen.base.mode === "exempt")
    return finish("exempt", [], [], null);
  for (const v of validation.violations) {
    if (v.severity === "error")
      add("CORR-GATE-01", `${v.rule}${v.entry ? ` ${v.entry}` : ""}: ${v.message}`);
  }
  if (!settings.manifestPath) {
    violations.push({
      rule: "CORR-GATE-01",
      severity: "warning",
      message: "no correctness manifest bound — the gate checks only weakenings",
    });
  }

  // Weakening diff against the frozen set.
  const readWorking = (rel: string): string | null => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const now = readHeadSide(root, readWorking);
  const files = await listWorkspaceFiles(root);
  if (frozen.baseManifestUnreadable) {
    add(
      "CORR-GATE-02",
      `the base manifest ${frozen.base.manifestPath} does not parse with this forge — the frozen set cannot be read; integrate with a forge that reads it`,
    );
  }
  const weakenings: Weakening[] = [
    ...diffWeakenings(frozen, now),
    ...(await byteWeakenings(repo, base, head, frozen.files)),
    ...anchorWeakenings(root, files, frozen),
  ];
  let acceptedReason: string | null = null;
  if (weakenings.length > 0) {
    const reason = options.acceptWeakening?.trim();
    if (reason) {
      const frozenPaths = new Set([
        ...frozen.files,
        "forge.yaml",
        ...[frozen.base.manifestPath, now.manifestPath]
          .filter((p): p is string => !!p)
          .map(normalizeRelPath),
      ]);
      const changed = await repo.changedPaths(base, head);
      const foreign = changed.filter((p) => !frozenPaths.has(p));
      if (foreign.length === 0) acceptedReason = reason;
      else {
        add(
          "CORR-GATE-02",
          `mixed-weakening: --accept-weakening needs a session whose diff touches frozen-set paths only; also changed: ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? " …" : ""}`,
        );
      }
    }
    if (acceptedReason === null)
      for (const w of weakenings) add("CORR-GATE-02", `weakening (${w.kind}): ${w.message}`);
  }
  const weakeningRecords = weakenings.map((w) => ({ ...w, accepted: acceptedReason !== null }));

  // (3)–(8) per entry.
  const entries: BundleEntry[] = [];
  const manifest = now.manifest;
  const reviews = await readReviewRecords(repo, head, now.reviewsDir ?? DEFAULT_ORACLE_REVIEWS_DIR);
  const checkRun = frozen.base.checkRun ?? now.checkRun;
  const section = (settings.config?.correctness ?? {}) as Record<string, unknown>;
  const timeoutMs =
    typeof section["oracleTimeoutMs"] === "number" && (section["oracleTimeoutMs"] as number) > 0
      ? (section["oracleTimeoutMs"] as number)
      : DEFAULT_ORACLE_TIMEOUT_MS;
  const runRoot = mkdtempSync(path.join(os.tmpdir(), "forge-correctness-run-"));
  let expectedHashes: Set<string> | null = null;
  const expected = async (): Promise<Set<string>> => {
    if (expectedHashes) return expectedHashes;
    const snap = await loadSnapshot(root, { kind: "worktree" }, declaredWriters);
    const discovery = snap ? discoverSchemas(snap) : null;
    expectedHashes = new Set(discovery ? discovery.schemas.map((s) => schemaHashOf(s.db)) : []);
    if (discovery) closeSchemas(discovery);
    return expectedHashes;
  };
  const tier = validation.tier;

  for (const entry of manifest?.entries ?? []) {
    const bundleEntry: BundleEntry = {
      id: entry.id,
      ref: entry.ref ?? null,
      seam: entry.seam,
      covered: false,
      oracles: [],
    };
    let anyNonSelf = false;
    let anyTierOk = false;
    let anyRunOk = false;
    let anyAttested = false;
    for (const [i, oracle] of entry.oracles.entries()) {
      const file = checkTarget(oracle.check);
      const origin = await deriveOrigin({
        repo,
        head,
        check: oracle.check,
        source: entry.source,
        ref: entry.ref ?? null,
        rfcsDir: settings.rfcsDir,
        reviews,
        checkFile: file,
        integrationBase: base,
      });
      const record: BundleOracle = {
        check: oracle.check,
        origin: origin.origin,
        originDetail: origin.detail,
        declaredSubstrate: oracle.substrate,
        attestation: null,
        command: null,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        anchorEvents: [],
        covers: false,
      };
      bundleEntry.oracles.push(record);
      if (origin.origin === "self") continue;
      anyNonSelf = true;
      const tierOk = tier === "high" || tier === "formal" ? origin.viaTrailer : true;
      if (tierOk) anyTierOk = true;
      // proof: oracles are judged by proof.check (tier formal), never through checkRun.
      if (oracle.check.startsWith("proof:")) {
        record.covers = false;
        continue;
      }
      if (!checkRun || !file) {
        add(
          "CORR-GATE-07",
          `${entry.id}: oracle ${oracle.check} cannot run — ${!checkRun ? "bindings.commands.checkRun is unset" : "check has no file"}`,
          { entry: entry.id, check: oracle.check },
        );
        continue;
      }
      // (5) Run in a fresh per-oracle directory.
      const runDir = path.join(runRoot, entry.id, `o${i}`);
      mkdirSync(runDir, { recursive: true });
      const run = await runOracle({ cwd: root, template: checkRun, file, runDir, timeoutMs });
      record.command = run.command;
      record.exitCode = run.exitCode;
      record.timedOut = run.timedOut;
      record.durationMs = run.durationMs;
      if (run.failureClass !== "none") {
        add(
          "CORR-GATE-07",
          `${entry.id}: oracle ${oracle.check} ${run.timedOut ? `timed out after ${timeoutMs}ms (timeout class)` : run.failureClass === "spawn" ? `could not start: ${run.outputTail}` : `exited ${run.exitCode}`}`,
          { entry: entry.id, check: oracle.check },
        );
        continue;
      }
      anyRunOk = true;
      // (6) Attestation.
      let effective: Substrate = oracle.substrate;
      if (oracle.substrate === "L1" || oracle.substrate === "L2") {
        const att = readJson<SubstrateAttestation>(path.join(runDir, ATTESTATION_FILE));
        const hashes = await expected();
        const matches = !!att && att.level === oracle.substrate && hashes.has(att.schemaHash);
        record.attestation = att ? { ...att, matches } : null;
        if (!matches) {
          add(
            "CORR-GATE-04",
            `${entry.id}: oracle ${oracle.check} declares ${oracle.substrate} but ${att ? `its attestation (${att.level}, ${att.schemaHash.slice(0, 12)}) does not match the repository migrations` : "left no attestation (attestSubstrate)"} — counted as L0`,
            { entry: entry.id, check: oracle.check },
          );
          effective = "L0";
        }
      }
      // A declared L3 is never trusted on declaration alone: without declared,
      // fresh captures loaded through loadCapture it counts as L0.
      if (oracle.substrate === "L3" && (oracle.captures ?? []).length === 0) {
        add(
          "CORR-GATE-04",
          `${entry.id}: oracle ${oracle.check} declares L3 without captures — a live run leaves no evidence the gate can check; record captures (loadCapture) — counted as L0`,
          { entry: entry.id, check: oracle.check },
        );
        effective = "L0";
      }
      // Captures: loaded files must be the declared, fresh captures.
      if ((oracle.captures ?? []).length > 0) {
        const loaded =
          readJson<{ path: string; sha256: string }[]>(path.join(runDir, CAPTURES_FILE)) ?? [];
        const declared = new Set((oracle.captures ?? []).map(normalizeRelPath));
        const fresh = (oracle.captures ?? []).every((c) => evaluateCapture(root, c, Date.now()).ok);
        const honest =
          loaded.length > 0 &&
          loaded.every(
            (l) =>
              declared.has(normalizeRelPath(l.path)) &&
              sha256(readWorking(normalizeRelPath(l.path)) ?? "") === l.sha256,
          );
        if (fresh && honest && effective !== "L0") {
          if (entry.seam === "provider") effective = "L3";
        } else if (!honest) {
          effective = "L0";
          add(
            "CORR-GATE-04",
            `${entry.id}: oracle ${oracle.check} did not load its declared captures through loadCapture`,
            { entry: entry.id, check: oracle.check },
          );
        }
      }
      // (7) Anchor events.
      let anchorsOk = true;
      if (entry.seam === "lifecycle" && substrateRank(oracle.substrate) >= substrateRank("L2")) {
        const events = readJson<AnchorEventResult[]>(path.join(runDir, ANCHOR_EVENTS_FILE)) ?? [];
        record.anchorEvents = events;
        const failed = events.filter((e) => !e.ok);
        for (const f of failed) {
          add(
            "CORR-GATE-05",
            `${entry.id}: forge.anchor ${f.anchor} failed verification — ${f.reason ?? "mismatch"}`,
            { entry: entry.id, check: oracle.check },
          );
        }
        const missing = entry.anchors.filter((a) => !events.some((e) => e.anchor === a && e.ok));
        for (const a of missing) {
          add(
            "CORR-GATE-05",
            `${entry.id}: no verified forge.anchor event for ${a} in the L2 run of ${oracle.check}`,
            { entry: entry.id, check: oracle.check },
          );
        }
        anchorsOk = failed.length === 0 && missing.length === 0;
      }
      const meetsSeam = substrateRank(effective) >= substrateRank(SEAM_MINIMUM[entry.seam]);
      if (meetsSeam && effective !== "L0") anyAttested = true;
      else if (entry.seam === "other") anyAttested = true;
      record.covers = tierOk && meetsSeam && anchorsOk;
    }
    // (4) Formal tier: a proved proof: oracle per entry.
    let formalOk = true;
    if (tier === "formal") {
      const proofs = entry.oracles
        .map((o, i) => ({ o, rec: bundleEntry.oracles[i]! }))
        .filter(({ o, rec }) => o.check.startsWith("proof:") && rec.origin !== "self");
      formalOk = false;
      for (const { o: p } of proofs) {
        const spec = checkTarget(p.check);
        if (!spec) continue;
        const verdict = await (options.proveSpec
          ? options.proveSpec(spec)
          : defaultProve(root, spec));
        if (verdict === "proved") formalOk = true;
      }
      if (!formalOk)
        add(
          "CORR-GATE-06",
          `${entry.id}: tier formal needs a non-self proof: oracle whose proof.check verdict is proved`,
          { entry: entry.id },
        );
    }
    if (!anyNonSelf)
      add(
        "CORR-GATE-03",
        `${entry.id}: every oracle has origin self — add a committed forge/oracle-review@1 record naming its sha256`,
        { entry: entry.id },
      );
    else if (!anyTierOk && (tier === "high" || tier === "formal")) {
      add(
        "CORR-GATE-06",
        `${entry.id}: tier ${tier} needs an oracle last changed by a verifier-trailer commit`,
        { entry: entry.id },
      );
    }
    bundleEntry.covered = formalOk && bundleEntry.oracles.some((o) => o.covers);
    if (!bundleEntry.covered) {
      add(
        "CORR-GATE-08",
        `${entry.id}: no oracle is non-self, passing, attested at or above ${SEAM_MINIMUM[entry.seam]}${entry.seam === "lifecycle" ? ", and anchor-verified" : ""}${anyRunOk && !anyAttested ? " (runs passed below the seam minimum)" : ""}`,
        { entry: entry.id },
      );
    }
    entries.push(bundleEntry);
  }

  rmSync(runRoot, { recursive: true, force: true });

  // (10) Verdict.
  if (mode === "warn") {
    for (const v of violations) if (DOWNGRADE_IN_WARN.has(v.rule)) v.severity = "warning";
  }
  const status = violations.some((v) => v.severity === "error") ? "fail" : "pass";
  return finish(status, entries, weakeningRecords, acceptedReason);
}
