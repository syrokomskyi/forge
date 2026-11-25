/* Shared deploy primitives — copied pure functions (byteHash, artifact layout)
   per the wave-2 inventory: no SDK port needed for pure computation. */
import type { PluginContext } from "@warpgogol/forge/sdk";

export const ARTIFACTS_BASE = ".werkstatt/artifacts/platform";

export function artifactDirPath(hash: string): string {
  return `${ARTIFACTS_BASE}/${hash}`;
}

export function distDirPath(hash: string): string {
  return `${ARTIFACTS_BASE}/${hash}/dist`;
}

export function manifestFilePath(hash: string): string {
  return `${ARTIFACTS_BASE}/${hash}/manifest.json`;
}

export async function readLinkBasename(ctx: PluginContext, linkPath: string): Promise<string | null> {
  try {
    const target = await ctx.workspace.readlink(linkPath);
    const parts = target.split("/").filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

/* Atomic swap: symlink to a unique tmp path, then rename over the target —
   rename(2) is atomic on POSIX, so observers never see a half-written link.
   The engine original shelled out to ln(1); the SDK symlink port makes the
   process spawn unnecessary — same atomicity semantics. */
export async function atomicSwap(ctx: PluginContext, linkPath: string, target: string): Promise<void> {
  const tmp = `${linkPath}.tmp-${Date.now()}`;
  await ctx.workspace.symlink(target, tmp);
  try {
    await ctx.workspace.rename(tmp, linkPath);
  } catch (err) {
    try {
      await ctx.workspace.unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/* Parse .env-style content — requireEnv parity: dotenv first, process env fallback. */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function resolveEnvKey(ctx: PluginContext, key: string): Promise<string | undefined> {
  if (await ctx.workspace.exists(".env")) {
    try {
      const parsed = parseDotEnv(await ctx.workspace.readFile(".env"));
      if (parsed[key]) return parsed[key];
    } catch {
      // fall through to process env
    }
  }
  return ctx.env.declared(key) ? ctx.env.get(key) : undefined;
}
