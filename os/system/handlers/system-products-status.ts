/*
<MODULE_CONTRACT>
<purpose>system.products.status command handler (RFC-1639) — reports each
registered product's health against disk reality: resolved checkout folder,
declared profile, syncedVersion vs the hub baseline, dirty state, live
session worktrees and commits ahead; plus registry-vs-disk diagnostics
(unregistered forge siblings, missing or broken local checkouts). Read-only
— a registered product missing on disk is the only error; everything else
degrades to warnings so the report stays complete.</purpose>
<non-goals>
  <item>No writes — the report never mutates registry or product files.</item>
  <item>No queue, outbox, scenario or version-set behavior — RFC-1509..1511.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1639: system.products.status — member health + registry-vs-disk probe</item>
  <item>RFC-1639: step 1-2 — friction record fields, roster frozen/ignored, system.products.status</item>
  <item>RFC-1639: review — SYSTEM-MAP-01 rules decl, git-probe warnings, sibling kind/path discriminants, friction.add provenance, ingest hardening</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { git } from "../../flow/git.ts";
import {
  assertSystemRepository,
  FORGE_CONFIG_FILE,
  loadSystemMap,
  SYSTEM_PRODUCTS_FILE,
} from "../repo.ts";
import type { SystemMap } from "../repo.ts";

export interface ProductStatus {
  id: string;
  folder: string | null;
  profile: string | null;
  forgeVersion: string | null;
  versionOk: boolean | null;
  dirty: boolean | null;
  sessionWorktrees: string[];
  aheadOfOrigin: number | null;
  frozen: boolean;
}

export interface SystemProductsStatusResult {
  command: "system.products.status";
  status: "ok" | "warn" | "fail";
  hub: string;
  baseline: string | null;
  products: ProductStatus[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

function diagnostic(
  ruleId: "SYSTEM-PRODUCTS-01" | "SYSTEM-PRODUCTS-02",
  severity: "error" | "warning",
  file: string,
  message: string,
  fixHint: string,
): Diagnostic {
  return { ruleId, severity, file, message, fixHint };
}

/** Read the two fields the report needs — null when the file is absent or
 * unreadable (the caller turns that into the broken-checkout diagnostic). */
async function readProductForgeYaml(
  io: WorkspaceIO,
  dir: string,
): Promise<{ profile: string | null; syncedVersion: string | null } | null> {
  const abs = path.join(dir, FORGE_CONFIG_FILE);
  if (!(await io.exists(abs))) return null;
  try {
    const parsed = YAML.parse(await io.readFile(abs)) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== "object") return null;
    const rawProfile = parsed["profile"];
    const profile =
      typeof rawProfile === "string"
        ? rawProfile
        : rawProfile !== null && typeof rawProfile === "object"
          ? (((rawProfile as Record<string, unknown>)["id"] as string | undefined) ?? null)
          : null;
    const rawForge = parsed["forge"];
    const syncedVersion =
      rawForge !== null && typeof rawForge === "object"
        ? (((rawForge as Record<string, unknown>)["syncedVersion"] as string | null) ?? null)
        : null;
    return { profile, syncedVersion };
  } catch {
    return null;
  }
}

async function dirExists(io: WorkspaceIO, abs: string): Promise<boolean> {
  try {
    return (await io.stat(abs)).isDirectory;
  } catch {
    return false;
  }
}

