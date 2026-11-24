/*
<MODULE_CONTRACT>
<purpose>system.product.register command handler (RFC-1641) — the roster
write surface for a system hub. The explicit form records one product
(--id --remote [--folder] [--offers]* [--frozen] [--update]); --discover
scans the hub's parent directory for forge-governed siblings and registers
every unregistered one. Writes system/products.yaml and the gitignored
system/products.local.yaml — the session commits. Errors refuse before any
write; warnings never fail the run.</purpose>
<non-goals>
  <item>No removal or reordering — products.yaml stays hand-editable for rare operations.</item>
  <item>No edge-matrix authoring — system/edges.yaml is curated contract policy.</item>
  <item>No validation beyond what registration needs — system.map.validate owns SYSTEM-MAP-02..05.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1641: system.product.register — roster write surface with --discover sibling scan</item>
  <item>RFC-1641: step 1 — system.product.register handler + tests</item>
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
  SYSTEM_LOCAL_FILE,
  SYSTEM_PRODUCTS_FILE,
} from "../repo.ts";
import type { SystemMap } from "../repo.ts";
import {
  SYSTEM_ID_PATTERN,
  type SystemProduct,
  type SystemProductsLocal,
} from "../schemas.ts";

interface RegisteredEntry {
  id: string;
  folder: string | null;
  updated: boolean;
}

interface SkippedEntry {
  name: string;
  reason: string;
}

export interface SystemProductRegisterResult {
  command: "system.product.register";
  status: "ok" | "warn" | "fail";
  mode: "explicit" | "discover";
  dryRun: boolean;
  registered: RegisteredEntry[];
  skipped: SkippedEntry[];
  written: string[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

function flagString(input: ForgeCommandInput, name: string): string | null {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function flagList(input: ForgeCommandInput, name: string): string[] {
  const v = input.flags[name];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function flagBool(input: ForgeCommandInput, name: string): boolean {
  return input.flags[name] === true;
}

function errDiag(file: string, message: string, fixHint: string): Diagnostic {
  return { ruleId: "SYSTEM-PRODUCTS-03", severity: "error", file, message, fixHint };
}

function warnDiag(file: string, message: string, fixHint: string): Diagnostic {
  return { ruleId: "SYSTEM-PRODUCTS-04", severity: "warning", file, message, fixHint };
}

async function dirExists(io: WorkspaceIO, abs: string): Promise<boolean> {
  try {
    return (await io.stat(abs)).isDirectory;
  } catch {
    return false;
  }
}

/** Serialize the products registry — schema order, `ignored[]` preserved. */
function serializeProducts(products: SystemMap["products"]): string {
  const body: Record<string, unknown> = {
    schema: "forge/system-products@1",
    products: products.products.map((p) => ({
      id: p.id,
      remote: p.remote,
      offers: p.offers,
      ...(p.frozen === true ? { frozen: true } : {}),
    })),
  };
  if (products.ignored !== undefined && products.ignored.length > 0) {
    body.ignored = products.ignored.map((i) => ({
      id: i.id,
      ...(i.note !== undefined ? { note: i.note } : {}),
    }));
  }
  return YAML.stringify(body);
}

function serializeLocal(local: SystemProductsLocal): string {
  const body: Record<string, unknown> = {
    schema: "forge/system-products-local@1",
    folders: local.folders,
  };
  if (local.launcher !== undefined) body.launcher = local.launcher;
  return YAML.stringify(body);
}

/** Resolve a --folder value to an absolute path for the existence check. */
function resolveFolder(root: string, folder: string): string {
  return path.isAbsolute(folder) ? folder : path.join(root, folder);
}

