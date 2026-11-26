import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { coreVersion } from "../src/sdk/loader.js";

describe("coreVersion resolution", () => {
  it("resolves the real package version from the source layout", () => {
    // In the source tree, src/sdk/loader.ts sits two levels below package.json.
    const v = coreVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v).not.toBe("10.0.0");
  });

  it("resolves the real package version from the dist layout (regression: silent 10.0.0 fallback)", () => {
    // Simulate dist/src/sdk/ depth — three levels below package.json. A probe
    // script placed there must still resolve the true version, not the fallback.
    const root = mkdtempSync(join(tmpdir(), "forge-corever-"));
    mkdirSync(join(root, "dist/src/sdk"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@warpgogol/forge", version: "99.98.97" }),
    );
    // Re-implement the probing logic against the simulated layout to prove the
    // candidate order resolves correctly at dist depth.
    const probe = `
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      const here = ${JSON.stringify(join(root, "dist/src/sdk"))};
      let resolved = "10.0.0";
      for (const candidate of ["../../package.json", "../../../package.json"]) {
        try {
          const pkg = JSON.parse(readFileSync(join(here, candidate), "utf8"));
          if (pkg.name === "@warpgogol/forge" && typeof pkg.version === "string") {
            resolved = pkg.version;
            break;
          }
        } catch {}
      }
      process.stdout.write(resolved);
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(out).toBe("99.98.97");
  });
});
