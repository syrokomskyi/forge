/*
<MODULE_CONTRACT>
<purpose>Lazy dynamic-import bridge for @warpgogol/werkstatt-engine/werkstatt — the session-worktree API backing werkstatt.session.* handlers. The engine is a workspace dependency absent on standalone npm installs; handlers must degrade to a clear error instead of breaking module load.</purpose>
<non-goals>
  <item>Do not use static imports — that would break npm installs without workspace deps.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
export type SessionEngineApi = typeof import("@warpgogol/werkstatt-engine/werkstatt");

let cached: SessionEngineApi | null = null;

export async function loadSessionEngine(): Promise<SessionEngineApi> {
  if (cached) return cached;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
    cached = (await import("@warpgogol/werkstatt-engine/werkstatt")) as SessionEngineApi;
    return cached;
  } catch (err) {
    throw new Error(
      `@warpgogol/werkstatt-engine is required for werkstatt.session.* commands but not installed. ` +
        `When using forge standalone from npm, run inside a werkstatt workspace that provides it. ` +
        `Error: ${(err as Error).message}`,
    );
  }
}
