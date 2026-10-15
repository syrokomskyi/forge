/*
<MODULE_CONTRACT>
<purpose>Prove forge bin entry selection — source checkouts never run a stale dist/ build (RFC-1302).</purpose>
<non-goals><item>Does not spawn the CLI process.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1302: cover source-first entry selection in bin/resolve-entry.js.</item>
  <item>RFC-1302: consumer-aware SPEC-07, narrowed SPEC-10, source-first bin entry (RFC-1302)</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS bin helper without type declarations
import { resolveForgeEntry } from "../bin/resolve-entry.js";

const all = (): boolean => true;

describe("resolveForgeEntry (RFC-1302)", () => {
  it("prefers the TS source in a checkout even when a dist/ build exists", () => {
    const binDir = path.join("/repo", "packages", "forge", "bin");
    expect(resolveForgeEntry(binDir, all)).toEqual({
      kind: "src",
      path: path.join(binDir, "cli.ts"),
    });
  });

  it("uses dist/ inside node_modules", () => {
    const binDir = path.join("/ws", "node_modules", "@warpgogol", "forge", "bin");
    expect(resolveForgeEntry(binDir, all).kind).toBe("dist");
  });

  it("falls back to tsx inside node_modules without dist/", () => {
    const binDir = path.join("/ws", "node_modules", "@warpgogol", "forge", "bin");
    expect(resolveForgeEntry(binDir, () => false).kind).toBe("tsx");
  });
});
