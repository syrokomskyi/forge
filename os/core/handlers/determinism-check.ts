/*
<MODULE_CONTRACT>
<purpose>forge.determinism.check — verify artifact determinism by building twice and comparing output hashes. Profile-driven via determinism.inputs glob patterns.</purpose>
<non-goals>
  <item>Do not implement build or validate logic — those are separate handlers.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0678: initial forge.determinism.check handler with profile resolution, --dry-run, --artifact, cache, and double-build hash comparison.</item>
</CHANGE_SUMMARY>
*/

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { collectFiles } from "@warpgogol/share/fs";
import { byteHashFile } from "@warpgogol/fingerprint";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";

const execAsync = promisify(exec);

export interface DeterminismCheckResult {
  artifactId: string;
  hashable: boolean;
  inputs: string[];
  inputHash: string;
  firstBuildHash: string | null;
  secondBuildHash: string | null;
  deterministic: boolean;
  cached: boolean;
  error?: string;
}

export interface ForgeDeterminismCheckResult {
  command: "forge.determinism.check";
  profileId: string;
  artifacts: DeterminismCheckResult[];
  allDeterministic: boolean;
}

interface CacheEntry {
  inputHash: string;
  produceCommand: string;
  outputHash: string;
  deterministic: boolean;
}

interface CacheFile {
  entries: Record<string, CacheEntry>;
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}

function matchesGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(filePath));
}

async function computeInputHash(
  workspaceRoot: string,
  inputPatterns: string[],
): Promise<string> {
  const allFiles = await collectFiles(workspaceRoot, {
    ignore: (name) =>
      name.startsWith("-") ||
      name.startsWith("old-") ||
      name === "node_modules" ||
      name === "dist" ||
      name === ".turbo" ||
      name === ".cache" ||
      name === ".git",
  });

  const matched = allFiles
    .map((abs) => relative(workspaceRoot, abs))
    .filter((rel) => matchesGlob(rel, inputPatterns))
    .sort();

  const hasher = createHash("sha256");
  for (const relPath of matched) {
    const absPath = join(workspaceRoot, relPath);
    const fileHash = await byteHashFile(absPath);
    hasher.update(relPath + "\0" + fileHash + "\0");
  }

  return `sha256:${hasher.digest("hex")}`;
}

