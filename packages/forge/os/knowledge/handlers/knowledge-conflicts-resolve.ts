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
</CHANGE_SUMMARY>
*/

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { FORGE_SKILLS, discoverPackSkillsWithIO } from "../../../src/registry.ts";
import { forgeConfigSchema, type ForgeConfig } from "../../../src/config/forge-config.ts";
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

async function assertDestinationInsideWorkspace(
  workspaceRoot: string,
  destinationPath: string,
  io: WorkspaceIO,
): Promise<void> {
  if (!(await io.exists(destinationPath))) return;
  const [workspaceReal, destinationReal] = await Promise.all([
    io.realpath(workspaceRoot),
    io.realpath(destinationPath),
  ]);
  const relative = path.relative(workspaceReal, destinationReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Consumer knowledge destination resolves outside the workspace: ${destinationPath}`);
  }
}

function lockOwnerPath(lockPath: string): string {
  return path.join(lockPath, "owner.json");
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
  const claimPath = await io.mkdtemp(path.join(forgeDir, "knowledge-conflicts.resolve-claim-"));
  await io.writeFile(lockOwnerPath(claimPath), JSON.stringify(owner, null, 2) + "\n");

  try {
    await io.rename(claimPath, lockPath);
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
    }
  } catch {
    // A missing or replaced lock is not ours to remove.
  }
}

async function collectDeclaredFiles(
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  io: WorkspaceIO,
): Promise<ResolveFile[]> {
  if (!(await io.exists(sourcePath))) return [];
  const stat = await io.stat(sourcePath);
  if (!stat.isDirectory) {
    return [{ source: sourcePath, destination: destinationPath, relative: relativePath }];
  }

  const entries = (await io.readdir(sourcePath)).sort((a, b) => a.name.localeCompare(b.name));
  const files: ResolveFile[] = [];
  for (const entry of entries) {
    const nested = await collectDeclaredFiles(
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      path.posix.join(relativePath, entry.name),
      io,
    );
    files.push(...nested);
  }
  return files;
}

async function enumerateKnowledgeFiles(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  config: ForgeConfig,
  io: WorkspaceIO,
): Promise<ResolveFile[]> {
  const destinationRoot = resolveInside(workspaceRoot, skillsDir);
  const files: ResolveFile[] = [];

  for (const skill of FORGE_SKILLS) {
    if (!skill.knowledge?.length) continue;
    const skillSource = resolveInside(forgeRoot, skill.path);
    if (!(await io.exists(skillSource))) continue;
    const skillDir = path.dirname(skillSource);
    const destinationDir = resolveInside(destinationRoot, skill.name);
    for (const declared of skill.knowledge) {
      const source = resolveInside(skillDir, declared);
      const destination = resolveInside(destinationDir, declared);
      await assertDestinationInsideWorkspace(workspaceRoot, destination, io);
      files.push(
        ...(await collectDeclaredFiles(
          source,
          destination,
          path.posix.join(skill.name, declared),
          io,
        )),
      );
    }
  }

  const packSkills = await discoverPackSkillsWithIO(workspaceRoot, config, io);
  const forgeNames = new Set(FORGE_SKILLS.map((skill) => skill.name));
  for (const skill of packSkills) {
    if (!skill.knowledge?.length || forgeNames.has(skill.name)) continue;
    const skillSource = resolveInside(workspaceRoot, skill.dir, skill.path);
    const skillDir = path.dirname(skillSource);
    const destinationDir = resolveInside(destinationRoot, skill.name);
    for (const declared of skill.knowledge) {
      const destination = resolveInside(destinationDir, declared);
      await assertDestinationInsideWorkspace(workspaceRoot, destination, io);
      files.push(
        ...(await collectDeclaredFiles(
          resolveInside(skillDir, declared),
          destination,
          path.posix.join(skill.name, declared),
          io,
        )),
      );
    }
  }

  const sharedSource = resolveInside(
    forgeRoot,
    "skills",
    "shared",
    "knowledge",
    "learned-principles.md",
  );
  const sharedDestination = resolveInside(destinationRoot, "shared-knowledge", "learned-principles.md");
  await assertDestinationInsideWorkspace(workspaceRoot, sharedDestination, io);
  files.push(
    ...(await collectDeclaredFiles(
      sharedSource,
      sharedDestination,
      "shared-knowledge/learned-principles.md",
      io,
    )),
  );
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
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

function referenceRemaps(
  files: ResolveFile[],
  plans: KnowledgeConflictResolution[],
): KnowledgeReferenceRemap {
  const ids = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (key: string, value: string) => {
    const current = ids.get(key);
    if (current !== undefined && current !== value) {
      ids.delete(key);
      ambiguous.add(key);
      return;
    }
    if (!ambiguous.has(key)) ids.set(key, value);
  };

  for (let index = 0; index < plans.length; index++) {
    const file = files[index]!;
    const owner = file.relative.startsWith("shared-knowledge/")
      ? "shared"
      : file.relative.split("/")[0]!;
    for (const mapping of plans[index]!.renumbered) {
      add(`${owner}/${mapping.from}`, `${owner}/${mapping.to}`);
    }
    for (const mapping of plans[index]!.deduped) {
      add(`${owner}/${mapping.localId}`, `${owner}/${mapping.canonicalId}`);
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

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`forge.yaml at ${configPath} is not valid YAML: ${(error as Error).message}`);
  }
  const result = forgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`forge.yaml at ${configPath} failed schema validation:\n${issues}`);
  }
  return result.data as ForgeConfig;
}

export async function runKnowledgeConflictsResolve(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<KnowledgeConflictsResolveData>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const dryRun = input.flags["dry-run"] === true || input.flags.dryRun === true;
  const forgeRoot = context.forgeRoot ?? path.resolve(import.meta.dirname, "../../..");
  const config = await readForgeConfig(root, io);
  let lock: { lockPath: string; owner: LockOwner } | null = null;

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
      return {
        data: {
          command: "knowledge.conflicts.resolve",
          status: "fail",
          resolved: [],
          unresolved: [],
          dryRun,
        },
        summary: `Knowledge resolution is already locked (${ownerDetail}); verify the owner before removing ${lockPath}.`,
        exitCode: 1,
      };
    }
  }

  try {
    const files = await enumerateKnowledgeFiles(
      root,
      forgeRoot,
      config.paths.skillsDir,
      config,
      io,
    );
    const initialPlans: KnowledgeConflictResolutionPlan[] = [];
    for (const file of files) {
      initialPlans.push(
        await resolveKnowledgeConflicts(file.source, file.destination, io, true),
      );
    }
    const externalReferences = referenceRemaps(
      files,
      initialPlans.map((plan) => plan.resolution),
    );
    const resolved: KnowledgeConflictResolution[] = [];
    const unresolved: KnowledgeConflictIssue[] = [];
    let writeFailure: string | null = null;

    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const result = await resolveKnowledgeConflicts(
        file.source,
        file.destination,
        io,
        true,
        externalReferences,
      );
      const resolution = {
        ...result.resolution,
        file: file.relative,
      };
      if (
        result.content !== null ||
        resolution.renumbered.length > 0 ||
        resolution.deduped.length > 0 ||
        resolution.adopted.length > 0
      ) {
        resolved.push(resolution);
      }
      unresolved.push(
        ...result.unresolved.map((issue) => ({ ...issue, file: file.relative })),
      );
      if (!dryRun && result.content !== null) {
        try {
          await io.writeFile(file.destination, result.content);
        } catch (error) {
          writeFailure = `Could not update ${file.relative}: ${(error as Error).message}`;
        }
      }
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
        writeFailure = `Could not update ${ledgerPath}: ${(error as Error).message}`;
      }
    }

    const failed =
      writeFailure !== null ||
      unresolved.some(unresolvedBlocks);
    const data: KnowledgeConflictsResolveData = {
      command: "knowledge.conflicts.resolve",
      status: failed ? "fail" : "pass",
      resolved,
      unresolved,
      dryRun,
    };
    const summary =
      writeFailure ??
      `${resolved.length} knowledge file(s) resolved; ${unresolved.length} unresolved`;
    if (context.outputFormat === "pretty") {
      const log = failed ? context.logger.warn : context.logger.success;
      log(summary);
    }
    return { data, summary, exitCode: failed ? 1 : 0 };
  } catch (error) {
    const summary = `Knowledge resolution stopped before completion: ${(error as Error).message}`;
    return {
      data: {
        command: "knowledge.conflicts.resolve",
        status: "fail",
        resolved: [],
        unresolved: [],
        dryRun,
      },
      summary,
      exitCode: 1,
    };
  } finally {
    if (lock) await releaseLock(lock, io);
  }
}
