/*
<MODULE_CONTRACT>
<purpose>system.versionset.record command handler (RFC-1511): runs every check
of every named business scenario inside a temporary detached worktree of the
product at the named forge/release-tag@1 tag, then writes
system/version-sets/VS-NNNN.yaml with sha256 evidence per scenario only when
all checks exit 0. No partial sets — a failing check leaves logs but no set
file (DNA-106).</purpose>
<non-goals>
  <item>No scheduling — the operator runs the command; no published-package pins (stage 3).</item>
  <item>No dispatch — a set is evidence, system.task.move --to verified reads it later.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Checks run with argv vectors and no shell, cwd inside the detached tag worktree — the product's primary checkout stays on develop.</item>
  <item>The product's own hooks/worktree-setup.sh (from the primary, like flow.open) prepares each tag worktree before checks run.</item>
  <item>--dry-run validates the whole declaration layer (flags, scenarios, folders, tags) and stops before any worktree or write.</item>
  <item>exec spawn rejections map to SYSTEM-VS-04 (distinct from timeout exitCode:null); each worktree removal failure maps to SYSTEM-VS-05 so one stuck removal never skips the rest.</item>
  <item>%(refname) pins the tag match exactly — for-each-ref patterns are globs; folders lookup goes through Object.hasOwn so product ids like "constructor" stay legal.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1511: step 3 — versionset.record handler</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
  <item>RFC-1511: accept recorded products map in verified gate, guard folders lookup and exec edges (RFC-1511 review r1)</item>
  <item>RFC-1511: record KEY_DECISIONS for exported tag-schema regex and exec edge handling (RFC-1511 review r1)</item>
  <item>RFC-1541: version-set@2 contracts with validator and pin-drift scenario checks</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { git } from "../../flow/git.ts";
import { RELEASE_TAG_SCHEMA_LINE } from "../../flow/release-tags.ts";
import { runFlowScript } from "../../flow/scripts.ts";
import { assertSystemRepository, loadScenarios, loadSystemMap, type SystemMap } from "../repo.ts";
import {
  SYSTEM_VERSION_SETS_DIR,
  versionSetSchema,
  type PinDriftCheck,
  type SystemScenario,
  type VersionSet,
} from "../scenario-schemas.ts";
import { contractProducerSchema } from "../../../src/config/forge-config.ts";
import {
  runProducerConformance,
  type ContractProducerDecl,
} from "../../../src/conformance/index.ts";

export interface VersionSetRecordResult {
  command: "system.versionset.record";
  id: string | null;
  products: Record<string, string>;
  scenarios: string[];
  evidence: Record<string, string>;
  /** RFC-1541: product → package → version resolved at each tag. */
  contracts: Record<string, Record<string, string>>;
  /** RFC-1541: warning-only findings recorded in the set (pin drift). */
  warnings: VersionSetWarning[];
  created: boolean;
  diagnostics: Diagnostic[];
}

export interface VersionSetWarning {
  code: string;
  product?: string;
  package?: string;
  from?: string;
  to?: string;
  message: string;
}

/** RFC-1541: the contract packages a product declares in its forge.yaml (spec packages + validator packages). */
function declaredContractPackages(forgeYaml: unknown): string[] {
  const doc = (forgeYaml ?? {}) as {
    specPackages?: Array<{ package?: unknown }>;
    contractProducers?: Array<{ consumer?: { package?: unknown } }>;
  };
  const out = new Set<string>();
  for (const e of doc.specPackages ?? []) if (typeof e?.package === "string") out.add(e.package);
  for (const e of doc.contractProducers ?? []) {
    if (typeof e?.consumer?.package === "string") out.add(e.consumer.package);
  }
  return [...out].sort();
}

/** Root-importer version from a pnpm v9 lockfile, peer suffix stripped; null when absent. */
export function lockfileVersion(lockYaml: unknown, pkg: string): string | null {
  const importer = (
    lockYaml as {
      importers?: Record<string, Record<string, Record<string, { version?: unknown }>>>;
    }
  )?.importers?.["."];
  for (const field of ["dependencies", "devDependencies"]) {
    const v = importer?.[field]?.[pkg]?.version;
    if (typeof v === "string") return v.split("(")[0]!;
  }
  return null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number(x));
  const pb = b.split(/[.+-]/).map((x) => Number(x));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function diag(
  ruleId: string,
  severity: Diagnostic["severity"],
  message: string,
  fixHint?: string,
  file?: string,
): Diagnostic {
  return { ruleId, severity, ...(file ? { file } : {}), message, ...(fixHint ? { fixHint } : {}) };
}