export async function runSystemProductsStatus(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemProductsStatusResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const products: ProductStatus[] = [];

  const refusal = await assertSystemRepository(root, io);
  if (refusal) {
    errors.push(refusal);
    return finish(root, null, products, warnings, errors, context);
  }

  const loaded = await loadSystemMap(root, io);
  for (const d of loaded.diagnostics) {
    (d.severity === "error" ? errors : warnings).push(d);
  }
  const map = loaded.map;
  if (map === null) {
    return finish(root, null, products, warnings, errors, context);
  }

  // Baseline — the hub's own syncedVersion (the toolchain it distributes).
  const hubConfig = await readProductForgeYaml(io, root);
  const baseline = hubConfig?.syncedVersion ?? null;
  if (baseline === null) {
    warnings.push(
      diagnostic(
        "SYSTEM-PRODUCTS-02",
        "warning",
        FORGE_CONFIG_FILE,
        "the hub's forge.yaml carries no forge.syncedVersion — versionOk cannot be evaluated",
        "Run `forge upgrade` in the hub to stamp syncedVersion.",
      ),
    );
  }

  if (map.local === null) {
    warnings.push(
      diagnostic(
        "SYSTEM-PRODUCTS-02",
        "warning",
        "system/products.local.yaml",
        "products.local.yaml is absent — local checkouts are unknown; every product reports folder: null",
        "Create system/products.local.yaml (gitignored) mapping product ids to folders.",
      ),
    );
  }

  const resolvedFolders = new Set<string>();
  for (const product of map.products.products) {
    products.push(await probeProduct(product, map, root, baseline, io, warnings, errors));
    const entry = products[products.length - 1]!;
    if (entry.folder !== null) resolvedFolders.add(entry.folder);
  }

  // Registry-vs-disk: a sibling of the hub carrying forge.yaml that is not a
  // registered product — an adoption gap, unless deliberately `ignored`.
  const ignored = new Set((map.products.ignored ?? []).map((i) => i.id));
  const superfolder = path.dirname(root);
  try {
    for (const child of await io.readdir(superfolder)) {
      if (!child.isDirectory || child.name.includes("@") || child.name.startsWith(".")) {
        continue;
      }
      const childAbs = path.join(superfolder, child.name);
      if (childAbs === root || resolvedFolders.has(childAbs) || ignored.has(child.name)) {
        continue;
      }
      if (await io.exists(path.join(childAbs, FORGE_CONFIG_FILE))) {
        warnings.push({
          ...diagnostic(
            "SYSTEM-PRODUCTS-02",
            "warning",
            child.name,
            `sibling "${child.name}" carries forge.yaml but is not a registered product`,
            `Declare it in ${SYSTEM_PRODUCTS_FILE} or name it in ignored[].`,
          ),
          data: { kind: "unregistered-forge-sibling", path: childAbs },
        });
      } else if (await io.exists(path.join(childAbs, ".git"))) {
        warnings.push({
          ...diagnostic(
            "SYSTEM-PRODUCTS-02",
            "warning",
            child.name,
            `sibling "${child.name}" is a git checkout without forge.yaml — a pre-adoption signal`,
            `Run forge.init in ${child.name} or name it in ignored[].`,
          ),
          data: { kind: "git-sibling-without-forge", path: childAbs },
        });
      }
    }
  } catch {
    warnings.push(
      diagnostic(
        "SYSTEM-PRODUCTS-02",
        "warning",
        superfolder,
        "could not enumerate the hub's sibling directories — registry-vs-disk check skipped",
        "Check read permissions on the parent directory.",
      ),
    );
  }

  return finish(root, baseline, products, warnings, errors, context);
}

