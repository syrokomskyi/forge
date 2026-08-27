/*
<MODULE_CONTRACT>
<purpose>Plugin entry point tests — verify werkstattTypescriptPlugin shape and contract compliance (RFC-0889).</purpose>
<keywords>test, plugin, entry, typescript</keywords>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial plugin entry point tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import { werkstattTypescriptPlugin } from "../index.ts";
import { TYPESCRIPT_INVARIANTS } from "../invariants/typescript-invariants.ts";

describe("werkstattTypescriptPlugin", () => {
  it("has schema werkstatt/plugin@1", () => {
    expect(werkstattTypescriptPlugin.schema).toBe("werkstatt/plugin@1");
  });

  it("has id werkstatt-typescript", () => {
    expect(werkstattTypescriptPlugin.id).toBe("werkstatt-typescript");
  });

  it("has profileId typescript-turborepo", () => {
    expect(werkstattTypescriptPlugin.profileId).toBe("typescript-turborepo");
  });

  it("has moduleLoaders.checks function", () => {
    expect(typeof werkstattTypescriptPlugin.moduleLoaders.checks).toBe("function");
  });

  it("has 6 invariants (TS-001..006)", () => {
    expect(TYPESCRIPT_INVARIANTS).toHaveLength(6);
    expect(TYPESCRIPT_INVARIANTS[0].id).toBe("TS-001");
    expect(TYPESCRIPT_INVARIANTS[5].id).toBe("TS-006");
  });

  it("does not have deployAdapters", () => {
    expect(werkstattTypescriptPlugin.deployAdapters).toBeUndefined();
  });

  it("does not have hooks", () => {
    expect(werkstattTypescriptPlugin.hooks).toBeUndefined();
  });

  it("has paths with contentDir src", () => {
    expect(werkstattTypescriptPlugin.paths.contentDir).toBe("src");
  });

  it("has paths with distDir dist", () => {
    expect(werkstattTypescriptPlugin.paths.distDir).toBe("dist");
  });

  it("has paths with entryPoints containing src/index.ts", () => {
    expect(werkstattTypescriptPlugin.paths.entryPoints).toContain("src/index.ts");
  });
});