/** Parse "a=v1.2.3,b=v0.9.0" into product→tag entries; malformed entries are SYSTEM-VS-01. */
function parseProductsFlag(
  raw: string | undefined,
  diagnostics: Diagnostic[],
): Map<string, string> | null {
  if (raw === undefined || raw.trim() === "") {
    diagnostics.push(
      diag(
        "SYSTEM-VS-01",
        "error",
        "--products <product=tag,…> is required",
        "Pass the release combination, e.g. --products alpha=v1.2.3,beta=v0.9.0.",
      ),
    );
    return null;
  }
  const out = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      diagnostics.push(
        diag(
          "SYSTEM-VS-01",
          "error",
          `malformed --products entry "${trimmed}" — expected <product>=<tag>`,
        ),
      );
      continue;
    }
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

function parseScenariosFlag(raw: string | undefined, diagnostics: Diagnostic[]): string[] | null {
  if (raw === undefined || raw.trim() === "") {
    diagnostics.push(
      diag(
        "SYSTEM-VS-01",
        "error",
        "--scenarios <id,…> is required",
        "Pass the scenario ids declared under system/scenarios/.",
      ),
    );
    return null;
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    diagnostics.push(
      diag(
        "SYSTEM-VS-01",
        "error",
        "--scenarios names no scenario ids",
        "Pass at least one scenario id declared under system/scenarios/.",
      ),
    );
    return null;
  }
  return ids;
}

/** Verify the tag exists locally and is an annotated forge/release-tag@1 tag (SYSTEM-VS-03). */
async function checkReleaseTag(
  io: ReturnType<typeof resolveIo>,
  productRoot: string,
  product: string,
  tag: string,
): Promise<Diagnostic | null> {
  const sep = "\x1f";
  const res = await git(productRoot, io, [
    "for-each-ref",
    `refs/tags/${tag}`,
    `--format=%(refname)${sep}%(objecttype)${sep}%(contents)`,
  ]);
  // %(contents) is multi-line — split on the first two field separators only;
  // %(refname) pins the match exactly (the pattern is a glob).
  const firstSep = res.stdout.indexOf(sep);
  const secondSep = firstSep === -1 ? -1 : res.stdout.indexOf(sep, firstSep + 1);
  const refname = firstSep === -1 ? "" : res.stdout.slice(0, firstSep);
  const objecttype = secondSep === -1 ? "" : res.stdout.slice(firstSep + 1, secondSep);
  const contents = secondSep === -1 ? "" : res.stdout.slice(secondSep + 1);
  if (res.exitCode !== 0 || refname !== `refs/tags/${tag}`) {
    return diag(
      "SYSTEM-VS-03",
      "error",
      `product "${product}" has no local tag "${tag}"`,
      `Fetch or cut the release tag in the ${product} checkout before recording a version set.`,
    );
  }
  if (objecttype !== "tag" || !RELEASE_TAG_SCHEMA_LINE.test(contents)) {
    return diag(
      "SYSTEM-VS-03",
      "error",
      `product "${product}" tag "${tag}" is not a forge/release-tag@1 annotation`,
      `Version sets only accept annotated release tags cut by flow.cut.`,
    );
  }
  return null;
}

/** Highest VS-NNNN under system/version-sets/ plus one. */
async function nextVersionSetId(root: string, io: ReturnType<typeof resolveIo>): Promise<string> {
  const dir = path.join(root, SYSTEM_VERSION_SETS_DIR);
  let max = 0;
  let isDir = false;
  try {
    isDir = (await io.stat(dir)).isDirectory;
  } catch {
    isDir = false;
  }
  if (isDir) {
    try {
      for (const entry of await io.readdir(dir)) {
        const m = /^VS-(\d{4})\.yaml$/.exec(entry.name);
        if (entry.isFile && m) max = Math.max(max, Number.parseInt(m[1]!, 10));
      }
    } catch {
      // dir vanished between stat and readdir — start at VS-0001
    }
  }
  return `VS-${String(max + 1).padStart(4, "0")}`;
}

