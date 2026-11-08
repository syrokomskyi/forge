/*
<MODULE_CONTRACT>
<purpose>system.outbox.scan (RFC-1510) — read every product's committed
docs/outbox entries from its develop branch (uncommitted worktree files do
not count), match each open entry's contract to the offering product,
classify the edge and print OutboxProposal rows. With --create, one proposed
task per entry lands in the task queue (origin outbox:&lt;product&gt;:&lt;id&gt;)
— rescanning never duplicates. SYSTEM-OUTBOX-03 flags a product whose
forge.yaml or outbox entry names the system id — the leak check lives here
because a product cannot know the system's name.</purpose>
<non-goals>
  <item>No dispatch — proposals stop at the queue (RFC-1509 takes over).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1510: step 3 — develop-branch outbox scan and deduplicated task creation</item>
  <item>RFC-1510: implement RFC-1510 — product outbox for dependency-contract requests</item>
  <item>RFC-1510: close RFC-1510 review r1 findings — folder crash guard, ls-tree allowlist, OUTBOX-02 on develop</item>
  <item>RFC-1510: close RFC-1510 review r2 — declare OUTBOX-02 in scan rules, flat-scope test, readdir TOCTOU guard</item>
  <item>RFC-1541: version-set@2 contracts with validator and pin-drift scenario checks</item>
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
import {
  OUTBOX_DIR,
  type OutboxEntry,
  type OutboxProposal,
  outboxEntrySchema,
} from "../outbox-schema.ts";
import { assertSystemRepository, edgeVerdict, loadSystemMap } from "../repo.ts";
import { listTasks } from "../task-store.ts";
import { createTask, writeTaskWithBrief } from "./system-task-create.ts";

/** RFC-1541: a contract pin a consumer should bump, from the newest version set's W01 warnings. */
export interface PinBumpProposal {
  kind: "pin-bump";
  versionSet: string;
  product: string;
  package: string;
  from: string;
  to: string;
}

export interface SystemOutboxScanResult {
  command: "system.outbox.scan";
  proposals: OutboxProposal[];
  /** RFC-1541: proposals only — never materialized as tasks by --create. */
  pinBumps: PinBumpProposal[];
  created: string[];
  diagnostics: Diagnostic[];
}

function diag(
  ruleId: string,
  severity: Diagnostic["severity"],
  message: string,
  fixHint?: string,
): Diagnostic {
  return fixHint ? { ruleId, severity, message, fixHint } : { ruleId, severity, message };
}

