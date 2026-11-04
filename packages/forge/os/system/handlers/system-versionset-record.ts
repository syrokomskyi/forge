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
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1511: step 3 — versionset.record handler</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
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
import { runFlowScript } from "../../flow/scripts.ts";
import {
  assertSystemRepository,
  loadScenarios,
  loadSystemMap,
  type SystemMap,
} from "../repo.ts";
import {
  SYSTEM_VERSION_SETS_DIR,
  versionSetSchema,
  type SystemScenario,
  type VersionSet,
} from "../scenario-schemas.ts";

export interface VersionSetRecordResult {
  command: "system.versionset.record";
  id: string | null;
  products: Record<string, string>;
  scenarios: string[];
  evidence: Record<string, string>;
  created: boolean;
  diagnostics: Diagnostic[];
}

const RELEASE_TAG_SCHEMA_LINE = /^schema:\s*forge\/release-tag@1\s*$/m;

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

function parseScenariosFlag(
  raw: string | undefined,
  diagnostics: Diagnostic[],
): string[] | null {
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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    `--format=%(objecttype)${sep}%(contents)`,
  ]);
  // %(contents) is multi-line — split on the first field separator only.
  const firstSep = res.stdout.indexOf(sep);
  const objecttype = firstSep === -1 ? res.stdout.trim() : res.stdout.slice(0, firstSep);
  const contents = firstSep === -1 ? "" : res.stdout.slice(firstSep + 1);
  if (res.exitCode !== 0 || res.stdout.trim() === "") {
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
    for (const entry of await io.readdir(dir)) {
      const m = /^VS-(\d{4})\.yaml$/.exec(entry.name);
      if (entry.isFile && m) max = Math.max(max, Number.parseInt(m[1]!, 10));
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
    for (const id of scenarioIds) {
      const scenario = loaded.scenarios.get(id);
      if (!scenario) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-01",
            "error",
            `unknown scenario "${id}" — no ${`system/scenarios/${id}.yaml`}`,
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
    for (const check of scenario.checks) neededProducts.add(check.product);
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
      const folder = map.local?.folders[product];
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
      const added = await git(productRoot, io, ["worktree", "add", "--detach", tmp, productTags.get(product)!]);
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

    for (const scenario of scenarios) {
      if (aborted) break;
      const log: string[] = [];
      for (const check of scenario.checks) {
        const cwd = worktrees.get(check.product)!;
        log.push(`### ${check.product}$ ${check.argv.join(" ")}\n`);
        const res = await io.exec(check.argv[0]!, check.argv.slice(1), {
          cwd,
          timeoutMs: check.timeoutSec * 1000,
        });
        log.push(res.stdout, res.stderr);
        if (res.exitCode !== 0) {
          aborted = diag(
            "SYSTEM-VS-04",
            "error",
            `scenario "${scenario.id}" check failed in "${check.product}" (${check.argv.join(" ")}) — ` +
              (res.exitCode === null
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
        result.evidence[scenario.id] = `sha256:${createHash("sha256").update(logText).digest("hex")}`;
      }
    }
  } finally {
    for (const [product, tmp] of worktrees) {
      const removed = await git(productRoots.get(product)!, io, ["worktree", "remove", "--force", tmp]);
      if (removed.exitCode !== 0) {
        diagnostics.push(
          diag(
            "SYSTEM-VS-05",
            "warning",
            `temporary worktree ${tmp} for "${product}" could not be removed: ${removed.stderr.trim()}`,
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
      schema: "forge/version-set@1",
      id,
      products: result.products,
      scenarios: scenarios.map((s) => s.id),
      evidence: result.evidence,
      verifiedAt: new Date().toISOString(),
    };
    const parsed = versionSetSchema.safeParse(set);
    if (!parsed.success) {
      diagnostics.push(
        diag("SYSTEM-VS-04", "error", `internal: assembled set failed schema: ${parsed.error.message}`),
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