export async function runSystemVersionSetRecord(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<VersionSetRecordResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun === true || input.flags["dry-run"] === true;

  const refusal = await assertSystemRepository(root, io);
  let map: SystemMap | null = null;
  if (refusal) {
    diagnostics.push(refusal);
  } else {
    const loaded = await loadSystemMap(root, io);
    diagnostics.push(...loaded.diagnostics);
    map = loaded.map;
  }

  const strFlag = (name: string): string | undefined => {
    const v = input.flags[name];
    return typeof v === "string" ? v : undefined;
  };
  const productTags = parseProductsFlag(strFlag("products"), diagnostics);
  const scenarioIds = parseScenariosFlag(strFlag("scenarios"), diagnostics);

  const scenarios: SystemScenario[] = [];
  if (map && scenarioIds) {
    const loaded = await loadScenarios(root, io);
    diagnostics.push(...loaded.diagnostics);
    for (const id of scenarioIds) {
      const scenario = loaded.scenarios.get(id);
      if (!scenario) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-01",
            "error",
            `unknown or unloadable scenario "${id}" — no valid ${`system/scenarios/${id}.yaml`}`,
            "Declare the scenario under system/scenarios/ or fix the id.",
          ),
        );
        continue;
      }
      scenarios.push(scenario);
    }
  }

  // Products the named scenarios actually exercise: scenario.products plus
  // every check's product (a check may name a product the products[] list omits).
  const neededProducts = new Set<string>();
  for (const scenario of scenarios) {
    for (const p of scenario.products) neededProducts.add(p);
    for (const check of scenario.checks)
      if (check.kind !== "pin-drift") neededProducts.add(check.product);
  }

  const productRoots = new Map<string, string>();
  if (map && productTags) {
    for (const product of neededProducts) {
      if (!productTags.has(product)) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-02",
            "error",
            `scenario needs product "${product}" but --products does not name it`,
            `Add ${product}=<release-tag> to --products.`,
          ),
        );
        continue;
      }
      const folder =
        map.local !== null && Object.hasOwn(map.local.folders, product)
          ? map.local.folders[product]
          : undefined;
      if (!folder) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-02",
            "error",
            `product "${product}" has no local checkout — absent from system/products.local.yaml`,
            `Map "${product}" to a local folder in system/products.local.yaml.`,
          ),
        );
        continue;
      }
      const productRoot = path.isAbsolute(folder) ? folder : path.join(root, folder);
      let isDir = false;
      try {
        isDir = (await io.stat(productRoot)).isDirectory;
      } catch {
        isDir = false;
      }
      if (!isDir) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-02",
            "error",
            `product "${product}" local folder does not exist: ${folder}`,
            `Check out the ${product} repository at ${folder}.`,
          ),
        );
        continue;
      }
      productRoots.set(product, productRoot);
      const tagDiag = await checkReleaseTag(io, productRoot, product, productTags.get(product)!);
      if (tagDiag) diagnostics.push(tagDiag);
    }
  }

  const result: VersionSetRecordResult = {
    command: "system.versionset.record",
    id: null,
    products: productTags ? Object.fromEntries(productTags) : {},
    scenarios: scenarioIds ?? [],
    evidence: {},
    contracts: {},
    warnings: [],
    created: false,
    diagnostics,
  };

  let errors = diagnostics.filter((d) => d.severity === "error").length;
  if (dryRun || errors > 0 || !map || !productTags) {
    return {
      data: result,
      exitCode: errors > 0 ? 1 : 0,
      summary: `system.versionset.record${dryRun ? " (dry-run)" : ""}: ${errors} error(s) — no set written`,
    };
  }

  // --- Recording pass: tag worktrees, setup hooks, checks, evidence, set file.
  const id = await nextVersionSetId(root, io);
  result.id = id;
  const evidenceDir = path.join(root, SYSTEM_VERSION_SETS_DIR, "evidence", id);
  const worktrees = new Map<string, string>();
  let aborted: Diagnostic | null = null;

  try {
    for (const [product, productRoot] of productRoots) {
      const tmp = await io.mkdtemp(path.join(os.tmpdir(), `versionset-${product}-`));
      const added = await git(productRoot, io, [
        "worktree",
        "add",
        "--detach",
        tmp,
        productTags.get(product)!,
      ]);
      if (added.exitCode !== 0) {
        aborted = diag(
          "SYSTEM-VS-04",
          "error",
          `could not create the detached worktree for "${product}" at ${productTags.get(product)}: ${added.stderr.trim()}`,
        );
        break;
      }
      worktrees.set(product, tmp);
      const setup = await runFlowScript(io, "worktree-setup", {
        primary: productRoot,
        cwd: tmp,
        env: { FLOW_PRIMARY: productRoot, FLOW_BRANCH: productTags.get(product)! },
      });
      if (setup.status === "failed") {
        aborted = diag(
          "SYSTEM-VS-04",
          "error",
          `worktree-setup for "${product}" failed (exit ${setup.exitCode}): ${setup.stderrTail}`,
          `Fix ${productRoot}/hooks/worktree-setup.sh — no set file is written.`,
        );
        break;
      }
    }

    // RFC-1541: resolve the contract package versions each product carries at its tag.
    for (const [product, tmp] of worktrees) {
      if (aborted) break;
      let forgeYaml: unknown = null;
      try {
        forgeYaml = YAML.parse(await io.readFile(path.join(tmp, "forge.yaml")));
      } catch {
        forgeYaml = null;
      }
      const packages = declaredContractPackages(forgeYaml);
      if (packages.length === 0) continue;
      let lock: unknown = null;
      try {
        lock = YAML.parse(await io.readFile(path.join(tmp, "pnpm-lock.yaml")));
      } catch {
        lock = null;
      }
      const resolved: Record<string, string> = {};
      for (const pkg of packages) {
        let version = lockfileVersion(lock, pkg);
        if (version === null) {
          try {
            const manifest = JSON.parse(
              await io.readFile(path.join(tmp, "node_modules", ...pkg.split("/"), "package.json")),
            ) as { version?: unknown };
            version = typeof manifest.version === "string" ? manifest.version : null;
          } catch {
            version = null;
          }
        }
        if (version === null) {
          aborted = diag(
            "SYSTEM-VS-06",
            "error",
            `"${product}" declares contract package ${pkg} but its version cannot be resolved at ${productTags.get(product)} (no root lockfile entry, not installed)`,
            "Add the package as an exact root dependency and commit the lockfile in the product release.",
          );
          break;
        }
        resolved[pkg] = version;
      }
      result.contracts[product] = resolved;
    }

    for (const scenario of scenarios) {
      if (aborted) break;
      const log: string[] = [];
      for (const check of scenario.checks) {
        if (check.kind === "pin-drift") {
          log.push(...(await runPinDrift(check, scenario, result, io, root)));
          continue;
        }
        const cwd = worktrees.get(check.product)!;
        if (check.kind === "validator") {
          const outcome = await runValidatorCheck(check.producer, check.product, cwd, result, io);
          log.push(...outcome.log);
          if (outcome.failure) {
            aborted = diag(
              outcome.failure.code,
              "error",
              `scenario "${scenario.id}" validator check failed in "${check.product}" (producer ${check.producer}) — ${outcome.failure.message}`,
              "Fix the producer, its pinned validator, or the release — no set file is written.",
            );
            break;
          }
          continue;
        }
        log.push(`### ${check.product}$ ${check.argv.join(" ")}\n`);
        let res;
        let spawnError = "";
        try {
          res = await io.exec(check.argv[0]!, check.argv.slice(1), {
            cwd,
            timeoutMs: check.timeoutSec * 1000,
          });
        } catch (error) {
          res = { exitCode: null as number | null, stdout: "", stderr: "" };
          spawnError = error instanceof Error ? error.message : String(error);
        }
        log.push(res.stdout, res.stderr !== "" ? res.stderr : spawnError);
        if (res.exitCode !== 0) {
          aborted = diag(
            "SYSTEM-VS-04",
            "error",
            `scenario "${scenario.id}" check failed in "${check.product}" (${check.argv.join(" ")}) — ` +
              (spawnError !== ""
                ? spawnError
                : res.exitCode === null
                  ? `timed out after ${check.timeoutSec}s`
                  : `exit ${res.exitCode}`),
            "Fix the check or the product release — no set file is written.",
          );
          break;
        }
      }
      await io.mkdir(evidenceDir);
      const logText = log.join("");
      await io.writeFile(path.join(evidenceDir, `${scenario.id}.log`), logText);
      if (!aborted) {
        result.evidence[scenario.id] =
          `sha256:${createHash("sha256").update(logText).digest("hex")}`;
      }
    }
  } finally {
    for (const [product, tmp] of worktrees) {
      let removalNote = "";
      try {
        const removed = await git(productRoots.get(product)!, io, [
          "worktree",
          "remove",
          "--force",
          tmp,
        ]);
        removalNote = removed.exitCode === 0 ? "" : removed.stderr.trim();
      } catch (error) {
        removalNote = error instanceof Error ? error.message : String(error);
      }
      if (removalNote !== "") {
        diagnostics.push(
          diag(
            "SYSTEM-VS-05",
            "warning",
            `temporary worktree ${tmp} for "${product}" could not be removed: ${removalNote}`,
            `Remove it manually with: git -C ${productRoots.get(product)} worktree remove --force ${tmp}`,
          ),
        );
      }
    }
  }

  if (aborted) {
    diagnostics.push(aborted);
  } else {
    const set: VersionSet = {
      schema: "forge/version-set@2",
      id,
      products: result.products,
      contracts: result.contracts,
      scenarios: scenarios.map((s) => s.id),
      evidence: result.evidence,
      warnings: result.warnings,
      verifiedAt: new Date().toISOString(),
    };
    const parsed = versionSetSchema.safeParse(set);
    if (!parsed.success) {
      diagnostics.push(
        diag(
          "SYSTEM-VS-04",
          "error",
          `internal: assembled set failed schema: ${parsed.error.message}`,
        ),
      );
    } else {
      await io.mkdir(path.join(root, SYSTEM_VERSION_SETS_DIR));
      await io.writeFile(
        path.join(root, SYSTEM_VERSION_SETS_DIR, `${id}.yaml`),
        YAML.stringify(parsed.data),
      );
      result.created = true;
    }
  }

  result.diagnostics = diagnostics;
  errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: result,
    exitCode: errors > 0 ? 1 : 0,
    summary: result.created
      ? `system.versionset.record: ${id} recorded — ${scenarios.length} scenario(s), ${worktrees.size} product worktree(s)`
      : `system.versionset.record: ${errors} error(s) — no set written`,
    nextSteps: result.created
      ? [
          {
            action: `Reference ${id} from system.task.move --to verified when a task proves this combination`,
            kind: "optional" as const,
          },
        ]
      : [{ action: "Fix the error-severity diagnostics and re-run", kind: "required" as const }],
  };
}

