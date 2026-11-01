/*
<MODULE_CONTRACT>
<purpose>
Resolve declared Forge knowledge ID conflicts explicitly. Plans every file
before writing, uses WorkspaceIO for filesystem effects, and serializes
mutating runs with an owner-recorded workspace lock.
</purpose>
<non-goals>
  <item>Do not run during forge.upgrade; operators invoke remediation deliberately.</item>
  <item>Do not resolve non-cumulative or malformed files by rewriting their content.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: register explicit knowledge collision remediation with dry-run, JSON result, and owner-recorded lock.</item>
  <item>RFC-1481: add knowledge collision resolution and surfacing

Add the explicit resolver, namespace-aware parsing and validation, safe reference remapping, doctor/upgrade hints, and regression coverage.</item>
  <item>RFC-1481: enforce resolver IO and path boundaries

Use WorkspaceIO for pack discovery, reject escaping knowledge paths, remap cross-file provenance, and declare the mutating command's empty generation set.</item>
  <item>RFC-1481: honor kernel dry-run and expose resolver reachability

Recognize the kernel dry-run context, declare coverage and dynamic pack reads, and assert local authoring guidance plus zero-write preview behavior.</item>
  <item>RFC-1481: close REVIEW-CODE-2026-11-01-11 findings on resolver safety, IO boundaries, and reporting</item>
</CHANGE_SUMMARY>
*/

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { FORGE_SKILLS, discoverSkillPackWithIO } from "../../../src/registry.ts";
import {
  parseForgeConfigDocument,
  type ForgeConfig,
} from "../../../src/config/forge-config.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import {
  resolveKnowledgeConflicts,
  type KnowledgeConflictResolution,
  type KnowledgeConflictIssue,
  type KnowledgeConflictResolutionPlan,
  type KnowledgeReferenceRemap,
} from "../../../src/knowledge/sync.ts";

export interface KnowledgeConflictsResolveData {
  command: "knowledge.conflicts.resolve";
  status: "pass" | "fail";
  resolved: KnowledgeConflictResolution[];
  unresolved: KnowledgeConflictIssue[];
  dryRun: boolean;
}

interface LockOwner {
  pid: number;
  host: string;
  acquiredAt: string;
  token: string;
}

interface ResolveFile {
  source: string;
  destination: string;
  relative: string;
}

const CLAIM_PREFIX = "knowledge-conflicts.resolve-claim-";

function resolveInside(root: string, ...segments: string[]): string {
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error("Knowledge paths must not contain empty segments.");
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...segments);
  const relative = path.relative(absoluteRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Knowledge path escapes its declared root: ${segments.join("/")}`);
  }
  return target;
}

/**
 * A lexical containment check cannot see symlinks, so realpath the deepest
 * existing ancestor of the destination: a symlinked directory anywhere in the
 * chain would redirect `io.writeFile` outside the workspace.
 */
async function assertDestinationInsideWorkspace(
  workspaceRoot: string,
  destinationPath: string,
  io: WorkspaceIO,
): Promise<void> {
  let probe = destinationPath;
  while (!(await io.exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
  const [workspaceReal, probeReal] = await Promise.all([
    io.realpath(workspaceRoot),
    io.realpath(probe),
  ]);
  const relative = path.relative(workspaceReal, probeReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Consumer knowledge destination resolves outside the workspace: ${destinationPath}`);
  }
}

function lockOwnerPath(lockPath: string): string {
  return path.join(lockPath, "owner.json");
}

async function sweepClaimDirs(forgeDir: string, io: WorkspaceIO): Promise<void> {
  let entries;
  try {
    entries = await io.readdir(forgeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory && entry.name.startsWith(CLAIM_PREFIX)) {
      await io.rm(path.join(forgeDir, entry.name), { recursive: true }).catch(() => {});
    }
  }
}

async function acquireLock(
  workspaceRoot: string,
  io: WorkspaceIO,
): Promise<{ lockPath: string; owner: LockOwner } | null> {
  const forgeDir = path.join(workspaceRoot, ".forge");
  const lockPath = path.join(forgeDir, "knowledge-conflicts.resolve.lock");
  await io.mkdir(forgeDir);

  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const claimPath = await io.mkdtemp(path.join(forgeDir, CLAIM_PREFIX));
  await io.writeFile(lockOwnerPath(claimPath), JSON.stringify(owner, null, 2) + "\n");

  // Lock acquisition is atomic by construction: POSIX rename(2) onto an
  // existing non-empty directory fails ENOTEMPTY, so the claim either becomes
  // the lock (with owner.json already inside — no ownerless window) or loses
  // the race outright. Never mkdir-then-write, which would leave an
  // unowned lock directory.
  try {
    await io.rename(claimPath, lockPath);
    await sweepClaimDirs(forgeDir, io);
    return { lockPath, owner };
  } catch {
    await io.rm(claimPath, { recursive: true }).catch(() => {});
    return null;
  }
}

