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
  <item>RFC-1508: align rfc-1508 schemas with the normative contract after review r1</item>
  <item>RFC-1508: close rfc-1508 review r2 findings on folder lookup and diagnostics</item>
  <item>RFC-1511: scenarios, version sets and system.versionset.record</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { runSystemMapValidate } from "../handlers/system-map-validate.ts";
import { edgeVerdict, loadSystemMap } from "../repo.ts";
import { systemEdgesSchema } from "../schemas.ts";
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
    reason: temporary quarantine
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-04");
  });

  it("AC-5: product missing from products.local.yaml warns SYSTEM-MAP-05 with exit 0", async () => {
    const files = validMapFiles();
    files["system/products.local.yaml"] =
      "schema: forge/system-products-local@1\nfolders:\n  alpha: ./alpha\n";
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
    reason: quarantine
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

  it("duplicate product ids report SYSTEM-MAP-02", async () => {
    const files = validMapFiles();
    files["system/products.yaml"] = `schema: forge/system-products@1
products:
  - id: alpha
    remote: https://example.invalid/a.git
    offers: [alpha-contract]
  - id: alpha
    remote: https://example.invalid/b.git
    offers: []
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    const diags = result.data?.diagnostics ?? [];
    expect(diags.find((d) => d.ruleId === "SYSTEM-MAP-02")?.message).toContain("duplicate");
  });

  it("schema-invalid files report SYSTEM-MAP-01 — unknown keys and missing forbidden reason", async () => {
    const files = validMapFiles();
    files["system/edges.yaml"] = `schema: forge/system-edges@1
allowed:
  - consumer: beta
    contract: alpha-contract
    bogus: key
forbidden:
  - consumer: beta
    contract: alpha-contract
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    const diags = result.data?.diagnostics ?? [];
    expect(ruleIds(diags)).toContain("SYSTEM-MAP-01");
    expect(diags.every((d) => d.severity === "error")).toBe(true);
  });

  it("SYSTEM-MAP-01 on a schema-invalid file leaves the map unloaded (no cross-checks)", async () => {
    const files = validMapFiles();
    files["system/products.yaml"] = "schema: forge/system-products@1\nproducts:\n  - id: alpha\n";
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    const diags = result.data?.diagnostics ?? [];
    expect(diags.map((d) => d.ruleId)).toEqual(["SYSTEM-MAP-01"]);
  });

  it("SYSTEM-MAP-05 warns when a mapped folder does not exist", async () => {
    const files = validMapFiles();
    files["system/products.local.yaml"] = `schema: forge/system-products-local@1
folders:
  alpha: ./alpha
  beta: ./missing-beta
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(0);
    const warning = result.data?.diagnostics.find((d) => d.ruleId === "SYSTEM-MAP-05");
    expect(warning?.message).toContain("missing-beta");
  });

  it("a malformed products.local.yaml is SYSTEM-MAP-01, not a throw", async () => {
    const files = validMapFiles();
    files["system/products.local.yaml"] = "schema: forge/system-products-local@1\nfolders: [not-a-map\n";
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-01");
  });

  it("the extended forbidden-edge schema stays strict about unknown keys", () => {
    const parse = systemEdgesSchema.safeParse({
      schema: "forge/system-edges@1",
      forbidden: [
        { consumer: "beta", contract: "alpha-contract", reason: "deprecated", bogus: "key" },
      ],
    });
    expect(parse.success).toBe(false);
  });

  it("AC-9: a scenario naming an unknown product reports SYSTEM-MAP-06", async () => {
    const files = validMapFiles();
    files["system/scenarios/lead-flow.yaml"] = `schema: forge/system-scenario@1
id: lead-flow
title: lead flow
products: [ghost]
contracts: []
checks:
  - product: ghost
    argv: [node, -e, "console.log('x')"]
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-06");
  });

  it("AC-9: a scenario naming a contract no product offers reports SYSTEM-MAP-06", async () => {
    const files = validMapFiles();
    files["system/scenarios/lead-flow.yaml"] = `schema: forge/system-scenario@1
id: lead-flow
title: lead flow
products: [alpha]
contracts: [ghost-contract]
checks:
  - product: alpha
    argv: [node, -e, "console.log('x')"]
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-06");
  });

  it("a malformed scenario file reports SYSTEM-MAP-01 like any map file", async () => {
    const files = validMapFiles();
    files["system/scenarios/broken.yaml"] = "schema: forge/system-scenario@1\nid: [not-a-string\n";
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(ruleIds(result.data?.diagnostics ?? [])).toContain("SYSTEM-MAP-01");
  });

  it("a valid scenario adds no diagnostics", async () => {
    const files = validMapFiles();
    files["system/scenarios/lead-flow.yaml"] = `schema: forge/system-scenario@1
id: lead-flow
title: lead flow
products: [alpha]
contracts: [alpha-contract]
checks:
  - product: alpha
    argv: [node, -e, "console.log('x')"]
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.data?.diagnostics.every((d) => d.ruleId !== "SYSTEM-MAP-06")).toBe(true);
  });

  it("a product id colliding with Object.prototype keys still gets the unmapped-folder warning", async () => {
    const files = validMapFiles();
    files["system/products.yaml"] = `schema: forge/system-products@1
products:
  - id: alpha
    remote: git@example.com:org/alpha.git
    offers: [alpha-contract]
  - id: beta
    remote: git@example.com:org/beta.git
    offers: []
  - id: constructor
    remote: git@example.com:org/constructor.git
    offers: []
`;
    const root = await makeSystemRepo(files);
    const result = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(result.exitCode).toBe(0);
    const warning = result.data?.diagnostics.find(
      (d) => d.ruleId === "SYSTEM-MAP-05" && d.message.includes("constructor"),
    );
    expect(warning).toBeDefined();
  });
});
