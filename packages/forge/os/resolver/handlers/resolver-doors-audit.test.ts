/*
<MODULE_CONTRACT>
<purpose>RFC-1465 resolver.doors.audit tests — AC-2 (DOOR-02 declared door missing the import), AC-3 (DOOR-01 undeclared door), AC-4 (DOOR-03 missing canonical/export), green-path convergence.</purpose>
<non-goals>
  <item>Not a contract source of truth — fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runResolverDoorsAudit } from "./resolver-doors-audit.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

async function seed(opts: {
  canonicalBody?: string;
  doorImports?: string;
  undeclaredImports?: string;
  extraDoor?: string;
}) {
  const canon = "packages/a/canonical.ts";
  const door = "packages/a/door.ts";
  const undeclared = "packages/a/rogue.ts";
  const doors = [canon, door, ...(opts.extraDoor ? [opts.extraDoor] : [])];
  const yaml = `schema: forge/config@1
resolverDoors:
  demo:
    canonical: ${canon}#loadDemos
    domains:
      - docs/demos
    doors:
${doors.map((d) => `      - ${d}`).join("\n")}
`;
  await writeFile(join(root, "forge.yaml"), yaml);
  await mkdir(join(root, "packages", "a"), { recursive: true });
  await writeFile(
    join(root, canon),
    opts.canonicalBody ?? "export async function loadDemos(dir: string): Promise<string[]> { return []; }\n",
  );
  await writeFile(join(root, door), opts.doorImports ?? `import { loadDemos } from "./canonical.ts";\n`);
  if (opts.undeclaredImports !== undefined) {
    await writeFile(join(root, undeclared), opts.undeclaredImports);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "resolver-doors-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolver.doors.audit (RFC-1465)", () => {
  test("green path: declared door importing canonical → no diagnostics", async () => {
    await seed({ doorImports: `import { loadDemos } from "./canonical.ts";\n` });
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(res.data?.diagnostics).toEqual([]);
  });

  test("AC-2: declared door not binding the canonical symbol → DOOR-02", async () => {
    await seed({ doorImports: `import { other } from "./other.ts";\n` });
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "DOOR-02")).toBe(true);
  });

  test("AC-3: undeclared module binding the canonical symbol → DOOR-01", async () => {
    await seed({
      undeclaredImports: `import { loadDemos } from "./canonical.ts";\n`,
    });
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    const hits = res.data!.diagnostics.filter(
      (d) => d.ruleId === "DOOR-01" && d.file === "packages/a/rogue.ts",
    );
    expect(hits.length).toBe(1);
  });

  test("AC-3: importing ANY export from the canonical module is a door (module-level semantics)", async () => {
    await seed({ canonicalBody: "export function loadDemos(){}\nexport const OTHER = 1;\n" });
    await writeFile(
      join(root, "packages", "a", "rogue.ts"),
      `import { OTHER } from "./canonical.ts";\n`,
    );
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(
      res.data?.diagnostics.some((d) => d.ruleId === "DOOR-01" && d.file === "packages/a/rogue.ts"),
    ).toBe(true);
  });

  test("mid-statement dynamic import of the canonical module → DOOR-01", async () => {
    await seed({});
    await writeFile(
      join(root, "packages", "a", "rogue.ts"),
      `const mod = await import("./canonical.ts");
`,
    );
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(
      res.data?.diagnostics.some((d) => d.ruleId === "DOOR-01" && d.file === "packages/a/rogue.ts"),
    ).toBe(true);
  });

  test("AC-3: globbing a domain dir without declaration → DOOR-01", async () => {
    await seed({});
    await writeFile(
      join(root, "packages", "a", "rogue.ts"),
      `import { readdir } from "node:fs/promises";\nconst files = await readdir("docs/demos");\n`,
    );
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "DOOR-01")).toBe(true);
  });

  test("AC-4: missing canonical path → DOOR-03", async () => {
    await seed({ canonicalBody: "" });
    await rm(join(root, "packages", "a", "canonical.ts"), { force: true });
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "DOOR-03")).toBe(true);
  });

  test("AC-4: canonical exists but exports nothing → DOOR-03", async () => {
    await seed({ canonicalBody: "const internal = 1;\n" });
    const res = await runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "DOOR-03")).toBe(true);
  });

  test("malformed registry entry throws", async () => {
    await writeFile(
      join(root, "forge.yaml"),
      `schema: forge/config@1\nresolverDoors:\n  bad:\n    canonical: 5\n`,
    );
    await expect(
      runResolverDoorsAudit({ argv: [], flags: {} } as never, ctx()),
    ).rejects.toThrow(/canonical/);
  });
});