async function releaseLock(
  lock: { lockPath: string; owner: LockOwner },
  io: WorkspaceIO,
): Promise<void> {
  try {
    const current = JSON.parse(await io.readFile(lockOwnerPath(lock.lockPath))) as LockOwner;
    if (current.token === lock.owner.token) {
      await io.rm(lock.lockPath, { recursive: true });
      await sweepClaimDirs(path.dirname(lock.lockPath), io);
    }
  } catch {
    // A missing or replaced lock is not ours to remove.
  }
}

async function collectDeclaredFiles(
  workspaceRoot: string,
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  io: WorkspaceIO,
): Promise<ResolveFile[]> {
  if (!(await io.exists(sourcePath))) return [];
  const stat = await io.stat(sourcePath);
  if (!stat.isDirectory) {
    await assertDestinationInsideWorkspace(workspaceRoot, destinationPath, io);
    return [{ source: sourcePath, destination: destinationPath, relative: relativePath }];
  }

  const entries = (await io.readdir(sourcePath)).sort((a, b) => (a.name < b.name ? -1 : 1));
  const files: ResolveFile[] = [];
  for (const entry of entries) {
    const nested = await collectDeclaredFiles(
      workspaceRoot,
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      path.posix.join(relativePath, entry.name),
      io,
    );
    files.push(...nested);
  }
  return files;
}

async function enumerateSkillFiles(
  workspaceRoot: string,
  destinationRoot: string,
  skillName: string,
  skillSourceDir: string,
  declared: string[],
  io: WorkspaceIO,
): Promise<{ files: ResolveFile[]; failures: string[] }> {
  const files: ResolveFile[] = [];
  const failures: string[] = [];
  const destinationDir = resolveInside(destinationRoot, skillName);
  for (const entry of declared) {
    try {
      files.push(
        ...(await collectDeclaredFiles(
          workspaceRoot,
          resolveInside(skillSourceDir, entry),
          resolveInside(destinationDir, entry),
          path.posix.join(skillName, entry),
          io,
        )),
      );
    } catch (error) {
      failures.push(`${skillName}/${entry}: ${(error as Error).message}`);
    }
  }
  return { files, failures };
}

