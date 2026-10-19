/*
<MODULE_CONTRACT>
<purpose>RFC-1336: shared authority-module helpers — werkstatt-layout site
probes (systems-cache sibling convention) and Bordbuch audit-event emission
through the kernel's sibling-invocation port (ForgeRuntimeContext.invoke,
RFC-1306). All engine touchpoints degrade cleanly under the standalone
forge CLI where no kernel host exists.</purpose>
<non-goals>
  <item>Do not import @warpgogol/* runtime packages — FORGE-AUTONOMY-01; the invoke port is the only engine surface.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial module — systemsCacheSiteExists, coveredSites, appendAuthorityEvent.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import type { DelegationEntry } from "../../src/authority/delegations.ts";
import type { ForgeRuntimeContext, WorkspaceIO } from "../../src/types.ts";
import { resolveIo } from "../../src/utils/io.ts";

/**
 * Werkstatt layout: systems-cache/<id> is a sibling of the workshop root
 * (mirrors[0], RFC-0790). A declared site-scoped grant must name a site that
 * actually exists — a typo'd site would silently bind to nothing.
 */
export async function systemsCacheSiteExists(
  workspaceRoot: string,
  siteId: string,
  io?: WorkspaceIO,
): Promise<boolean> {
  const effectiveIo = resolveIo(io);
  const siteDir = path.resolve(workspaceRoot, "..", "systems-cache", siteId);
  return effectiveIo.exists(siteDir);
}

/**
 * Enumerate the sites a grant covers for audit-event fan-out: explicit ids,
 * or every systems-cache sibling dir for "workspace" grants.
 */
export async function coveredSites(
  workspaceRoot: string,
  grant: Pick<DelegationEntry, "sites">,
  io?: WorkspaceIO,
): Promise<string[]> {
  if (grant.sites !== "workspace") return grant.sites;
  const effectiveIo = resolveIo(io);
  const cacheDir = path.resolve(workspaceRoot, "..", "systems-cache");
  if (!(await effectiveIo.exists(cacheDir))) return [];
  const entries = await effectiveIo.readdir(cacheDir);
  return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

/**
 * Append one audit event per covered site via bordbuch.append — the
 * sibling-invocation port exists only under a kernel host; under the
 * standalone forge CLI the registry write has already landed (it is the
 * source of truth) and the event degrades to a warning.
 */
export async function appendAuthorityEvent(
  context: ForgeRuntimeContext,
  opts: {
    kind: "authority-delegation" | "authority-delegation-revoked";
    sites: string[];
    summary: string;
    actor: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ appended: string[]; skipped: boolean }> {
  if (!context.invoke) {
    context.logger.warn(
      `  [authority] bordbuch event '${opts.kind}' not recorded — no kernel host (registry is the source of truth)`,
    );
    return { appended: [], skipped: true };
  }
  const appended: string[] = [];
  for (const siteId of opts.sites) {
    const result = await context.invoke("bordbuch.append", {
      system: siteId,
      kind: opts.kind,
      summary: opts.summary,
      actor: opts.actor,
      "writer-role": "operator",
      metadata: JSON.stringify(opts.metadata),
    });
    if (result.ok || result.exitCode === 0) {
      appended.push(siteId);
    } else {
      context.logger.warn(
        `  [authority] bordbuch event for '${siteId}' failed: ${result.summary ?? "unknown"}`,
      );
    }
  }
  return { appended, skipped: false };
}

export function flagString(
  input: { flags: Record<string, unknown> },
  key: string,
): string | undefined {
  const v = input.flags[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function flagStringList(input: { flags: Record<string, unknown> }, key: string): string[] {
  const v = input.flags[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v.length > 0 ? [v] : [];
}
