/*
<MODULE_CONTRACT>
<purpose>Unit tests for system.product.register (RFC-1641) — explicit
registration writes the roster + local map (AC-2, AC-8), --discover sibling
scan semantics (AC-3), refusal cases write nothing (AC-4).</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1641: system.product.register — roster write surface with --discover sibling scan</item>
  <item>RFC-1641: step 1 — system.product.register handler + tests</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

import { runSystemProductRegister } from "../handlers/system-product-register.ts";
import type { ForgeFlagValue } from "../../../src/types.ts";
import { gitExec, initRepo } from "../../flow/tests/helpers.ts";
import { localMapFor, makeContext, VALID_EDGES_YAML, VALID_SYSTEM_YAML } from "./helpers.ts";

// Discover scans dirname(root), so the hub must sit inside a controlled
// parent — never directly under os.tmpdir() where concurrent fixtures
// would read as candidate siblings.
let parent: string;
let hub: string;

const PRODUCTS_YAML = `schema: forge/system-products@1
products:
  - id: alpha
    remote: https://example.invalid/alpha.git
    offers:
      - alpha-contract
ignored:
  - id: ignored-one
    note: deliberate non-product
`;

const MEMBER_FORGE_YAML = `schema: forge/workspace@1
profile: typescript
forge:
  syncedVersion: "9.7.0"
`;

async function writeHub(files: Record<string, string> = {}): Promise<void> {
  const all: Record<string, string> = {
    "forge.yaml": `schema: forge/workspace@1\nprofile: system\nforge:\n  syncedVersion: "9.7.0"\n`,
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(hub, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

async function readYaml(rel: string): Promise<Record<string, unknown>> {
  return YAML.parse(await fs.readFile(path.join(hub, rel), "utf8")) as Record<string, unknown>;
}

function productsOf(
  parsed: Record<string, unknown>,
): { id: string; remote?: string; offers?: string[]; frozen?: boolean }[] {
  return (parsed["products"] as { id: string }[] | undefined) ?? [];
}

function foldersOf(parsed: Record<string, unknown>): Record<string, string> {
  return (parsed["folders"] as Record<string, string> | undefined) ?? {};
}

function ctx(flags: Record<string, ForgeFlagValue>) {
  return { input: { argv: [], flags }, context: makeContext(hub) };
}

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "sys-register-parent-"));
  hub = path.join(parent, "warpgogol-verbund");
  await fs.mkdir(hub, { recursive: true });
  await writeHub();
});

afterEach(async () => {
  await fs.rm(parent, { recursive: true, force: true });
});

describe("system.product.register — explicit (RFC-1641 AC-2, AC-8)", () => {
  test("appends products.yaml and maps the folder in products.local.yaml", async () => {
    const gammaDir = path.join(parent, "gamma");
    await fs.mkdir(gammaDir, { recursive: true });
    const { input, context } = ctx({
      id: "gamma",
      remote: "https://example.invalid/gamma.git",
      folder: "../gamma",
      offers: ["gamma-contract", "gamma-events"],
      frozen: true,
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    const products = productsOf(await readYaml("system/products.yaml"));
    const gamma = products.find((p) => p.id === "gamma");
    expect(gamma?.remote).toBe("https://example.invalid/gamma.git");
    expect(gamma?.offers).toEqual(["gamma-contract", "gamma-events"]);
    expect(gamma?.frozen).toBe(true);
    const local = await readYaml("system/products.local.yaml");
    expect(local["schema"]).toBe("forge/system-products-local@1");
    expect(foldersOf(local)["gamma"]).toBe("../gamma");
    expect(result.data?.written).toContain("system/products.yaml");
    expect(result.data?.written).toContain("system/products.local.yaml");
  });

  test("an identical re-run is a skip, not a write", async () => {
    await fs.mkdir(path.join(parent, "gamma"), { recursive: true });
    const flags = { id: "gamma", remote: "https://example.invalid/gamma.git", folder: "../gamma" };
    await runSystemProductRegister(ctx(flags).input, ctx(flags).context);
    const second = await runSystemProductRegister(ctx(flags).input, ctx(flags).context);
    expect(second.exitCode).toBe(0);
    expect(second.data?.registered).toEqual([]);
    expect(second.data?.skipped).toEqual([{ name: "gamma", reason: "already-registered" }]);
    expect(second.data?.written).toEqual([]);
  });

  test("--update mutates offers and remote on an existing id", async () => {
    const { input, context } = ctx({
      id: "alpha",
      update: true,
      remote: "https://example.invalid/alpha-v2.git",
      offers: ["alpha-contract", "alpha-v2"],
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    const alpha = productsOf(await readYaml("system/products.yaml")).find((p) => p.id === "alpha");
    expect(alpha?.remote).toBe("https://example.invalid/alpha-v2.git");
    expect(alpha?.offers).toEqual(["alpha-contract", "alpha-v2"]);
  });

  test("products.local.yaml keeps an existing launcher on write", async () => {
    await writeHub({
      "system/products.local.yaml": `schema: forge/system-products-local@1\nfolders:\n  alpha: /x/alpha\nlauncher:\n  argv: ["run", "agent"]\n`,
    });
    const { input, context } = ctx({
      id: "gamma",
      remote: "https://example.invalid/gamma.git",
      folder: "../gamma",
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    const local = await readYaml("system/products.local.yaml");
    expect(local["launcher"]).toEqual({ argv: ["run", "agent"] });
    expect(foldersOf(local)["gamma"]).toBe("../gamma");
    expect(foldersOf(local)["alpha"]).toBe("/x/alpha");
  });
});

describe("system.product.register — refusals (RFC-1641 AC-4)", () => {
  test("non-kebab id refuses SYSTEM-PRODUCTS-03 and writes nothing", async () => {
    const { input, context } = ctx({ id: "Not_Kebab", remote: "https://x.invalid/y.git" });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-PRODUCTS-03");
    expect(productsOf(await readYaml("system/products.yaml")).map((p) => p.id)).toEqual(["alpha"]);
  });

  test("duplicate id without --update refuses", async () => {
    const { input, context } = ctx({ id: "alpha", remote: "https://other.invalid/a.git" });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-PRODUCTS-03");
  });

  test("new product without --remote refuses", async () => {
    const { input, context } = ctx({ id: "gamma" });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-PRODUCTS-03");
  });

  test("a folder already mapped to another product refuses", async () => {
    await writeHub({ "system/products.local.yaml": localMapFor({ alpha: "../shared" }) });
    const { input, context } = ctx({
      id: "gamma",
      remote: "https://x.invalid/g.git",
      folder: "../shared",
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-PRODUCTS-03");
    expect(foldersOf(await readYaml("system/products.local.yaml"))["gamma"]).toBeUndefined();
  });

  test("missing --id and --discover refuses", async () => {
    const result = await runSystemProductRegister({ argv: [], flags: {} }, makeContext(hub));
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-PRODUCTS-03");
  });

  test("a missing --folder on disk warns SYSTEM-PRODUCTS-04 but still writes", async () => {
    const { input, context } = ctx({
      id: "gamma",
      remote: "https://x.invalid/g.git",
      folder: "../absent",
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.warnings.some((d) => d.ruleId === "SYSTEM-PRODUCTS-04")).toBe(true);
    expect(foldersOf(await readYaml("system/products.local.yaml"))["gamma"]).toBe("../absent");
  });

  test("--dry-run resolves the result and writes nothing", async () => {
    const { input, context } = ctx({
      id: "gamma",
      remote: "https://x.invalid/g.git",
      "dry-run": true,
    });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.written).toContain("system/products.yaml");
    expect(
      await fs.stat(path.join(hub, "system/products.local.yaml")).catch(() => null),
    ).toBeNull();
    expect(productsOf(await readYaml("system/products.yaml")).map((p) => p.id)).toEqual(["alpha"]);
  });
});

describe("system.product.register — discover (RFC-1641 AC-3)", () => {
  test("registers forge siblings with remotes; skips ignored, hidden, @-dirs, non-forge and remoteless candidates", async () => {
    // gamma — a real git checkout with forge.yaml and an origin remote.
    const gammaDir = path.join(parent, "gamma");
    const seeded = await initRepo({ prefix: "sys-gamma-", branch: "develop" });
    await fs.rename(seeded, gammaDir);
    await fs.writeFile(path.join(gammaDir, "forge.yaml"), MEMBER_FORGE_YAML);
    await gitExec(gammaDir, ["remote", "add", "origin", "https://example.invalid/gamma.git"]);
    // remoteless — forge.yaml, git, but no origin.
    const remotelessDir = path.join(parent, "remoteless");
    const seeded2 = await initRepo({ prefix: "sys-remoteless-", branch: "develop" });
    await fs.rename(seeded2, remotelessDir);
    await fs.writeFile(path.join(remotelessDir, "forge.yaml"), MEMBER_FORGE_YAML);
    // ignored-one — named in ignored[].
    await fs.mkdir(path.join(parent, "ignored-one"), { recursive: true });
    await fs.writeFile(path.join(parent, "ignored-one", "forge.yaml"), MEMBER_FORGE_YAML);
    // hidden, @-worktree, plain non-forge dirs — never candidates.
    await fs.mkdir(path.join(parent, ".cache"), { recursive: true });
    await fs.writeFile(path.join(parent, ".cache", "forge.yaml"), MEMBER_FORGE_YAML);
    await fs.mkdir(path.join(parent, "delta@auto-x"), { recursive: true });
    await fs.writeFile(path.join(parent, "delta@auto-x", "forge.yaml"), MEMBER_FORGE_YAML);
    await fs.mkdir(path.join(parent, "plain-docs"), { recursive: true });
    // alpha — dir on disk, already registered: skip reason already-registered.
    const alphaDir = path.join(parent, "alpha");
    const seeded3 = await initRepo({ prefix: "sys-alpha-", branch: "develop" });
    await fs.rename(seeded3, alphaDir);
    await fs.writeFile(path.join(alphaDir, "forge.yaml"), MEMBER_FORGE_YAML);

    const { input, context } = ctx({ discover: true });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.mode).toBe("discover");

    const registeredIds = result.data?.registered.map((r) => r.id) ?? [];
    expect(registeredIds).toEqual(["gamma"]);
    const products = productsOf(await readYaml("system/products.yaml"));
    expect(products.map((p) => p.id)).toEqual(["alpha", "gamma"]);
    expect(products.find((p) => p.id === "gamma")?.remote).toBe(
      "https://example.invalid/gamma.git",
    );
    expect(foldersOf(await readYaml("system/products.local.yaml"))["gamma"]).toBe("../gamma");

    const skip = Object.fromEntries((result.data?.skipped ?? []).map((s) => [s.name, s.reason]));
    expect(skip["ignored-one"]).toBe("ignored[]");
    expect(skip["remoteless"]).toContain("no origin remote");
    expect(skip["alpha"]).toBe("already-registered");
    expect(skip[".cache"]).toBeUndefined();
    expect(skip["delta@auto-x"]).toBeUndefined();
    expect(skip["plain-docs"]).toBeUndefined();
    expect(skip["warpgogol-verbund"]).toBeUndefined();
  });

  test("a non-kebab sibling name warns and skips", async () => {
    await fs.mkdir(path.join(parent, "Not_Kebab"), { recursive: true });
    await fs.writeFile(path.join(parent, "Not_Kebab", "forge.yaml"), MEMBER_FORGE_YAML);
    const { input, context } = ctx({ discover: true });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.warnings.some((d) => d.ruleId === "SYSTEM-PRODUCTS-04")).toBe(true);
    expect(result.data?.skipped.find((s) => s.name === "Not_Kebab")?.reason).toContain("kebab");
  });
});

describe("system.product.register — SYSTEM-01 gate", () => {
  test("refuses outside the system profile", async () => {
    await fs.writeFile(path.join(hub, "forge.yaml"), `profile: typescript\n`);
    const { input, context } = ctx({ id: "gamma", remote: "https://x.invalid/g.git" });
    const result = await runSystemProductRegister(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors[0]?.ruleId).toBe("SYSTEM-01");
  });
});
