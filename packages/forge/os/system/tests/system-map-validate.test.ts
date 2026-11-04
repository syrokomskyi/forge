/*
<MODULE_CONTRACT>
<purpose>Acceptance tests for system.map.validate and edgeVerdict (RFC-1508
AC-1..AC-6). Fixes exercised: profile gating, cross-file map rules, local
checkout warnings, and the single-lookup edge resolver's fixed precedence.</purpose>
<non-goals>
  <item>Fixtures are minimal scaffolding — the handler under test owns the contract.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 1 — system.map.validate acceptance tests (AC-1..AC-6)</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { runSystemMapValidate } from "../handlers/system-map-validate.ts";
import { edgeVerdict, loadSystemMap } from "../repo.ts";
import { makeContext, makeSystemRepo, validMapFiles } from "./helpers.ts";
import { resolveIo } from "../../../src/utils/io.ts";

function ruleIds(diagnostics: { ruleId: string }[]): string[] {
  return diagnostics.map((d) => d.ruleId);
}

describe("system.map.validate", () => {
  it("AC-1: refuses outside the system profile with SYSTEM-01", async () => {
    const root = await makeSystemRepo({ "forge.yaml": "profile: forge-shell\n", ...validMapFiles() });
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    const diags = result.data?.diagnostics ?? [];
    expect(ruleIds(diags)).toContain("SYSTEM-01");
    expect(diags.find((d) => d.ruleId === "SYSTEM-01")?.severity).toBe("error");
  });

  it("AC-1b: refuses when forge.yaml is empty", async () => {
    const bare = await makeSystemRepo({ "forge.yaml": "" });
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(bare));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-01");
  });

  it("AC-2: edge consumer not listed as a product reports SYSTEM-MAP-02", async () => {
    const files = validMapFiles();
    files["system/edges.yaml"] = `schema: forge/system-edges@1
allowed:
  - consumer: ghost
    contract: alpha-contract
forbidden: []
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-02");
  });

  it("AC-3: edge naming an unoffered contract reports SYSTEM-MAP-03", async () => {
    const files = validMapFiles();
    files["system/edges.yaml"] = `schema: forge/system-edges@1
allowed:
  - consumer: beta
    contract: phantom-contract
forbidden: []
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    const diags = result.data?.diagnostics ?? [];
    expect(ruleIds(diags)).toContain("SYSTEM-MAP-03");
    expect(diags.find((d) => d.ruleId === "SYSTEM-MAP-03")?.message).toContain("phantom-contract");
  });

  it("AC-4: pair both allowed and forbidden reports SYSTEM-MAP-04", async () => {
    const files = validMapFiles();
    files["system/edges.yaml"] = `schema: forge/system-edges@1
allowed:
  - consumer: beta
    contract: alpha-contract
forbidden:
  - consumer: beta
    contract: alpha-contract
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-04");
  });

  it("AC-5: product missing from products.local.yaml warns SYSTEM-MAP-05 with exit 0", async () => {
    const files = validMapFiles();
    files["system/products.local.yaml"] =
      "schema: forge/system-products-local@1\nproducts:\n  - alpha\n";
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(0);
    const diags = result.data?.diagnostics ?? [];
    const warning = diags.find((d) => d.ruleId === "SYSTEM-MAP-05");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("beta");
  });

  it("AC-5b: absent products.local.yaml warns SYSTEM-MAP-05 with exit 0", async () => {
    const files = validMapFiles();
    delete files["system/products.local.yaml"];
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-05");
  });

  it("AC-6: edgeVerdict returns own-contract for a product's own offered contract", async () => {
    const root = await makeSystemRepo(validMapFiles());
    const { map } = await loadSystemMap(root, resolveIo());
    expect(map).not.toBeNull();
    expect(edgeVerdict(map!, "alpha", "alpha-contract")).toBe("own-contract");
    expect(edgeVerdict(map!, "beta", "alpha-contract")).toBe("allowed");
    expect(edgeVerdict(map!, "beta", "unrelated")).toBe("undeclared");
  });

  it("AC-6b: edgeVerdict precedence — forbidden checked before allowed", async () => {
    const files = validMapFiles();
    files["system/edges.yaml"] = `schema: forge/system-edges@1
allowed:
  - consumer: beta
    contract: alpha-contract
forbidden:
  - consumer: beta
    contract: alpha-contract
`;
    const root = await makeSystemRepo(files);
    const { map } = await loadSystemMap(root, resolveIo());
    expect(edgeVerdict(map!, "beta", "alpha-contract")).toBe("forbidden");
  });

  it("a valid repository passes with exit 0", async () => {
    const root = await makeSystemRepo(validMapFiles());
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.systemId).toBe("demo-system");
    expect(result.data?.products).toBe(2);
  });

  it("missing map files report SYSTEM-MAP-01 without throwing", async () => {
    const root = await makeSystemRepo();
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-01");
  });
});