async function enumerateKnowledgeFiles(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  config: ForgeConfig,
  io: WorkspaceIO,
): Promise<{ files: ResolveFile[]; failures: string[] }> {
  const destinationRoot = resolveInside(workspaceRoot, skillsDir);
  const files: ResolveFile[] = [];
  const failures: string[] = [];

  for (const skill of FORGE_SKILLS) {
    if (!skill.knowledge?.length) continue;
    const skillSource = resolveInside(forgeRoot, skill.path);
    if (!(await io.exists(skillSource))) continue;
    const enumerated = await enumerateSkillFiles(
      workspaceRoot,
      destinationRoot,
      skill.name,
      path.dirname(skillSource),
      skill.knowledge,
      io,
    );
    files.push(...enumerated.files);
    failures.push(...enumerated.failures);
  }

  const forgeNames = new Set(FORGE_SKILLS.map((skill) => skill.name));
  for (const pack of config.skillPacks ?? []) {
    let packSkills;
    try {
      packSkills = await discoverSkillPackWithIO(workspaceRoot, pack, io);
    } catch (error) {
      failures.push(`pack ${pack.prefix} (${pack.dir}): ${(error as Error).message}`);
      continue;
    }
    for (const skill of packSkills) {
      if (!skill.knowledge?.length || forgeNames.has(skill.name)) continue;
      const skillSource = resolveInside(workspaceRoot, skill.dir, skill.path);
      const enumerated = await enumerateSkillFiles(
        workspaceRoot,
        destinationRoot,
        skill.name,
        path.dirname(skillSource),
        skill.knowledge,
        io,
      );
      files.push(...enumerated.files);
      failures.push(...enumerated.failures);
    }
  }

  try {
    files.push(
      ...(await collectDeclaredFiles(
        workspaceRoot,
        resolveInside(forgeRoot, "skills", "shared", "knowledge", "learned-principles.md"),
        resolveInside(destinationRoot, "shared-knowledge", "learned-principles.md"),
        "shared-knowledge/learned-principles.md",
        io,
      )),
    );
  } catch (error) {
    failures.push(`shared-knowledge/learned-principles.md: ${(error as Error).message}`);
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
  return { files, failures };
}

function knowledgeLedger(
  resolved: KnowledgeConflictResolution[],
  unresolved: KnowledgeConflictIssue[],
): string {
  const lines = ["# forge knowledge conflict resolution ledger", ""];
  for (const file of resolved) {
    for (const mapping of file.renumbered) {
      lines.push(`${file.file}#${mapping.from} -> renumbered:${mapping.to}`);
    }
    for (const mapping of file.deduped) {
      lines.push(`${file.file}#${mapping.localId} -> deduped:${mapping.canonicalId}`);
    }
    for (const id of file.adopted) {
      lines.push(`${file.file}#${id} -> adopted-upstream`);
    }
  }
  for (const issue of unresolved) {
    lines.push(`${issue.file} -> unresolved:${issue.reason}`);
  }
  return lines.length === 2 ? "" : `${lines.join("\n")}\n`;
}

function unresolvedBlocks(issue: KnowledgeConflictIssue): boolean {
  return issue.reason !== "non-cumulative";
}

/**
 * Cross-file `promotedTo`/`promotedFrom` references are owner-scoped
 * (`skill-name/entry-id`). A retarget is safe only when the old id no longer
 * resolves anywhere else under the same owner after resolution — otherwise
 * the reference may have meant a sibling file's entry, so it is reported
 * ambiguous rather than guessed.
 */
function referenceRemaps(
  files: ResolveFile[],
  plans: KnowledgeConflictResolutionPlan[],
): KnowledgeReferenceRemap {
  const ids = new Map<string, string>();
  const ambiguous = new Set<string>();
  const ownerOf = (relative: string) =>
    relative.startsWith("shared-knowledge/") ? "shared" : relative.split("/")[0]!;

  const filesByOwner = new Map<string, number[]>();
  files.forEach((file, index) => {
    const owner = ownerOf(file.relative);
    filesByOwner.set(owner, [...(filesByOwner.get(owner) ?? []), index]);
  });
  const stillCarries = (owner: string, from: string, skip: number) =>
    (filesByOwner.get(owner) ?? []).some(
      (index) => index !== skip && plans[index]!.outputIds.includes(from),
    );

  const add = (key: string, value: string, unsafe: boolean) => {
    if (unsafe || ambiguous.has(key)) {
      ids.delete(key);
      ambiguous.add(key);
      return;
    }
    const current = ids.get(key);
    if (current !== undefined && current !== value) {
      ids.delete(key);
      ambiguous.add(key);
      return;
    }
    ids.set(key, value);
  };

  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!;
    if (plan.unresolved.length > 0) continue;
    const owner = ownerOf(files[index]!.relative);
    for (const mapping of plan.resolution.renumbered) {
      const key = `${owner}/${mapping.from}`;
      add(key, `${owner}/${mapping.to}`, stillCarries(owner, mapping.from, index));
    }
    for (const mapping of plan.resolution.deduped) {
      const key = `${owner}/${mapping.localId}`;
      add(
        key,
        `${owner}/${mapping.canonicalId}`,
        stillCarries(owner, mapping.localId, index),
      );
    }
  }
  return { ids, ambiguous };
}

async function readForgeConfig(workspaceRoot: string, io: WorkspaceIO): Promise<ForgeConfig> {
  const configPath = path.join(workspaceRoot, "forge.yaml");
  let raw: string;
  try {
    raw = await io.readFile(configPath);
  } catch {
    throw new Error(`forge.yaml not found at ${configPath}.`);
  }
  const config = parseForgeConfigDocument(raw, configPath);
  config.profileResolution = config.profileDeclaredId ? "catalog-unavailable" : "absent";
  delete config.profile;
  return config;
}

function summarizeRun(
  resolved: KnowledgeConflictResolution[],
  unresolved: KnowledgeConflictIssue[],
  failures: string[],
  dryRun: boolean,
): string {
  const verb = dryRun ? "planned" : "resolved";
  const lines = [`${resolved.length} knowledge file(s) ${verb}; ${unresolved.length} unresolved`];
  for (const file of resolved) {
    const dispositions = [
      ...file.renumbered.map((mapping) => `renumbered ${mapping.from} -> ${mapping.to}`),
      ...file.deduped.map((mapping) => `deduped ${mapping.localId} -> ${mapping.canonicalId}`),
      ...file.adopted.map((id) => `adopted ${id}`),
    ];
    lines.push(`  ${file.file}: ${dispositions.join("; ") || "content updated"}`);
  }
  for (const issue of unresolved) {
    lines.push(`  ${issue.file} -> unresolved:${issue.reason}`);
  }
  for (const failure of failures) {
    lines.push(`  ${failure}`);
  }
  return lines.join("\n");
}

