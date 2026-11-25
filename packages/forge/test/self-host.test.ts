/*
<MODULE_CONTRACT>
<purpose>
WP-6 self-host dogfooding (RFC-1645): the forge monorepo is governed by the
npm-published forge artifact — the pin is fresh (matches latest published) and
the artifact's CLI executes against this monorepo.
</purpose>
<CHANGE_SUMMARY><item>WP-6 initial.</item></CHANGE_SUMMARY>
*/
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MONOREPO_ROOT = join(__dirname, "..", "..", "..");
const HARNESS = join(MONOREPO_ROOT, ".forge-selfhost");

describe("self-host dogfooding (WP-6)", () => {
  it("the pinned artifact exists and its CLI executes", () => {
    const cli = join(HARNESS, "node_modules", "@warpgogol", "forge", "dist", "bin", "cli.js");
    expect(existsSync(cli)).toBe(true);
    const out = execFileSync("node", [cli, "--version"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toMatch(/forge \d+\.\d+\.\d+/);
  });

  it("the pin matches the latest published version — never stale", () => {
    const pin = (JSON.parse(readFileSync(join(HARNESS, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@warpgogol/forge"];
    const latest = execFileSync("npm", ["view", "@warpgogol/forge", "version"], { encoding: "utf8", timeout: 60_000 }).trim();
    expect(pin, `self-host pin ${pin} must match latest published ${latest} — bump after release`).toBe(latest);
  });

  it("the workspace version never lags the published artifact — source ahead of pin", () => {
    const workspaceVersion = (JSON.parse(readFileSync(join(MONOREPO_ROOT, "packages", "forge", "package.json"), "utf8")) as { version: string }).version;
    const pin = (JSON.parse(readFileSync(join(HARNESS, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@warpgogol/forge"];
    // The workspace is the authoring line — it must be at or ahead of the published pin.
    const parse = (v: string): number[] => v.split(".").map(Number);
    const [wMaj, wMin, wPat] = parse(workspaceVersion);
    const [pMaj, pMin, pPat] = parse(pin!);
    const ahead = wMaj! > pMaj! || (wMaj === pMaj && wMin! > pMin!) || (wMaj === pMaj && wMin === pMin && wPat! >= pPat!);
    expect(ahead, `workspace ${workspaceVersion} must be at or ahead of pin ${pin}`).toBe(true);
  });
});