async function readCache(cachePath: string): Promise<CacheFile> {
  try {
    const content = await readFile(cachePath, "utf8");
    return JSON.parse(content) as CacheFile;
  } catch {
    return { entries: {} };
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

export async function runDeterminismCheck(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeDeterminismCheckResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);
  const artifactFilter =
    typeof input.flags["artifact"] === "string"
      ? (input.flags["artifact"] as string)
      : undefined;

  const resolved = resolveActiveProfile(
    workspaceRoot,
    context.forgeRoot,
    profileIdOverride,
  );
  if (!resolved) {
    return {
      data: {
        command: "forge.determinism.check",
        profileId: "",
        artifacts: [],
        allDeterministic: false,
      },
      exitCode: 1,
      summary:
        "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [
        { action: "Set profile in forge.yaml or use --profile <id>", kind: "required" },
      ],
    };
  }

  const { profile } = resolved;

  if (!profile.artifacts || profile.artifacts.length === 0) {
    return {
      data: {
        command: "forge.determinism.check",
        profileId: profile.id,
        artifacts: [],
        allDeterministic: false,
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare any artifacts.`,
      nextSteps: [
        { action: `Add artifacts section to profile ${profile.id}`, kind: "required" },
      ],
    };
  }

  if (artifactFilter) {
    const found = profile.artifacts.find((a) => a.id === artifactFilter);
    if (!found) {
      return {
        data: {
          command: "forge.determinism.check",
          profileId: profile.id,
          artifacts: [],
          allDeterministic: false,
        },
        exitCode: 1,
        summary: `Artifact ${artifactFilter} not declared in profile ${profile.id}.`,
        nextSteps: [
          { action: `Check artifacts in profile ${profile.id}`, kind: "required" },
        ],
      };
    }
  }

  const artifactsToCheck = artifactFilter
    ? profile.artifacts.filter((a) => a.id === artifactFilter)
    : profile.artifacts;

  const hashableArtifacts = artifactsToCheck.filter(
    (a) => a.determinism?.hashable === true,
  );

  if (hashableArtifacts.length === 0) {
    return {
      data: {
        command: "forge.determinism.check",
        profileId: profile.id,
        artifacts: [],
        allDeterministic: true,
      },
      exitCode: 0,
      summary: `Profile ${profile.id} has no hashable artifacts — nothing to check.`,
    };
  }

  if (dryRun) {
    const items = hashableArtifacts.map((a) => ({
      artifactId: a.id,
      inputs: a.determinism!.inputs,
    }));
    logger.info(`[dry-run] forge.determinism.check — profile: ${profile.id}`);
    for (const item of items) {
      logger.info(`  ${item.artifactId}: inputs=${item.inputs.join(", ")}`);
    }
    return {
      data: {
        command: "forge.determinism.check",
        profileId: profile.id,
        artifacts: items.map((item) => ({
          artifactId: item.artifactId,
          hashable: true,
          inputs: item.inputs,
          inputHash: "",
          firstBuildHash: null,
          secondBuildHash: null,
          deterministic: true,
          cached: false,
        })),
        allDeterministic: true,
      },
      summary: `[dry-run] ${items.length} hashable artifact(s) resolved`,
    };
  }

  const cachePath = join(workspaceRoot, "dist", ".determinism-cache.json");
  const cache = await readCache(cachePath);
  const results: DeterminismCheckResult[] = [];

  for (const artifact of hashableArtifacts) {
    const determinism = artifact.determinism!;
    const produceCommand = artifact.produce?.command ?? "";
    const outputPath = artifact.produce?.output ?? "";

    if (!produceCommand || !outputPath) {
      results.push({
        artifactId: artifact.id,
        hashable: true,
        inputs: determinism.inputs,
        inputHash: "",
        firstBuildHash: null,
        secondBuildHash: null,
        deterministic: false,
        cached: false,
        error: "Artifact has no produce.command or produce.output — cannot verify determinism",
      });
      logger.error(`  ${artifact.id}: no produce command or output`);
      continue;
    }

    const inputHash = await computeInputHash(workspaceRoot, determinism.inputs);
    const cacheKey = `${artifact.id}:${inputHash}:${produceCommand}`;
    const cachedEntry = cache.entries[cacheKey];

    if (cachedEntry) {
      results.push({
        artifactId: artifact.id,
        hashable: true,
        inputs: determinism.inputs,
        inputHash,
        firstBuildHash: cachedEntry.outputHash,
        secondBuildHash: cachedEntry.outputHash,
        deterministic: cachedEntry.deterministic,
        cached: true,
      });
      logger.success(`  ${artifact.id}: cached (deterministic=${cachedEntry.deterministic})`);
      continue;
    }

    const absOutputPath = join(workspaceRoot, outputPath);

    try {
      await execAsync(produceCommand, { cwd: workspaceRoot, timeout: 60_000 });
      const firstHash = await byteHashFile(absOutputPath);

      await execAsync(produceCommand, { cwd: workspaceRoot, timeout: 60_000 });
      const secondHash = await byteHashFile(absOutputPath);

      const deterministic = firstHash === secondHash;

      results.push({
        artifactId: artifact.id,
        hashable: true,
        inputs: determinism.inputs,
        inputHash,
        firstBuildHash: firstHash,
        secondBuildHash: secondHash,
        deterministic,
        cached: false,
      });

      cache.entries[cacheKey] = {
        inputHash,
        produceCommand,
        outputHash: firstHash,
        deterministic,
      };

      if (deterministic) {
        logger.success(`  ${artifact.id}: deterministic`);
      } else {
        logger.error(`  ${artifact.id}: NON-DETERMINISTIC (hashes differ)`);
      }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      results.push({
        artifactId: artifact.id,
        hashable: true,
        inputs: determinism.inputs,
        inputHash,
        firstBuildHash: null,
        secondBuildHash: null,
        deterministic: false,
        cached: false,
        error: e.stderr ?? e.message,
      });
      logger.error(`  ${artifact.id}: build failed (${e.message})`);
    }
  }

  await writeCache(cachePath, cache);

  const allDeterministic = results.every((r) => r.deterministic);

  return {
    data: {
      command: "forge.determinism.check",
      profileId: profile.id,
      artifacts: results,
      allDeterministic,
    },
    exitCode: allDeterministic ? 0 : 1,
    summary: allDeterministic
      ? `forge.determinism.check: all ${results.length} artifact(s) deterministic`
      : `forge.determinism.check: ${results.filter((r) => !r.deterministic).length} artifact(s) non-deterministic`,
  };
}