export async function runKnowledgeConflictsResolve(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<KnowledgeConflictsResolveData>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const dryRun = context.dryRun === true || input.flags["dry-run"] === true;
  const forgeRoot = context.forgeRoot ?? path.resolve(import.meta.dirname, "../../..");
  let lock: { lockPath: string; owner: LockOwner } | null = null;

  const fail = (summary: string): ForgeCommandResult<KnowledgeConflictsResolveData> => ({
    data: {
      command: "knowledge.conflicts.resolve",
      status: "fail",
      resolved: [],
      unresolved: [],
      dryRun,
    },
    summary,
    exitCode: 1,
  });

  let config: ForgeConfig;
  try {
    config = await readForgeConfig(root, io);
  } catch (error) {
    return fail(`Knowledge resolution stopped before completion: ${(error as Error).message}`);
  }

  if (!dryRun) {
    lock = await acquireLock(root, io);
    if (!lock) {
      const lockPath = path.join(root, ".forge", "knowledge-conflicts.resolve.lock");
      let ownerDetail = "owner metadata unavailable";
      try {
        const owner = JSON.parse(await io.readFile(lockOwnerPath(lockPath))) as LockOwner;
        ownerDetail = `pid ${owner.pid} on ${owner.host}, acquired ${owner.acquiredAt}`;
      } catch {
        // Report the lock path even when its metadata is unreadable.
      }
      return fail(
        `Knowledge resolution is already locked (${ownerDetail}); verify the owner before removing ${lockPath}.`,
      );
    }
  }

  try {
    const { files, failures } = await enumerateKnowledgeFiles(
      root,
      forgeRoot,
      config.paths.skillsDir,
      config,
      io,
    );
    const initialPlans: KnowledgeConflictResolutionPlan[] = [];
    const planFailed = new Set<number>();
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      try {
        initialPlans.push(
          await resolveKnowledgeConflicts(file.source, file.destination, io, { dryRun: true }),
        );
      } catch (error) {
        planFailed.add(index);
        initialPlans.push({
          content: null,
          resolution: { file: file.relative, renumbered: [], deduped: [], adopted: [] },
          unresolved: [],
          outputIds: [],
        });
        failures.push(`Could not plan ${file.relative}: ${(error as Error).message}`);
      }
    }
    const externalReferences = referenceRemaps(files, initialPlans);
    const resolved: KnowledgeConflictResolution[] = [];
    const unresolved: KnowledgeConflictIssue[] = [];

    for (let index = 0; index < files.length; index++) {
      if (planFailed.has(index)) continue;
      const file = files[index]!;
      let result: KnowledgeConflictResolutionPlan;
      try {
        result = await resolveKnowledgeConflicts(file.source, file.destination, io, {
          dryRun: true,
          externalReferences,
        });
      } catch (error) {
        failures.push(`Could not plan ${file.relative}: ${(error as Error).message}`);
        continue;
      }
      unresolved.push(
        ...result.unresolved.map((issue) => ({ ...issue, file: file.relative })),
      );
      if (result.content === null) continue;
      if (!dryRun) {
        try {
          await io.writeFile(file.destination, result.content);
        } catch (error) {
          failures.push(`Could not update ${file.relative}: ${(error as Error).message}`);
          continue;
        }
      }
      resolved.push({ ...result.resolution, file: file.relative });
    }

    const ledgerPath = path.join(root, ".forge", "knowledge-conflicts.txt");
    const ledgerContent = knowledgeLedger(resolved, unresolved);
    if (!dryRun) {
      try {
        if (ledgerContent) {
          await io.writeFile(ledgerPath, ledgerContent);
        } else if (await io.exists(ledgerPath)) {
          await io.rm(ledgerPath);
        }
      } catch (error) {
        failures.push(`Could not update ${ledgerPath}: ${(error as Error).message}`);
      }
    }

    const failed =
      failures.length > 0 ||
      unresolved.some(unresolvedBlocks);
    const data: KnowledgeConflictsResolveData = {
      command: "knowledge.conflicts.resolve",
      status: failed ? "fail" : "pass",
      resolved,
      unresolved,
      dryRun,
    };
    const summary = summarizeRun(resolved, unresolved, failures, dryRun);
    if (context.outputFormat === "pretty") {
      const log = failed ? context.logger.warn : context.logger.success;
      log(summary);
    }
    return { data, summary, exitCode: failed ? 1 : 0 };
  } catch (error) {
    return fail(`Knowledge resolution stopped before completion: ${(error as Error).message}`);
  } finally {
    if (lock) await releaseLock(lock, io);
  }
}
