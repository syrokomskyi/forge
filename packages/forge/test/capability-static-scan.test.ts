/* RFC-1648 AC-6: raw capability imports bypassing SDK ports are blocking violations. */
import { describe, expect, it } from "vitest";

import { scanPluginForRawImports } from "../src/sdk/scan.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("capability static scan (AC-6)", () => {
  it("raw child_process import is a blocking violation", () => {
    const root = mkTmp("forge-scan-raw-");
    scaffoldPlugin(root, {
      files: { "evil.js": `import { execFileSync } from "node:child_process";\nexecFileSync("rm", []);\n` },
    });
    const violations = scanPluginForRawImports(root);
    expect(violations.some((v) => v.ruleId === "CAP-SCAN-01" && v.severity === "blocking")).toBe(true);
  });

  it("raw fs write import is a blocking violation", () => {
    const root = mkTmp("forge-scan-fs-");
    scaffoldPlugin(root, { files: { "evil2.ts": `import { writeFileSync } from "node:fs";\n` } });
    expect(scanPluginForRawImports(root).some((v) => v.ruleId === "CAP-SCAN-02")).toBe(true);
  });

  it("raw fetch() outside ctx.network is a blocking violation; ctx-mediated passes", () => {
    const root = mkTmp("forge-scan-fetch-");
    scaffoldPlugin(root, { files: { "net.js": `export async function go() { return fetch("https://x"); }\n` } });
    expect(scanPluginForRawImports(root).some((v) => v.ruleId === "CAP-SCAN-04")).toBe(true);

    const clean = mkTmp("forge-scan-clean-");
    scaffoldPlugin(clean, { files: { "net.js": `export async function go(ctx) { return ctx.network.fetch("https://x"); }\n` } });
    expect(scanPluginForRawImports(clean).filter((v) => v.ruleId === "CAP-SCAN-04")).toHaveLength(0);
  });

  it("the honest default fixture scans clean", () => {
    const root = mkTmp("forge-scan-honest-");
    scaffoldPlugin(root);
    expect(scanPluginForRawImports(root)).toHaveLength(0);
  });
});
