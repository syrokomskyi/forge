/*
<MODULE_CONTRACT>
<purpose>System-map loading and cross-file validation (RFC-1508). assertSystemRepository
gates system commands to profile: system repositories (SYSTEM-01); loadSystemMap reads
the four map files and never throws on malformed input (SYSTEM-MAP-01); validateSystemMap
enforces the cross-file rules (SYSTEM-MAP-02..05); edgeVerdict is the single-lookup
resolver shared with the task queue and outbox RFCs.</purpose>
<non-goals>
  <item>No task, outbox, scenario or version-set behavior — those are RFC-1509..1511.</item>
  <item>Do not import from @warpgogol/* (runtime) — forge os/ modules stay autonomous.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 2 — system repo assertion, non-throwing map loader, edgeVerdict, map checks</item>
  <item>RFC-1508: review r1 — contract-exact map shape (root, folders-based local map, strict schemas), read failures stay diagnostics, stat-based folder check</item>
  <item>RFC-1508: close rfc-1508 review r2 findings on folder lookup and diagnostics</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
  <item>RFC-1541: version-set@2 contracts with validator and pin-drift scenario checks</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { z } from "zod";

import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";
import { SYSTEM_SCENARIOS_DIR, systemScenarioSchema } from "./scenario-schemas.ts";
import type { SystemScenario } from "./scenario-schemas.ts";
import {
  systemEdgesSchema,
  systemProductsLocalSchema,
  systemProductsSchema,
  systemSchema,
} from "./schemas.ts";
import type { System, SystemEdges, SystemProducts, SystemProductsLocal } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const SYSTEM_DIR = "system";
export const SYSTEM_CONFIG_FILE = "system/system.yaml";
export const SYSTEM_PRODUCTS_FILE = "system/products.yaml";
export const SYSTEM_EDGES_FILE = "system/edges.yaml";
export const SYSTEM_LOCAL_FILE = "system/products.local.yaml";
export const FORGE_CONFIG_FILE = "forge.yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemMap {
  /** Repository root the map was loaded from — callers resolve folders against it. */
  root: string;
  system: System;
  products: SystemProducts;
  edges: SystemEdges;
  /** Parsed products.local.yaml, or null when the file is absent (SYSTEM-MAP-05). */
  local: SystemProductsLocal | null;
}

export interface SystemMapLoadResult {
  /** null when any required file is missing or fails schema validation. */
  map: SystemMap | null;
  diagnostics: Diagnostic[];
}

export type EdgeVerdict = "own-contract" | "forbidden" | "allowed" | "undeclared";

// ---------------------------------------------------------------------------
// assertSystemRepository — SYSTEM-01
// ---------------------------------------------------------------------------

/**
 * Returns a SYSTEM-01 diagnostic when `root` is not a forge repository on the
 * `system` profile (missing/unreadable forge.yaml, absent profile field, or a
 * different profile id), null otherwise.
 */