export async function runSystemProductRegister(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemProductRegisterResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const dryRun = context.dryRun || flagBool(input, "dry-run");
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const registered: RegisteredEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const written: string[] = [];

  const refusal = await assertSystemRepository(root, io);
  if (refusal) {
    errors.push(refusal);
    return finish("explicit", dryRun, registered, skipped, written, warnings, errors, context);
  }

  const loaded = await loadSystemMap(root, io);
  for (const d of loaded.diagnostics) {
    (d.severity === "error" ? errors : warnings).push(d);
  }
  const map = loaded.map;
  if (map === null) {
    return finish("explicit", dryRun, registered, skipped, written, warnings, errors, context);
  }

  const discover = flagBool(input, "discover");
  const id = flagString(input, "id");
  if (!discover && id === null) {
    errors.push(
      errDiag(
        SYSTEM_PRODUCTS_FILE,
        "system.product.register needs --id <product> or --discover",
        "Pass --id <kebab-id> --remote <url> to register one product, or --discover to scan siblings.",
      ),
    );
    return finish("explicit", dryRun, registered, skipped, written, warnings, errors, context);
  }

  // Mutation state — applied to a copy; files write once at the end.
  const products: SystemProduct[] = map.products.products.map((p) => ({ ...p }));
  const folders: Record<string, string> = { ...(map.local?.folders ?? {}) };
  let productsDirty = false;
  let localDirty = false;

  if (discover) {
    const outcome = await runDiscover(map, root, products, folders, registered, skipped, io);
    productsDirty = outcome.productsDirty;
    localDirty = outcome.localDirty;
    warnings.push(...outcome.warnings);
    errors.push(...outcome.errors);
  } else {
    const outcome = await runExplicit(input, map, root, products, folders, registered, skipped, io);
    productsDirty = outcome.productsDirty;
    localDirty = outcome.localDirty;
    warnings.push(...outcome.warnings);
    errors.push(...outcome.errors);
  }

  if (errors.length === 0 && !dryRun) {
    if (productsDirty) {
      await io.writeFile(
        path.join(root, SYSTEM_PRODUCTS_FILE),
        serializeProducts({ ...map.products, products }),
      );
      written.push(SYSTEM_PRODUCTS_FILE);
    }
    if (localDirty) {
      const local: SystemProductsLocal = {
        schema: "forge/system-products-local@1",
        folders,
        ...(map.local?.launcher !== undefined ? { launcher: map.local.launcher } : {}),
      };
      await io.mkdir(path.join(root, "system"));
      await io.writeFile(path.join(root, SYSTEM_LOCAL_FILE), serializeLocal(local));
      written.push(SYSTEM_LOCAL_FILE);
    }
  }
  if (dryRun && (productsDirty || localDirty)) {
    written.push(
      ...(productsDirty ? [SYSTEM_PRODUCTS_FILE] : []),
      ...(localDirty ? [SYSTEM_LOCAL_FILE] : []),
    );
  }

  return finish(
    discover ? "discover" : "explicit",
    dryRun,
    registered,
    skipped,
    written,
    warnings,
    errors,
    context,
  );
}