/** RFC-1541: W01 pin-drift warnings of the highest-numbered version set (@2 only). */
async function readPinBumps(root: string, io: WorkspaceIO): Promise<PinBumpProposal[]> {
  const dir = path.join(root, "system", "version-sets");
  let names: string[] = [];
  try {
    names = (await io.readdir(dir))
      .filter((e) => !e.isDirectory && /^VS-\d{4}\.yaml$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const newest = names.at(-1);
  if (!newest) return [];
  type VersionSetDoc = { schema?: unknown; id?: unknown; warnings?: unknown };
  let doc: VersionSetDoc | null;
  try {
    doc = YAML.parse(await io.readFile(path.join(dir, newest))) as VersionSetDoc | null;
  } catch {
    return [];
  }
  if (doc?.schema !== "forge/version-set@2" || !Array.isArray(doc.warnings)) return [];
  const out: PinBumpProposal[] = [];
  for (const w of doc.warnings as Array<Record<string, unknown>>) {
    if (w.code !== "SYSTEM-VS-W01") continue;
    if (typeof w.product !== "string" || typeof w.package !== "string") continue;
    out.push({
      kind: "pin-bump",
      versionSet: String(doc.id),
      product: w.product,
      package: w.package,
      from: String(w.from ?? "unknown"),
      to: String(w.to ?? "unknown"),
    });
  }
  return out;
}

/** Word-boundary match for a kebab system id inside a product-side file. */
function systemIdNeedleFor(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`);
}

/** Committed file contents on the product's develop, or null when unreadable. */
async function gitShow(io: WorkspaceIO, repo: string, spec: string): Promise<string | null> {
  const res = await io.exec("git", ["show", spec], { cwd: repo });
  return res.exitCode === 0 ? res.stdout : null;
}

export async function runSystemOutboxScan(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SystemOutboxScanResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const create = input.flags["create"] === true;

  const refusal = await assertSystemRepository(root, io);
  if (refusal) diagnostics.push(refusal);

  const loaded = diagnostics.every((d) => d.severity !== "error")
    ? await loadSystemMap(root, io)
    : { map: null, diagnostics: [] };
  diagnostics.push(...loaded.diagnostics);
  const map = loaded.map;

  const proposals: OutboxProposal[] = [];
  const created: string[] = [];

  if (map !== null) {
    const listed = await listTasks(root, io);
    diagnostics.push(...listed.diagnostics);
    const tasks = listed.tasks;
    const originRef = (product: string, entry: string) => `${product}:${entry}`;
    const existingByOrigin = new Map<string, string>();
    for (const task of tasks) {
      if (task.origin.kind === "outbox" && task.origin.ref !== null) {
        existingByOrigin.set(task.origin.ref, task.id);
      }
    }

    for (const product of map.products.products) {
      const folder = Object.prototype.hasOwnProperty.call(map.local?.folders ?? {}, product.id)
        ? map.local!.folders[product.id]
        : undefined;
      if (folder === undefined) {
        diagnostics.push(
          diag(
            "SYSTEM-OUTBOX-04",
            "warning",
            `product '${product.id}' has no folder in system/products.local.yaml — skipped`,
          ),
        );
        continue;
      }
      const productRoot = path.isAbsolute(folder) ? folder : path.resolve(map.root, folder);

      // A stale products.local.yaml folder must warn, not crash — io.exec
      // rejects on a nonexistent cwd before git ever runs.
      let isDir = false;
      try {
        isDir = (await io.stat(productRoot)).isDirectory;
      } catch {
        isDir = false;
      }
      if (!isDir) {
        diagnostics.push(
          diag(
            "SYSTEM-OUTBOX-04",
            "warning",
            `product '${product.id}' names a local folder that does not exist: ${folder} — skipped`,
          ),
        );
        continue;
      }

      let tree: Awaited<ReturnType<WorkspaceIO["exec"]>>;
      try {
        tree = await io.exec("git", ["ls-tree", "--name-only", "develop", `${OUTBOX_DIR}/`], {
          cwd: productRoot,
        });
      } catch {
        diagnostics.push(
          diag(
            "SYSTEM-OUTBOX-04",
            "warning",
            `product '${product.id}' is not a readable git checkout — skipped`,
          ),
        );
        continue;
      }
      if (tree.exitCode !== 0) {
        diagnostics.push(
          diag(
            "SYSTEM-OUTBOX-04",
            "warning",
            `product '${product.id}' has no readable develop branch — skipped`,
          ),
        );
        continue;
      }

      // SYSTEM-OUTBOX-03 — a product file must never name the system. The
      // check is limited to forge.yaml and outbox entries: older prose in
      // product docs is deliberately out of scope (audit A2).
      const forgeYaml = await gitShow(io, productRoot, "develop:forge.yaml");
      const systemIdNeedle = systemIdNeedleFor(map.system.id);
      if (forgeYaml !== null && systemIdNeedle.test(forgeYaml)) {
        diagnostics.push(
          diag(
            "SYSTEM-OUTBOX-03",
            "warning",
            `product '${product.id}' forge.yaml contains the system id '${map.system.id}'`,
            "A product must not know its system — remove the reference.",
          ),
        );
      }

      for (const rel of tree.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".yaml"))) {
        const raw = await gitShow(io, productRoot, `develop:${rel}`);
        if (raw === null) continue;
        if (systemIdNeedle.test(raw)) {
          diagnostics.push(
            diag(
              "SYSTEM-OUTBOX-03",
              "warning",
              `product '${product.id}' outbox entry ${rel} contains the system id '${map.system.id}'`,
              "An entry names a contract — never the system or a serving product.",
            ),
          );
        }
        let parsed: OutboxEntry | null = null;
        try {
          const candidate = outboxEntrySchema.safeParse(YAML.parse(raw));
          if (candidate.success) {
            parsed = candidate.data;
          } else {
            diagnostics.push(
              diag(
                "OUTBOX-01",
                "error",
                `${product.id} ${rel} fails forge/outbox@1 on develop`,
                "Run outbox.validate in the product repository.",
              ),
            );
          }
        } catch {
          diagnostics.push(
            diag(
              "OUTBOX-01",
              "error",
              `${product.id} ${rel} is not parseable YAML on develop`,
              "Run outbox.validate in the product repository.",
            ),
          );
        }
        if (parsed !== null && path.posix.basename(rel, ".yaml") !== parsed.id) {
          diagnostics.push(
            diag(
              "OUTBOX-02",
              "error",
              `${product.id} ${rel} declares id ${parsed.id} but the filename stem is ${path.posix.basename(rel, ".yaml")}`,
              "Rename the file or fix the id — the filename stem is the canonical id.",
            ),
          );
          continue;
        }
        if (parsed === null || parsed.state !== "open") continue;

        const target =
          map.products.products.find((p) => p.offers.includes(parsed!.contract))?.id ?? null;
        const verdict = edgeVerdict(map, product.id, parsed.contract);
        const ref = originRef(product.id, parsed.id);
        const proposal: OutboxProposal = {
          product: product.id,
          entry: parsed.id,
          contract: parsed.contract,
          target,
          verdict,
          taskId: existingByOrigin.get(ref) ?? null,
        };
        if (target === null) {
          diagnostics.push(
            diag(
              "SYSTEM-OUTBOX-01",
              "warning",
              `no product offers contract '${parsed.contract}' requested by ${product.id} in ${parsed.id} — no task created`,
            ),
          );
        }
        if (verdict === "forbidden") {
          diagnostics.push(
            diag(
              "SYSTEM-OUTBOX-02",
              "error",
              `edge from '${product.id}' to contract '${parsed.contract}' is forbidden — ${parsed.id} creates no task`,
              "Resolve the forbidden edge in system/edges.yaml or withdraw the entry.",
            ),
          );
        }
        if (
          create &&
          proposal.taskId === null &&
          target !== null &&
          verdict !== "forbidden" &&
          !dryRun
        ) {
          const { task } = await createTask(root, io, {
            product: target,
            slug: parsed.id.toLowerCase(),
            title: `Serve ${parsed.id} for ${product.id}: ${parsed.contract}`,
            kind: "change",
            contracts: [parsed.contract],
            origin: { kind: "outbox", ref },
            reason: `outbox scan — ${parsed.why}`,
          });
          await writeTaskWithBrief(root, io, task);
          proposal.taskId = task.id;
          existingByOrigin.set(ref, task.id);
          created.push(task.id);
        }
        proposals.push(proposal);
      }
    }
  }

  const pinBumps = await readPinBumps(root, io);

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: { command: "system.outbox.scan", proposals, pinBumps, created, diagnostics },
    exitCode: errors > 0 ? 1 : 0,
    summary: `system.outbox.scan: ${proposals.length} proposal(s), ${pinBumps.length} pin-bump proposal(s), ${created.length} task(s) created, ${errors} error(s)`,
    nextSteps:
      proposals.length > 0
        ? [
            {
              action: create
                ? "Review the proposed tasks — system.task.move --task <id> --to ready once the brief is filled"
                : "Re-run with --create to propose tasks for the matched entries",
              kind: "optional",
            },
          ]
        : [],
  };
}
