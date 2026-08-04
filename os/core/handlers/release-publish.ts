/*
<MODULE_CONTRACT>
<purpose>forge.release.publish — publish a prepared release to the declared target (local, R2, S3). Supports --dry-run, --json, --profile.</purpose>
<non-goals>
  <item>Do not implement release preparation — that lives in release-prepare.ts.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0680: initial forge.release.publish handler with local/r2/s3 targets, --dry-run, env var validation.</item>
  <item>RFC-0680 review fix: remove unused readdir import (A-1).</item>
  <item>RFC-0680 review fix: add S3_ENDPOINT to required env vars (G-1).</item>
  <item>RFC-0680 review fix: add 30s request timeout on S3Client (G-2).</item>
</CHANGE_SUMMARY>
*/

import { readFile, copyFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";
import type { ReleaseManifest } from "./release-prepare.ts";

export interface ForgeReleasePublishResult {
  command: "forge.release.publish";
  profileId: string;
  target: string;
  publishedFiles: Array<{ path: string; targetPath: string }>;
  manifestPath: string;
}

function getRequiredEnvVars(target: string): string[] {
  if (target === "r2") {
    return ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  }
  if (target === "s3") {
    return ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"];
  }
  return [];
}

export async function runReleasePublish(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeReleasePublishResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.release.publish",
        profileId: "",
        target: "",
        publishedFiles: [],
        manifestPath: "",
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
        command: "forge.release.publish",
        profileId: profile.id,
        target: "",
        publishedFiles: [],
        manifestPath: "",
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare a release configuration.`,
    };
  }

  const releaseConfig = profile.release;
  const releaseDir = join(workspaceRoot, releaseConfig.outputDir);
  const manifestPath = join(releaseDir, releaseConfig.manifestName);

  let manifest: ReleaseManifest;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw) as ReleaseManifest;
  } catch {
    return {
      data: {
        command: "forge.release.publish",
        profileId: profile.id,
        target: releaseConfig.target,
        publishedFiles: [],
        manifestPath,
      },
      exitCode: 1,
      summary: `No release manifest found at ${manifestPath}. Run \`forge release prepare\` first.`,
    };
  }

  const target = releaseConfig.target;
  const requiredVars = getRequiredEnvVars(target);
  const missingVars = requiredVars.filter((v) => !process.env[v]);

  if (missingVars.length > 0) {
    return {
      data: {
        command: "forge.release.publish",
        profileId: profile.id,
        target,
        publishedFiles: [],
        manifestPath,
      },
      exitCode: 1,
      summary: `Missing required environment variables: ${missingVars.join(", ")}`,
    };
  }

  const filesToPublish: string[] = [];
  for (const a of manifest.artifacts) {
    filesToPublish.push(join(releaseDir, basename(a.path)));
  }
  filesToPublish.push(manifestPath);

  if (dryRun) {
    logger.info(`[dry-run] forge.release.publish — profile: ${profile.id}`);
    logger.info(`  target: ${target}`);
    for (const f of filesToPublish) {
      logger.info(`  file: ${f}`);
    }
    return {
      data: {
        command: "forge.release.publish",
        profileId: profile.id,
        target,
        publishedFiles: filesToPublish.map((f) => ({
          path: f,
          targetPath:
            target === "local"
              ? join(releaseDir, "published", basename(f))
              : `${target}://${basename(f)}`,
        })),
        manifestPath,
      },
      summary: `[dry-run] Would publish ${filesToPublish.length} file(s) to ${target}`,
    };
  }

  const publishedFiles: Array<{ path: string; targetPath: string }> = [];

  if (target === "local") {
    const publishedDir = join(releaseDir, "published");
    await mkdir(publishedDir, { recursive: true });
    for (const f of filesToPublish) {
      const dst = join(publishedDir, basename(f));
      await copyFile(f, dst);
      publishedFiles.push({ path: f, targetPath: dst });
    }
  } else if (target === "r2" || target === "s3") {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { readFile: fsReadFile } = await import("node:fs/promises");

    const endpoint =
      target === "r2"
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : process.env.S3_ENDPOINT;
    const bucket = target === "r2" ? releaseConfig.r2?.bucket : process.env.S3_BUCKET;
    const accessKeyId =
      target === "r2" ? process.env.R2_ACCESS_KEY_ID : process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey =
      target === "r2" ? process.env.R2_SECRET_ACCESS_KEY : process.env.S3_SECRET_ACCESS_KEY;
    const prefix = target === "r2" ? (releaseConfig.r2?.prefix ?? "") : "";

    const client = new S3Client({
      endpoint,
      region: "auto",
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      requestHandler: { requestTimeout: 30_000 },
    });

    for (const f of filesToPublish) {
      const key = prefix ? `${prefix}/${basename(f)}` : basename(f);
      const body = await fsReadFile(f);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
        }),
      );
      publishedFiles.push({ path: f, targetPath: `${target}://${bucket}/${key}` });
    }
  }

  logger.success(`  Published ${publishedFiles.length} file(s) to ${target}`);
  return {
    data: {
      command: "forge.release.publish",
      profileId: profile.id,
      target,
      publishedFiles,
      manifestPath,
    },
    summary: `Published ${publishedFiles.length} file(s) to ${target}`,
  };
}