interface PathOutcome {
  productsDirty: boolean;
  localDirty: boolean;
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

/** Explicit `--id` registration (insert or --update). */
async function runExplicit(
  input: ForgeCommandInput,
  map: SystemMap,
  root: string,
  products: SystemProduct[],
  folders: Record<string, string>,
  registered: RegisteredEntry[],
  skipped: SkippedEntry[],
  io: WorkspaceIO,
): Promise<PathOutcome> {
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const id = flagString(input, "id")!;
  const remote = flagString(input, "remote");
  const folder = flagString(input, "folder");
  const offers = flagList(input, "offers");
  const frozen = flagBool(input, "frozen");
  const update = flagBool(input, "update");

  if (!SYSTEM_ID_PATTERN.test(id)) {
    errors.push(
      errDiag(
        SYSTEM_PRODUCTS_FILE,
        `product id "${id}" is not kebab-case`,
        "Product ids match ^[a-z0-9]+(-[a-z0-9]+)*$ — pick a conforming id.",
      ),
    );
    return { productsDirty: false, localDirty: false, warnings, errors };
  }

  const existing = products.find((p) => p.id === id);
  if (existing !== undefined && !update) {
    // Rerun-safe: an identical re-registration reports a skip, not an error.
    const sameRemote = remote === null || existing.remote === remote;
    const sameOffers = offers.length === 0 || sameSet(existing.offers, offers);
    const sameFrozen = !frozen || existing.frozen === true;
    if (sameRemote && sameOffers && sameFrozen && (folder === null || folders[id] === folder)) {
      skipped.push({ name: id, reason: "already-registered" });
      return { productsDirty: false, localDirty: false, warnings, errors };
    }
    errors.push(
      errDiag(
        SYSTEM_PRODUCTS_FILE,
        `product "${id}" is already registered — re-run with --update to modify it`,
        `Edit ${SYSTEM_PRODUCTS_FILE} by hand or pass --update with the new field values.`,
      ),
    );
    return { productsDirty: false, localDirty: false, warnings, errors };
  }

  if (existing === undefined && remote === null) {
    errors.push(
      errDiag(
        SYSTEM_PRODUCTS_FILE,
        `new product "${id}" needs --remote <url>`,
        "The roster requires a remote on first registration.",
      ),
    );
    return { productsDirty: false, localDirty: false, warnings, errors };
  }

  if (folder !== null) {
    const holder = Object.entries(folders).find(([otherId, f]) => otherId !== id && f === folder);
    if (holder !== undefined) {
      errors.push(
        errDiag(
          SYSTEM_LOCAL_FILE,
          `folder "${folder}" is already mapped to product "${holder[0]}"`,
          `Fix ${SYSTEM_LOCAL_FILE} — two products may not share one checkout folder.`,
        ),
      );
      return { productsDirty: false, localDirty: false, warnings, errors };
    }
    if (!(await dirExists(io, resolveFolder(root, folder)))) {
      warnings.push(
        warnDiag(
          SYSTEM_LOCAL_FILE,
          `folder "${folder}" does not exist on disk — recorded anyway`,
          `Check out ${id} at ${folder} or fix the mapping later.`,
        ),
      );
    }
  }

  let productsDirty = false;
  if (existing === undefined) {
    products.push({
      id,
      remote: remote!,
      offers,
      ...(frozen ? { frozen: true } : {}),
    });
    registered.push({ id, folder, updated: false });
    productsDirty = true;
  } else {
    if (remote !== null && existing.remote !== remote) {
      existing.remote = remote;
      productsDirty = true;
    }
    if (offers.length > 0 && !sameSet(existing.offers, offers)) {
      existing.offers = offers;
      productsDirty = true;
    }
    if (frozen && existing.frozen !== true) {
      existing.frozen = true;
      productsDirty = true;
    }
    registered.push({ id, folder, updated: true });
  }
  let localDirty = false;
  if (folder !== null && folders[id] !== folder) {
    folders[id] = folder;
    localDirty = true;
  }
  return { productsDirty, localDirty, warnings, errors };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** `--discover` sibling scan — registers every unregistered forge sibling. */
async function runDiscover(
  map: SystemMap,
  root: string,
  products: SystemProduct[],
  folders: Record<string, string>,
  registered: RegisteredEntry[],
  skipped: SkippedEntry[],
  io: WorkspaceIO,
): Promise<PathOutcome> {
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const ignored = new Set((map.products.ignored ?? []).map((i) => i.id));
  const knownIds = new Set(products.map((p) => p.id));
  const parent = path.dirname(root);

  let children;
  try {
    children = await io.readdir(parent);
  } catch {
    errors.push(
      errDiag(
        parent,
        "could not enumerate the hub's parent directory — discover aborted",
        "Check read permissions on the parent directory.",
      ),
    );
    return { productsDirty: false, localDirty: false, warnings, errors };
  }

  let productsDirty = false;
  let localDirty = false;
  for (const child of children) {
    const name = child.name;
    if (!child.isDirectory || name.startsWith(".") || name.includes("@")) continue;
    const childAbs = path.join(parent, name);
    if (childAbs === root) continue;
    if (ignored.has(name)) {
      skipped.push({ name, reason: "ignored[]" });
      continue;
    }
    if (!(await io.exists(path.join(childAbs, FORGE_CONFIG_FILE)))) continue;
    if (!SYSTEM_ID_PATTERN.test(name)) {
      skipped.push({ name, reason: "name is not kebab-case — register manually with --id" });
      warnings.push(
        warnDiag(
          name,
          `sibling "${name}" carries forge.yaml but its name is not a kebab-case product id`,
          `Register it manually: system.product.register --id <kebab-id> --remote <url> --folder ../${name}`,
        ),
      );
      continue;
    }
    if (knownIds.has(name)) {
      skipped.push({ name, reason: "already-registered" });
      continue;
    }

    const remote = await git(childAbs, io, ["remote", "get-url", "origin"]);
    const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : "";
    if (remoteUrl.length === 0) {
      skipped.push({ name, reason: "no origin remote — register manually with --remote" });
      warnings.push(
        warnDiag(
          name,
          `sibling "${name}" carries forge.yaml but has no readable git origin remote`,
          `Register it manually: system.product.register --id ${name} --remote <url> --folder ../${name}`,
        ),
      );
      continue;
    }

    const folder = `../${name}`;
    products.push({ id: name, remote: remoteUrl, offers: [] });
    knownIds.add(name);
    folders[name] = folder;
    productsDirty = true;
    localDirty = true;
    registered.push({ id: name, folder, updated: false });
  }
  return { productsDirty, localDirty, warnings, errors };
}

function finish(
  mode: "explicit" | "discover",
  dryRun: boolean,
  registered: RegisteredEntry[],
  skipped: SkippedEntry[],
  written: string[],
  warnings: Diagnostic[],
  errors: Diagnostic[],
  context: ForgeRuntimeContext,
): ForgeCommandResult<SystemProductRegisterResult> {
  const status = errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok";
  if (context.outputFormat === "pretty") {
    for (const r of registered) {
      context.logger.info(
        `  ${r.updated ? "updated" : "registered"}: ${r.id} ${r.folder ?? ""}`.trimEnd(),
      );
    }
    for (const s of skipped) context.logger.info(`  skipped: ${s.name} — ${s.reason}`);
    for (const d of errors) context.logger.error(`${d.ruleId} · ${d.message}`);
    for (const d of warnings) context.logger.warn(`${d.ruleId} · ${d.message}`);
  }
  return {
    data: {
      command: "system.product.register",
      status,
      mode,
      dryRun,
      registered,
      skipped,
      written,
      warnings,
      errors,
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `system.product.register: ${status} — ${registered.length} registered, ${skipped.length} skipped, ${errors.length} error(s)`,
    nextSteps:
      errors.length > 0
        ? [{ action: "Fix the error-severity registration diagnostics above", kind: "required" }]
        : [
            {
              action: "Commit system/products.yaml and products.local.yaml in this session",
              kind: "optional",
            },
          ],
  };
}
