/*
<MODULE_CONTRACT>
<purpose>
Lifecycle-hook invocation surface (RFC-1648) — the only path through which plugin
hooks execute. Fail-loud per hook: a throwing hook surfaces as an error result,
never silently swallowed; one hook's failure does not prevent the remaining
implementations of the same hook from running (each is isolated, all errors
collected). Hook execution order is plugin load order — deterministic.
</purpose>
<CHANGE_SUMMARY><item>RFC-1648 WP-5 completion: initial invocation surface.</item></CHANGE_SUMMARY>
*/

import type { HookPayload, LifecycleHook, PluginContext } from "./types.ts";
import type { LoadedPlugin } from "./loader.ts";

export interface HookInvocationError {
  pluginId: string;
  hook: LifecycleHook;
  error: string;
}

export interface HookInvocationResult {
  ran: number;
  errors: HookInvocationError[];
}

/** Invoke one lifecycle hook across all active plugins — deterministic load order, isolated failures. */
export async function invokeLifecycleHook(
  plugins: LoadedPlugin[],
  hook: LifecycleHook,
  payload: HookPayload = {},
): Promise<HookInvocationResult> {
  let ran = 0;
  const errors: HookInvocationError[] = [];
  for (const plugin of plugins) {
    for (const hookModule of plugin.hooks) {
      if (hookModule.hook !== hook) continue;
      ran += 1;
      try {
        await hookModule.run(plugin.ctx as PluginContext, payload);
      } catch (err) {
        errors.push({
          pluginId: plugin.manifest.id,
          hook,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { ran, errors };
}
