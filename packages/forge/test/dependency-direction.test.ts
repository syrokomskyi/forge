/* RFC-1648 AC-3: dependency direction — scopeless or internal deps fail integration. */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scanPluginDependencyDirection } from "../src/sdk/scan.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("dependency direction (AC-3)", () => {
  it("scopeless shared package dependency is blocking", () => {
    const root = mkTmp("forge-dep-scopeless-");
    scaffoldPlugin(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-plugin", dependencies: { lodash: "^4.0.0" } }));
    expect(scanPluginDependencyDirection(root).some((v) => v.ruleId === "PLUG-DEP-02" && v.severity === "blocking")).toBe(true);
  });

  it("werkstatt-internal dependency is blocking", () => {
    const root = mkTmp("forge-dep-internal-");
    scaffoldPlugin(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-plugin", dependencies: { "@warpgogol/werkstatt-engine": "^9.0.0" } }));
    expect(scanPluginDependencyDirection(root).some((v) => v.ruleId === "PLUG-DEP-01")).toBe(true);
  });

  it("SDK and forge-plugin dependencies pass", () => {
    const root = mkTmp("forge-dep-clean-");
    scaffoldPlugin(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-plugin", dependencies: { "@warpgogol/forge": "^10.0.0", "@warpgogol/forge-typescript": "^1.0.0" } }));
    expect(scanPluginDependencyDirection(root)).toHaveLength(0);
  });
});