// ---------------------------------------------------------------------------
// RFC-1541 check kinds
// ---------------------------------------------------------------------------

/**
 * `validator`: run the producer's golden conformance through the shared
 * execution path (`runProducerConformance`, the same path forge.conformance.run
 * uses) against the tag worktree. Only a `consumer.package` producer counts.
 */
async function runValidatorCheck(
  producerId: string,
  product: string,
  cwd: string,
  result: VersionSetRecordResult,
  io: ReturnType<typeof resolveIo>,
): Promise<{ log: string[]; failure: { code: string; message: string } | null }> {
  const log = [
    `### ${product}$ forge.conformance.run --producer ${producerId} --require-consumer\n`,
  ];
  let forgeYaml: { contractProducers?: unknown[] } | null = null;
  try {
    forgeYaml = YAML.parse(await io.readFile(path.join(cwd, "forge.yaml"))) as {
      contractProducers?: unknown[];
    };
  } catch {
    forgeYaml = null;
  }
  const raw = (forgeYaml?.contractProducers ?? []).find(
    (p) => (p as { id?: unknown })?.id === producerId,
  );
  const parsed = raw === undefined ? null : contractProducerSchema.safeParse(raw);
  if (!parsed || !parsed.success) {
    return {
      log,
      failure: {
        code: "SYSTEM-VS-07",
        message: `producer "${producerId}" is not declared (or malformed) in ${product}'s forge.yaml at this tag`,
      },
    };
  }
  const decl = parsed.data as ContractProducerDecl;
  if (decl.consumer.package === undefined) {
    return {
      log,
      failure: {
        code: "SYSTEM-VS-07",
        message: `producer "${producerId}" uses consumer.root — a validator check needs a published consumer.package (RFC-1539)`,
      },
    };
  }
  const verdict = await runProducerConformance(decl, { repoRoot: cwd, requireConsumer: true });
  const version = result.contracts[product]?.[decl.consumer.package] ?? "unresolved";
  log.push(
    `validator: ${decl.consumer.package}@${version}\n`,
    `verdict: ${verdict.status}${verdict.failedLeg ? ` (failed leg: ${verdict.failedLeg})` : ""}\n`,
    ...verdict.diagnostics.map((d) => `${d}\n`),
  );
  if (verdict.status !== "pass") {
    return {
      log,
      failure: {
        code: "SYSTEM-VS-04",
        message: `conformance verdict ${verdict.status}${verdict.failedLeg ? ` at the ${verdict.failedLeg} leg` : ""}`,
      },
    };
  }
  return { log, failure: null };
}

