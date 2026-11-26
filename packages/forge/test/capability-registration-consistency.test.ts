import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Systemic guard for the 10.2.0 defect class: a capability can exist in the
   types and even have a working port, yet be undeclarable because the loader's
   KNOWN_CAPABILITIES set was never updated — matrix-green but unreachable in
   practice. This test parses both sources and asserts exact key agreement. */

describe("capability registration consistency", () => {
  it("every capability key in the types is registered in the loader", () => {
    const typesSrc = readFileSync(join(__dirname, "../src/sdk/types.ts"), "utf8");
    const loaderSrc = readFileSync(join(__dirname, "../src/sdk/loader.ts"), "utf8");

    // Extract capability keys from the PluginManifest capabilities block —
    // the `capabilities?: { ... }` object literal in the types.
    const capsBlock = typesSrc.match(/capabilities:\s*\{([\s\S]*?)\n  \}/);
    expect(capsBlock).not.toBeNull();
    const declaredKeys = [...capsBlock![1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]).sort();
    expect(declaredKeys.length).toBeGreaterThan(0);

    // Extract the KNOWN_CAPABILITIES set members.
    const knownBlock = loaderSrc.match(/KNOWN_CAPABILITIES\s*=\s*new Set\(\[([^\]]+)\]\)/s);
    expect(knownBlock).not.toBeNull();
    const registeredKeys = [...knownBlock![1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();

    expect(registeredKeys).toEqual(declaredKeys);
  });
});
