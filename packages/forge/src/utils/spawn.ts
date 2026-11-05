/*
<MODULE_CONTRACT>
<purpose>
Portable command resolution for spawn seams. Node's spawn cannot exec a
bare package-manager name on Windows — pnpm/npm/yarn/bun ship as `*.cmd`
PATHEXT shims, and CreateProcess never consults PATHEXT the way cmd.exe
does. resolveSpawnable scans PATH × PATHEXT to find the real executable;
resolveSpawnPlan wraps a resolved .cmd/.bat in `cmd.exe /d /s /c` because
Node refuses to spawn batch files without a shell since the CVE-2024-27980
hardening. Unresolvable names return the original argv untouched so a
missing tool still surfaces as spawn ENOENT — callers that map ENOENT to
"unavailable" keep their contract.
</purpose>
<non-goals>
  <item>Does not resolve scripts inside node_modules/.bin — those are POSIX sh shims, callers exec them via `sh` explicitly.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Resolution is upfront, not retry-on-ENOENT — a retry via cmd would turn a genuinely missing binary into exit 9009 and silently change "unavailable" verdicts into refusals.</item>
  <item>Paths and extension-bearing names pass through unresolved — CreateProcess handles them directly on every platform.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>T-0007: Windows forge-tests remediation — one PATH+PATHEXT resolver shared by the ambient exec adapter, the proof runner, and the probe batcher.</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "./sync-fs.ts";
import { delimiter, join } from "node:path";

const IS_WIN = process.platform === "win32";

/**
 * Resolve a bare command name through Windows PATH × PATHEXT (the search
 * cmd.exe performs and CreateProcess does not). Returns the command
 * unchanged when it already names a path (contains a separator or an
 * extension) or when the platform is not Windows. Returns `null` when a
 * bare name resolves to nothing — the caller keeps the original argv so
 * the spawn still reports ENOENT.
 */
export function resolveSpawnable(command: string): string | null {
  if (!IS_WIN) return command;
  if (/[/\\]/.test(command) || /\.[a-zA-Z0-9]+$/.test(command)) return command;
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const rawDir of (process.env.PATH ?? "").split(delimiter)) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of pathext) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Pass through to spawn's windowsVerbatimArguments — args are pre-quoted. */
  verbatim: boolean;
}

/** cmd.exe-safe quoting: only needed when whitespace or shell metachars appear. */
function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // Trailing backslashes doubled so they cannot escape the closing quote;
  // inner quotes are backslash-escaped (MSVCRT convention the .cmd inherits).
  const inner = arg.replace(/(\\)+$/, "$1$1").replace(/"/g, '\\"');
  return `"${inner}"`;
}

/**
 * Build the spawn pair for `command` + `args`. A bare name resolved to a
 * .cmd/.bat shim is re-routed through `cmd.exe /d /s /c` with the args
 * pre-quoted (windowsVerbatimArguments must be set on the spawn so Node
 * does not re-mangle the quoting). Everything else spawns directly.
 */
export function resolveSpawnPlan(command: string, args: string[]): SpawnPlan {
  const resolved = resolveSpawnable(command);
  if (resolved === null) return { command, args, verbatim: false };
  if (IS_WIN && /\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", quoteCmdArg(resolved), ...args.map(quoteCmdArg)],
      verbatim: true,
    };
  }
  return { command: resolved, args, verbatim: false };
}