/** `pin-drift`: compare each scenario product's recorded pin with npm's latest; warning-only. */
async function runPinDrift(
  check: PinDriftCheck,
  scenario: SystemScenario,
  result: VersionSetRecordResult,
  io: ReturnType<typeof resolveIo>,
  cwd: string,
): Promise<string[]> {
  const log = [
    `### pin-drift ${check.package} (authority ${check.authority}, maxLag ${check.maxLag})\n`,
  ];
  const npm = async (args: string[]) => {
    try {
      return await io.exec("npm", [...args, "--fetch-retries=0", "--fetch-timeout=15000"], {
        cwd,
        timeoutMs: 60_000,
      });
    } catch (error) {
      return {
        exitCode: null as number | null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const latestRes = await npm(["view", check.package, "dist-tags.latest"]);
  const versionsRes = await npm(["view", check.package, "versions", "--json"]);
  let versions: string[] = [];
  try {
    const parsed = JSON.parse(versionsRes.stdout) as unknown;
    versions = Array.isArray(parsed)
      ? (parsed as string[])
      : typeof parsed === "string"
        ? [parsed]
        : [];
  } catch {
    versions = [];
  }
  const latest = latestRes.stdout.trim();
  if (
    latestRes.exitCode !== 0 ||
    versionsRes.exitCode !== 0 ||
    latest === "" ||
    versions.length === 0
  ) {
    const message = `npm registry unreachable for ${check.package} — pin drift not compared`;
    result.warnings.push({ code: "SYSTEM-VS-W02", package: check.package, message });
    log.push(`${message}\n`);
    return log;
  }
  versions.sort(compareSemver);
  const latestIndex = versions.indexOf(latest);
  for (const product of scenario.products) {
    if (product === check.authority) continue;
    const pinned = result.contracts[product]?.[check.package];
    if (pinned === undefined) continue;
    const index = versions.indexOf(pinned);
    if (index === -1) {
      const message = `${product} pins ${check.package}@${pinned}, which npm does not list — cannot measure drift`;
      result.warnings.push({
        code: "SYSTEM-VS-W01",
        product,
        package: check.package,
        from: pinned,
        to: latest,
        message,
      });
      log.push(`${message}\n`);
      continue;
    }
    const lag = latestIndex - index;
    log.push(`${product}: ${pinned} (latest ${latest}, lag ${lag})\n`);
    if (lag >= check.maxLag) {
      result.warnings.push({
        code: "SYSTEM-VS-W01",
        product,
        package: check.package,
        from: pinned,
        to: latest,
        message: `${product} is ${lag} published version(s) behind ${check.package}@${latest} (maxLag ${check.maxLag})`,
      });
    }
  }
  return log;
}