async function probeProduct(
  product: SystemMap["products"]["products"][number],
  map: SystemMap,
  root: string,
  baseline: string | null,
  io: WorkspaceIO,
  warnings: Diagnostic[],
  errors: Diagnostic[],
): Promise<ProductStatus> {
  const status: ProductStatus = {
    id: product.id,
    folder: null,
    profile: null,
    forgeVersion: null,
    versionOk: null,
    dirty: null,
    sessionWorktrees: [],
    aheadOfOrigin: null,
    frozen: product.frozen === true,
  };
  const flag = (message: string, fixHint: string, file = product.id): void => {
    // frozen products are reported but exempt from error diagnostics.
    (status.frozen ? warnings : errors).push(
      diagnostic(
        status.frozen ? "SYSTEM-PRODUCTS-02" : "SYSTEM-PRODUCTS-01",
        status.frozen ? "warning" : "error",
        file,
        status.frozen ? `${message} (frozen — informational only)` : message,
        fixHint,
      ),
    );
  };

  const local = map.local?.folders[product.id];
  if (map.local !== null && local === undefined) {
    flag(
      `product "${product.id}" has no folder in system/products.local.yaml`,
      `Add "${product.id}: <folder>" to system/products.local.yaml when its repository is checked out.`,
      "system/products.local.yaml",
    );
    return status;
  }
  const folder =
    local !== undefined ? (path.isAbsolute(local) ? local : path.join(root, local)) : null;
  status.folder = folder;
  if (folder === null) return status;

  if (!(await dirExists(io, folder))) {
    flag(
      `product "${product.id}" names a local folder that does not exist: ${local}`,
      `Check out the ${product.id} repository at ${local} or fix the mapping.`,
      "system/products.local.yaml",
    );
    return status;
  }

  const shape = await readProductForgeYaml(io, folder);
  if (shape === null) {
    flag(
      `product "${product.id}" has no readable forge.yaml at ${folder}`,
      `Restore ${FORGE_CONFIG_FILE} in ${folder} or fix the products.local.yaml mapping.`,
    );
    return status;
  }
  status.profile = shape.profile;
  status.forgeVersion = shape.syncedVersion;
  // A missing member version is provably unequal, not "unknown" — only a
  // missing hub baseline makes versionOk un-evaluable (null).
  status.versionOk = baseline !== null ? status.forgeVersion === baseline : null;

  // Live session worktrees: siblings of the product folder named `<id>@*`.
  try {
    for (const sib of await io.readdir(path.dirname(folder))) {
      if (sib.isDirectory && sib.name.startsWith(`${product.id}@`)) {
        status.sessionWorktrees.push(sib.name);
      }
    }
  } catch {
    // the parent listing is best-effort — absence of worktrees is the common case
  }

  // Git probes degrade to null + warning — a product with no readable git
  // state reports its other fields rather than failing. A missing io
  // capability is never a concrete verdict (AGENTS.md capability rule).
  if (!(await io.exists(path.join(folder, ".git")))) {
    warnings.push(
      diagnostic(
        "SYSTEM-PRODUCTS-02",
        "warning",
        product.id,
        `product "${product.id}" has no .git at ${folder} — git probes skipped`,
        "",
      ),
    );
  } else if (typeof io.exec !== "function") {
    warnings.push(
      diagnostic(
        "SYSTEM-PRODUCTS-02",
        "warning",
        product.id,
        `product "${product.id}" git probes unavailable — io.exec missing`,
        "",
      ),
    );
  } else {
    const dirty = await git(folder, io, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.exitCode === 0) {
      status.dirty = dirty.stdout.trim().length > 0;
    } else {
      warnings.push(
        diagnostic(
          "SYSTEM-PRODUCTS-02",
          "warning",
          product.id,
          `git status failed for "${product.id}" (${dirty.stderr.trim() || `exit ${dirty.exitCode}`})`,
          "",
        ),
      );
    }
    const ahead = await git(folder, io, ["rev-list", "--count", "@{upstream}..HEAD"]);
    if (ahead.exitCode === 0) {
      status.aheadOfOrigin = parseInt(ahead.stdout.trim(), 10);
    } else {
      warnings.push(
        diagnostic(
          "SYSTEM-PRODUCTS-02",
          "warning",
          product.id,
          `git rev-list failed for "${product.id}" (${ahead.stderr.trim() || `exit ${ahead.exitCode}`}) — no upstream or detached HEAD`,
          "",
        ),
      );
    }
  }

  return status;
}

function finish(
  root: string,
  baseline: string | null,
  products: ProductStatus[],
  warnings: Diagnostic[],
  errors: Diagnostic[],
  context: ForgeRuntimeContext,
): ForgeCommandResult<SystemProductsStatusResult> {
  const status = errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok";
  if (context.outputFormat === "pretty") {
    for (const p of products) {
      context.logger.info(
        `  ${p.id}: ${p.forgeVersion ?? "—"} ${p.versionOk === true ? "=" : p.versionOk === false ? "≠" : ""}${baseline ?? "—"} ${p.dirty === true ? "dirty" : p.dirty === false ? "clean" : ""}${p.frozen ? " frozen" : ""}`.trimEnd(),
      );
    }
    for (const d of errors) context.logger.error(`${d.ruleId} · ${d.message}`);
    for (const d of warnings) context.logger.warn(`${d.ruleId} · ${d.message}`);
  }
  return {
    data: {
      command: "system.products.status",
      status,
      hub: root,
      baseline,
      products,
      warnings,
      errors,
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `system.products.status: ${status} — ${products.length} product(s), ${errors.length} error(s), ${warnings.length} warning(s)`,
    nextSteps:
      errors.length > 0
        ? [{ action: "Fix the error-severity product diagnostics above", kind: "required" }]
        : [],
  };
}
