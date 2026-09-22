/*
<MODULE_CONTRACT>
<purpose>Lazy dynamic-import bridge for @warpgogol/werkstatt-shared/node/fs and @warpgogol/werkstatt-shared/fingerprint. These workspace packages are not published to npm — when forge is installed standalone from npm, they are unavailable and handlers that depend on them must degrade gracefully.</purpose>
<non-goals>
  <item>Do not re-export types from @warpgogol/* — only runtime functions.</item>
  <item>Do not use static imports — that would break npm installs without workspace deps.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0682: extract dynamic-import helper so forge publishes without workspace:* deps.</item>
  <item>RFC-0940: moved from os/core/handlers/ to os/werkstatt/handlers/ — this module imports @warpgogol/werkstatt-engine and belongs in the adapter directory.</item>
  <item>2026-09-22: fingerprint import switched from @warpgogol/werkstatt-engine/fingerprint to @warpgogol/werkstatt-shared/fingerprint (canonical home since RFC-1104) — breaks the forge↔engine package cycle reported by turbo.</item>
</CHANGE_SUMMARY>
*/

export type CollectFilesFn = (
  root: string,
  options?: {
    extensions?: string[];
    ignore?: (name: string) => boolean;
  },
) => Promise<string[]>;

export type ByteHashFileFn = (filePath: string) => Promise<string>;

interface WorkspaceDeps {
  collectFiles: CollectFilesFn;
  byteHashFile: ByteHashFileFn;
}

let cached: WorkspaceDeps | null = null;
let loadError: string | null = null;

export async function loadWorkspaceDeps(): Promise<WorkspaceDeps> {
  if (cached) return cached;
  if (loadError) throw new Error(loadError);

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
    const shareMod = await import("@warpgogol/werkstatt-shared/node/fs");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
    const fpMod = await import("@warpgogol/werkstatt-shared/fingerprint");
    cached = {
      collectFiles: shareMod.collectFiles as CollectFilesFn,
      byteHashFile: fpMod.byteHashFile as ByteHashFileFn,
    };
    return cached;
  } catch (err) {
    loadError =
      `@warpgogol/werkstatt-shared/fingerprint and @warpgogol/werkstatt-shared/node/fs are required for this command but not installed. ` +
      `When using forge standalone from npm, install them separately or use forge within the warpgogol workspace. ` +
      `Error: ${(err as Error).message}`;
    throw new Error(loadError);
  }
}