export async function assertSystemRepository(
  root: string,
  io: WorkspaceIO,
): Promise<Diagnostic | null> {
  const forgeYaml = path.join(root, FORGE_CONFIG_FILE);
  let parsed: unknown;
  if (!(await io.exists(forgeYaml))) {
    return {
      ruleId: "SYSTEM-01",
      severity: "error",
      file: FORGE_CONFIG_FILE,
      message:
        "system commands require a forge repository on the system profile — forge.yaml is missing",
      fixHint: "Run `forge create --in-place --profile system` to scaffold a system repository.",
    };
  }
  try {
    parsed = YAML.parse(await io.readFile(forgeYaml));
  } catch (error) {
    return {
      ruleId: "SYSTEM-01",
      severity: "error",
      file: FORGE_CONFIG_FILE,
      message: `forge.yaml is not readable YAML: ${error instanceof Error ? error.message : String(error)}`,
      fixHint: "Repair forge.yaml — system commands require profile: system.",
    };
  }
  const raw =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["profile"]
      : undefined;
  const profile =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object"
        ? (raw as { id?: unknown }).id
        : undefined;
  if (profile !== "system") {
    return {
      ruleId: "SYSTEM-01",
      severity: "error",
      file: FORGE_CONFIG_FILE,
      message: `system commands require profile: system — this repository is on profile ${JSON.stringify(raw ?? null)}`,
      fixHint: "system.map.validate only runs inside a repository created with --profile system.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// File loading — SYSTEM-MAP-01
// ---------------------------------------------------------------------------

function mapDiagnostic(file: string, message: string): Diagnostic {
  return {
    ruleId: "SYSTEM-MAP-01",
    severity: "error",
    file,
    message,
    fixHint: "Repair or recreate the file — see the forge/system map schemas (RFC-1508).",
  };
}

async function loadRequired<S extends z.ZodType>(
  root: string,
  rel: string,
  schema: S,
  io: WorkspaceIO,
): Promise<{ data?: z.infer<S>; diagnostic?: Diagnostic }> {
  const abs = path.join(root, rel);
  if (!(await io.exists(abs))) {
    return { diagnostic: mapDiagnostic(rel, `${rel} is missing`) };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(await io.readFile(abs));
  } catch (error) {
    return {
      diagnostic: mapDiagnostic(
        rel,
        `${rel} is not readable YAML: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { diagnostic: mapDiagnostic(rel, `${rel} failed schema validation:\n${issues}`) };
  }
  return { data: result.data as z.infer<S> };
}

/**
 * Read the four system-map files. Never throws on missing, unreadable or
 * malformed input — problems surface as SYSTEM-MAP-01 diagnostics and a null
 * map. An absent products.local.yaml is not an error (local: null); a
 * malformed one is SYSTEM-MAP-01 like any required file.
 */
export async function loadSystemMap(root: string, io: WorkspaceIO): Promise<SystemMapLoadResult> {
  const diagnostics: Diagnostic[] = [];

  const [sys, pro, edg] = await Promise.all([
    loadRequired(root, SYSTEM_CONFIG_FILE, systemSchema, io),
    loadRequired(root, SYSTEM_PRODUCTS_FILE, systemProductsSchema, io),
    loadRequired(root, SYSTEM_EDGES_FILE, systemEdgesSchema, io),
  ]);
  for (const part of [sys, pro, edg]) {
    if (part.diagnostic) diagnostics.push(part.diagnostic);
  }

  let local: SystemProductsLocal | null = null;
  const localAbs = path.join(root, SYSTEM_LOCAL_FILE);
  if (await io.exists(localAbs)) {
    const loc = await loadRequired(root, SYSTEM_LOCAL_FILE, systemProductsLocalSchema, io);
    if (loc.diagnostic) {
      diagnostics.push(loc.diagnostic);
    } else {
      local = loc.data ?? null;
    }
  }

  if (!sys.data || !pro.data || !edg.data || diagnostics.length > 0) {
    return { map: null, diagnostics };
  }
  return {
    map: { root, system: sys.data, products: pro.data, edges: edg.data, local },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Cross-file validation — SYSTEM-MAP-02..05
// ---------------------------------------------------------------------------

function edgeKey(consumer: string, contract: string): string {
  return JSON.stringify([consumer, contract]);
}

/**
 * Evaluate every cross-file rule against a loaded map. Needs the io port only
 * for the products.local.yaml folder checks (SYSTEM-MAP-05).
 */
export async function validateSystemMap(map: SystemMap, io: WorkspaceIO): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const products = map.products.products;
  const ids = new Set<string>();

  // SYSTEM-MAP-02 — duplicate product ids
  for (const product of products) {
    if (ids.has(product.id)) {
      diagnostics.push({
        ruleId: "SYSTEM-MAP-02",
        severity: "error",
        file: SYSTEM_PRODUCTS_FILE,
        message: `duplicate product id "${product.id}"`,
        fixHint: "Product ids are unique — rename or merge the duplicate entry.",
      });
    }
    ids.add(product.id);
  }

  // SYSTEM-MAP-02 — edge consumer not declared as a product;
  // SYSTEM-MAP-03 — edge contract not offered by any product
  for (const edge of [...map.edges.allowed, ...map.edges.forbidden]) {
    if (!ids.has(edge.consumer)) {
      diagnostics.push({
        ruleId: "SYSTEM-MAP-02",
        severity: "error",
        file: SYSTEM_EDGES_FILE,
        message: `edge consumer "${edge.consumer}" is not a declared product`,
        fixHint: `Add "${edge.consumer}" to ${SYSTEM_PRODUCTS_FILE} or remove the edge.`,
      });
    }
    if (!products.some((p) => p.offers.includes(edge.contract))) {
      diagnostics.push({
        ruleId: "SYSTEM-MAP-03",
        severity: "error",
        file: SYSTEM_EDGES_FILE,
        message: `edge names contract "${edge.contract}" which no product offers`,
        fixHint: `Declare "${edge.contract}" in a product's offers[] or remove the edge.`,
      });
    }
  }

  // SYSTEM-MAP-04 — same consumer/contract pair allowed AND forbidden
  const forbidden = new Set(map.edges.forbidden.map((e) => edgeKey(e.consumer, e.contract)));
  for (const edge of map.edges.allowed) {
    if (forbidden.has(edgeKey(edge.consumer, edge.contract))) {
      diagnostics.push({
        ruleId: "SYSTEM-MAP-04",
        severity: "error",
        file: SYSTEM_EDGES_FILE,
        message: `consumer "${edge.consumer}" / contract "${edge.contract}" is both allowed and forbidden`,
        fixHint: "Keep the pair in exactly one list — forbidden wins at lookup time.",
      });
    }
  }

  // SYSTEM-MAP-05 — local checkout coverage (warnings only)
  if (map.local === null) {
    diagnostics.push({
      ruleId: "SYSTEM-MAP-05",
      severity: "warning",
      file: SYSTEM_LOCAL_FILE,
      message: `${SYSTEM_LOCAL_FILE} is absent — local product checkouts are unknown`,
      fixHint: "Create system/products.local.yaml (gitignored) mapping product ids to folders.",
    });
  } else {
    for (const product of products) {
      if (!Object.hasOwn(map.local.folders, product.id)) {
        diagnostics.push({
          ruleId: "SYSTEM-MAP-05",
          severity: "warning",
          file: SYSTEM_LOCAL_FILE,
          message: `product "${product.id}" has no folder in ${SYSTEM_LOCAL_FILE}`,
          fixHint: `Add "${product.id}: <folder>" to ${SYSTEM_LOCAL_FILE} when its repository is checked out.`,
        });
      }
    }
    for (const [id, folder] of Object.entries(map.local.folders)) {
      if (!ids.has(id)) {
        diagnostics.push({
          ruleId: "SYSTEM-MAP-05",
          severity: "warning",
          file: SYSTEM_LOCAL_FILE,
          message: `local entry "${id}" is not a declared product`,
          fixHint: `Remove "${id}" from ${SYSTEM_LOCAL_FILE} or declare it in ${SYSTEM_PRODUCTS_FILE}.`,
        });
        continue;
      }
      const abs = path.isAbsolute(folder) ? folder : path.join(map.root, folder);
      let isDir = false;
      try {
        isDir = (await io.stat(abs)).isDirectory;
      } catch {
        isDir = false;
      }
      if (!isDir) {
        diagnostics.push({
          ruleId: "SYSTEM-MAP-05",
          severity: "warning",
          file: SYSTEM_LOCAL_FILE,
          message: `product "${id}" names a local folder that does not exist: ${folder}`,
          fixHint: `Check out the ${id} repository at ${folder} or remove the entry.`,
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Scenarios — RFC-1511 (SYSTEM-MAP-01 loading, SYSTEM-MAP-06 cross-checks)
// ---------------------------------------------------------------------------

export interface SystemScenarioLoadResult {
  /** Parsed scenarios keyed by declared id; empty when the dir is absent. */
  scenarios: Map<string, SystemScenario>;
  diagnostics: Diagnostic[];
}

/**
 * Read `system/scenarios/<id>.yaml` files against forge/system-scenario@1.
 * An absent or non-directory scenarios dir means no scenarios — the folder
 * is opt-in like the outbox. Malformed files surface as SYSTEM-MAP-01.
 */
export async function loadScenarios(
  root: string,
  io: WorkspaceIO,
): Promise<SystemScenarioLoadResult> {
  const diagnostics: Diagnostic[] = [];
  const scenarios = new Map<string, SystemScenario>();
  const dir = path.join(root, SYSTEM_SCENARIOS_DIR);
  let isDir = false;
  try {
    isDir = (await io.stat(dir)).isDirectory;
  } catch {
    isDir = false;
  }
  if (!isDir) return { scenarios, diagnostics };

  let entries: Awaited<ReturnType<typeof io.readdir>> = [];
  try {
    entries = await io.readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
    const rel = `${SYSTEM_SCENARIOS_DIR}/${entry.name}`;
    const loaded = await loadRequired(root, rel, systemScenarioSchema, io);
    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }
    if (loaded.data) scenarios.set(loaded.data.id, loaded.data);
  }
  return { scenarios, diagnostics };
}

/**
 * SYSTEM-MAP-06 — a scenario names a product the map does not declare
 * (products[] and checks[].product) or a contract no product offers.
 */
export function validateScenarios(
  map: SystemMap,
  scenarios: Map<string, SystemScenario>,
  root?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const productIds = new Set(map.products.products.map((p) => p.id));
  const offered = new Set(map.products.products.flatMap((p) => p.offers));
  for (const scenario of scenarios.values()) {
    const file = `${SYSTEM_SCENARIOS_DIR}/${scenario.id}.yaml`;
    const checkProducts = scenario.checks.flatMap((c) =>
      c.kind === "pin-drift" ? [c.authority] : [c.product],
    );
    for (const named of new Set([...scenario.products, ...checkProducts])) {
      if (!productIds.has(named)) {
        diagnostics.push({
          ruleId: "SYSTEM-MAP-06",
          severity: "error",
          file,
          message: `scenario "${scenario.id}" names undeclared product "${named}"`,
          fixHint: `Declare "${named}" in ${SYSTEM_PRODUCTS_FILE} or remove it from the scenario.`,
        });
      }
    }
    // RFC-1541 SYSTEM-MAP-07 — check-kind lints.
    for (const check of scenario.checks) {
      if (check.kind === "pin-drift") {
        const authority = map.products.products.find((p) => p.id === check.authority);
        if (authority && !authority.offers.includes(check.contract)) {
          diagnostics.push({
            ruleId: "SYSTEM-MAP-07",
            severity: "error",
            file,
            message: `scenario "${scenario.id}" pin-drift names authority "${check.authority}", which does not offer contract "${check.contract}"`,
            fixHint: `Name the product that offers "${check.contract}" in ${SYSTEM_PRODUCTS_FILE}.`,
          });
        }
      } else if (check.kind === "validator") {
        const folder =
          map.local !== null && Object.hasOwn(map.local.folders, check.product)
            ? map.local.folders[check.product]
            : undefined;
        if (!folder || root === undefined) {
          diagnostics.push({
            ruleId: "SYSTEM-MAP-07",
            severity: "warning",
            file,
            message: `scenario "${scenario.id}" validator check on "${check.product}" not linted — no local checkout mapped`,
          });
          continue;
        }
        const productRoot = path.isAbsolute(folder) ? folder : path.join(root, folder);
        let producers: unknown[] = [];
        try {
          const doc = YAML.parse(readFileSync(path.join(productRoot, "forge.yaml"), "utf8")) as {
            contractProducers?: unknown[];
          };
          producers = doc?.contractProducers ?? [];
        } catch {
          producers = [];
        }
        if (!producers.some((p) => (p as { id?: unknown })?.id === check.producer)) {
          diagnostics.push({
            ruleId: "SYSTEM-MAP-07",
            severity: "error",
            file,
            message: `scenario "${scenario.id}" validator check names producer "${check.producer}", which ${check.product}'s forge.yaml does not declare`,
            fixHint: `Declare "${check.producer}" in ${check.product}'s forge.yaml contractProducers[] or fix the scenario.`,
          });
        }
      }
    }
    for (const contract of scenario.contracts) {
      if (!offered.has(contract)) {
        diagnostics.push({
          ruleId: "SYSTEM-MAP-06",
          severity: "error",
          file,
          message: `scenario "${scenario.id}" names contract "${contract}" no product offers`,
          fixHint: `Add the contract to a product's offers[] in ${SYSTEM_PRODUCTS_FILE} or drop it from the scenario.`,
        });
      }
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// edgeVerdict — single-lookup edge resolver (RFC-1508 contract)
// ---------------------------------------------------------------------------

/**
 * Fixed precedence: a contract the consumer itself offers is `own-contract`
 * (product-internal call), then `forbidden`, then `allowed`, else `undeclared`.
 */
export function edgeVerdict(map: SystemMap, consumer: string, contract: string): EdgeVerdict {
  const product = map.products.products.find((p) => p.id === consumer);
  if (product?.offers.includes(contract)) return "own-contract";
  if (map.edges.forbidden.some((e) => e.consumer === consumer && e.contract === contract)) {
    return "forbidden";
  }
  if (map.edges.allowed.some((e) => e.consumer === consumer && e.contract === contract)) {
    return "allowed";
  }
  return "undeclared";
}
