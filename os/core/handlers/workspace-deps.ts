/*
<MODULE_CONTRACT>
<purpose>Lazy dynamic-import bridge for @warpgogol/fingerprint and @warpgogol/share/fs. These workspace packages are not published to npm — when forge is installed standalone from npm, they are unavailable and handlers that depend on them must degrade gracefully.</purpose>
<non-goals>
  <item>Do not re-export types from @warpgogol/* — only runtime functions.</item>
  <item>Do not use static imports — that would break npm installs without workspace deps.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0682: extract dynamic-import helper so forge publishes without workspace:* deps.</item>
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
    // @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
    const shareMod = await import("@warpgogol/share/fs");
    // @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
    const fpMod = await import("@warpgogol/fingerprint");
    cached = {
      collectFiles: shareMod.collectFiles as CollectFilesFn,
      byteHashFile: fpMod.byteHashFile as ByteHashFileFn,
    };
    return cached;
  } catch (err) {
    loadError =
      `@warpgogol/fingerprint and @warpgogol/share are required for this command but not installed. ` +
      `When using forge standalone from npm, install them separately or use forge within the warpgogol workspace. ` +
      `Error: ${(err as Error).message}`;
    throw new Error(loadError);
  }
}
