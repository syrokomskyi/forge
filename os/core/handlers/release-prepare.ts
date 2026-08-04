/*
<MODULE_CONTRACT>
<purpose>forge.release.prepare — bundle built artifacts into a release package with a manifest. Supports --dry-run, --json, --profile.</purpose>
<non-goals>
  <item>Do not implement publish logic — that lives in release-publish.ts.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0680: initial forge.release.prepare handler with manifest generation, artifact hashing, --dry-run.</item>
</CHANGE_SUMMARY>
*/

import { readFile, writeFile, copyFile, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";
import { byteHashFile } from "@warpgogol/fingerprint";
import { collectFiles } from "@warpgogol/share/fs";
import type { ProfileRelease } from "../../../src/profiles/profile-schema.ts";

export interface ReleaseManifest {
  schemaVersion: string;
  releaseId: string;
  profileId: string;
  version: string;
  createdAt: string;
  artifacts: Array<{
    artifactId: string;
    path: string;
    hash: string;
    size: number;
    deterministic: boolean;
  }>;
  determinismChecked: boolean;
  validationPassed: boolean;
}

export interface ForgeReleasePrepareResult {
  command: "forge.release.prepare";
  profileId: string;
  releaseDir: string;
  manifest: ReleaseManifest;
}

function generateReleaseId(profileId: string, shortHash: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  return `${profileId}-${ts}-${shortHash}`;
}

async function readVersionFromPackageJson(workspaceRoot: string): Promise<string> {
  try {
    const raw = await readFile(join(workspaceRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function findBuiltArtifacts(
  workspaceRoot: string,
  artifactId: string,
  extensions: string[],
  produceOutput?: string,
): Promise<string[]> {
  if (produceOutput) {
    const outputPattern = produceOutput.replace("{composition}", "*");
    const basePattern = basename(outputPattern);
    const isGlob = basePattern.includes("*");
    if (!isGlob) {
      const fullPath = join(workspaceRoot, produceOutput);
      try {
        const s = await stat(fullPath);
        return [fullPath];
      } catch {
        return [];
      }
    }
    // Extract extension from the output pattern (e.g. "*.mp4" → ".mp4")
    const extMatch = basePattern.match(/(\.[^.]+)$/);
    const outputExts = extMatch ? [extMatch[1]] : extensions;
    const distDir = join(workspaceRoot, "dist");
    const files = await collectFiles(distDir, {
      extensions: outputExts,
      ignore: (name) => name.startsWith("-") || name.startsWith("old-") || name === ".DS_Store",
    });
    const regex = new RegExp(
      "^" + basePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return files.filter((f) => regex.test(basename(f)));
  }
  const distDir = join(workspaceRoot, "dist");
  return collectFiles(distDir, {
    extensions,
    ignore: (name) => name.startsWith("-") || name.startsWith("old-") || name === ".DS_Store",
  });
}

export async function runReleasePrepare(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeReleasePrepareResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.release.prepare",
        profileId: "",
        releaseDir: "",
        manifest: {
          schemaVersion: "1",
          releaseId: "",
          profileId: "",
          version: "",
          createdAt: "",
          artifacts: [],
          determinismChecked: false,
          validationPassed: false,
        },
      },
      exitCode: 1,
      summary: "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [{ action: "Set profile in forge.yaml or use --profile <id>", kind: "required" }],
    };
  }

  const { profile } = resolved;

  if (!profile.release) {
    return {
      data: {
        command: "forge.release.prepare",
        profileId: profile.id,
        releaseDir: "",
        manifest: {
          schemaVersion: "1",
          releaseId: "",
          profileId: profile.id,
          version: "",
          createdAt: "",
          artifacts: [],
          determinismChecked: false,
          validationPassed: false,
        },
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare a release configuration.`,
    };
  }

  const releaseConfig: ProfileRelease = profile.release;
  const releaseDir = join(workspaceRoot, releaseConfig.outputDir);

  const artifacts = profile.artifacts ?? [];
  const includeArtifacts = releaseConfig.includeArtifacts;
  const filteredArtifacts = includeArtifacts
    ? artifacts.filter((a) => includeArtifacts.includes(a.id))
    : artifacts.filter((a) => a.produce?.output);

  const version = await readVersionFromPackageJson(workspaceRoot);

  const manifestArtifacts: ReleaseManifest["artifacts"] = [];
  let allHashes = "";

  for (const artifact of filteredArtifacts) {
    const builtFiles = await findBuiltArtifacts(
      workspaceRoot,
      artifact.id,
      artifact.extensions,
      artifact.produce?.output,
    );

    if (builtFiles.length === 0) {
      return {
        data: {
          command: "forge.release.prepare",
          profileId: profile.id,
          releaseDir: "",
          manifest: {
            schemaVersion: "1",
            releaseId: "",
            profileId: profile.id,
            version,
            createdAt: "",
            artifacts: [],
            determinismChecked: false,
            validationPassed: false,
          },
        },
        exitCode: 1,
        summary: `Artifact ${artifact.id} has no built output — run \`forge build\` first.`,
      };
    }

    for (const builtFile of builtFiles) {
      const relPath = builtFile.replace(workspaceRoot + "/", "");
      let hash = "";
      let size = 0;

      if (!dryRun) {
        hash = await byteHashFile(builtFile);
        const stats = await stat(builtFile);
        size = stats.size;
        allHashes += hash;
      }

      manifestArtifacts.push({
        artifactId: artifact.id,
        path: relPath,
        hash,
        size,
        deterministic: artifact.determinism?.hashable ?? false,
      });
    }
  }

  const shortHash = allHashes
    ? createHash("sha256").update(allHashes).digest("hex").slice(0, 8)
    : "dryrun00";
  const releaseId = generateReleaseId(profile.id, shortHash);
  const createdAt = new Date().toISOString();

  const manifest: ReleaseManifest = {
    schemaVersion: "1",
    releaseId,
    profileId: profile.id,
    version,
    createdAt,
    artifacts: manifestArtifacts,
    determinismChecked: false,
    validationPassed: true,
  };

  if (dryRun) {
    logger.info(`[dry-run] forge.release.prepare — profile: ${profile.id}`);
    logger.info(`  releaseId: ${releaseId}`);
    logger.info(`  version: ${version}`);
    logger.info(`  outputDir: ${releaseConfig.outputDir}`);
    for (const a of manifestArtifacts) {
      logger.info(`  artifact: ${a.artifactId} — ${a.path}`);
    }
    return {
      data: {
        command: "forge.release.prepare",
        profileId: profile.id,
        releaseDir: releaseConfig.outputDir,
        manifest,
      },
      summary: `[dry-run] Release prepared: ${manifestArtifacts.length} artifact(s), releaseId: ${releaseId}`,
    };
  }

  await mkdir(releaseDir, { recursive: true });

  for (const a of manifestArtifacts) {
    const srcPath = join(workspaceRoot, a.path);
    const dstPath = join(releaseDir, basename(a.path));
    await copyFile(srcPath, dstPath);
  }

  const manifestPath = join(releaseDir, releaseConfig.manifestName);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  logger.success(`  Release prepared: ${manifestArtifacts.length} artifact(s)`);
  logger.info(`  Manifest: ${manifestPath}`);

  return {
    data: {
      command: "forge.release.prepare",
      profileId: profile.id,
      releaseDir: releaseConfig.outputDir,
      manifest,
    },
    summary: `Release prepared: ${manifestArtifacts.length} artifact(s), releaseId: ${releaseId}`,
  };
}
