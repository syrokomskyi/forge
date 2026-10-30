/*
<MODULE_CONTRACT>
<purpose>
Unit tests for acceptance covering validateAcceptanceShape — RFC-1271 optional probe metadata; V-43 — verificationTier enum validation (RFC-1271).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the acceptance suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
  <item>RFC-1453: executed outcome probes, IMP-14 surface gate, outcome.serve + V-47/V-48</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { runRfcAcceptanceRun, validateAcceptanceShape } from "./acceptance.ts";
import { createOutcomeSession } from "./outcome-probe.ts";
import { validateSingleRfc, type AddViolationFn } from "./handlers/validate-rules.ts";
import type { ParsedRfc } from "./frontmatter-io.ts";
import type { AcceptanceProbe } from "./types.ts";
import type { ForgeRuntimeContext } from "../../src/types.ts";

describe("validateAcceptanceShape — RFC-1271 optional probe metadata", () => {
  const baseProbe = { probe: "file-contains", path: "x.md", pattern: "y" };

  test("accepts all four expectationSource values", () => {
    for (const expectationSource of ["self", "requirement", "independent", "external"]) {
      const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource }]);
      expect(issues, `expectationSource=${expectationSource}`).toEqual([]);
    }
  });

  test("rejects an unknown expectationSource value", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource: "operator" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(0);
    expect(issues[0]!.message).toContain("expectationSource");
  });

  test("rejects a non-string expectationSource", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource: 42 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("expectationSource");
  });

  test("accepts a string limitations field", () => {
    const issues = validateAcceptanceShape([
      { ...baseProbe, limitations: "covers exit code only, not output semantics" },
    ]);
    expect(issues).toEqual([]);
  });

  test("rejects a non-string limitations field", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, limitations: ["a", "b"] }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("limitations");
  });

  test("fields apply to every probe kind, not just the first", () => {
    const issues = validateAcceptanceShape([
      baseProbe,
      { probe: "file-exists", path: "x.md", expectationSource: "bogus" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(1);
  });

  test("absent fields stay valid", () => {
    expect(validateAcceptanceShape([baseProbe])).toEqual([]);
    expect(validateAcceptanceShape(undefined)).toEqual([]);
  });
});

describe("V-43 — verificationTier enum validation (RFC-1271)", () => {
  const makeParsed = (verificationTier?: string): ParsedRfc => ({
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status: "draft",
      kind: "policy",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      ...(verificationTier === undefined ? {} : { verificationTier }),
    },
    body: "# RFC-9999: Test RFC\n",
  });

  const runValidate = async (parsed: ParsedRfc) => {
    const violations: { rule: string }[] = [];
    const add: AddViolationFn = (_id, _file, rule) => void violations.push({ rule });
    await validateSingleRfc(
      "rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      join(tmpdir(), "test-workspace"),
      add,
    );
    return violations;
  };

  test("accepts all three tier values", async () => {
    for (const verificationTier of ["standard", "high", "formal"]) {
      const violations = await runValidate(makeParsed(verificationTier));
      expect(
        violations.filter((v) => v.rule === "V-43"),
        `verificationTier=${verificationTier}`,
      ).toEqual([]);
    }
  });

  test("accepts absent verificationTier", async () => {
    const violations = await runValidate(makeParsed());
    expect(violations.filter((v) => v.rule === "V-43")).toEqual([]);
  });

  test("rejects an unknown tier value", async () => {
    const violations = await runValidate(makeParsed("extreme"));
    expect(violations.some((v) => v.rule === "V-43")).toBe(true);
  });
  test("rejects a reachable probe that declares both or neither of symbol and command", () => {
    const both = validateAcceptanceShape([
      { probe: "reachable", symbol: "a", module: "m.ts", command: "x.y" },
    ]);
    const neither = validateAcceptanceShape([{ probe: "reachable" }]);
    const ok = validateAcceptanceShape([{ probe: "reachable", command: "x.y" }]);
    expect(both).toHaveLength(1);
    expect(neither).toHaveLength(1);
    expect(ok).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RFC-1453: executed page probes (AC-1..AC-4)
// ---------------------------------------------------------------------------

const SERVE_FIXTURE = `import { createServer } from "node:http";
const server = createServer((req, res) => {
  const html = "<html><body><header><a class=\\"lang-switcher__link\\" href=\\"/de\\">DE</a></header><main><p>Hallo</p></main></body></html>";
  res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "text/html" });
  res.end(html);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port, pid: process.pid }) + "\\n");
});
setInterval(() => {}, 60000);
`;

// Noise lines and the handshake JSON are flushed in ONE stdout write — a
// consumer must scan every complete line in the chunk, not just the first.
const SERVE_FIXTURE_NOISY = `import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><header><a class=\\"lang-switcher__link\\" href=\\"/de\\">DE</a></header></body></html>");
});
server.listen(0, "127.0.0.1", () => {
  const handshake = JSON.stringify({ url: "http://127.0.0.1:" + server.address().port, pid: process.pid });
  process.stdout.write("[config] loading kernel.config.ts\\n[registry] loading module rfc\\n== workspace: outcome.serve ==\\n" + handshake + "\\n");
});
setInterval(() => {}, 60000);
`;

const FORGE_YAML = (build: string, serve: string) => `schema: forge/config@1
project:
  name: fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    outcomeBuild: ${build}
    outcomeServe: ${serve}
  paths: {}
`;

const FORGE_YAML_NO_BINDINGS = `schema: forge/config@1
project:
  name: fixture
paths: {}
`;

type PageProbe = Extract<AcceptanceProbe, { probe: "page" }>;

const pageProbe = (over: Record<string, unknown> = {}): PageProbe =>
  ({
    probe: "page",
    target: "fixture",
    path: "/",
    selector: "header .lang-switcher__link",
    criterion: "AC-1",
    ...over,
  }) as PageProbe;

async function makeWorkspace(bindingsYaml: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rfc1453-outcome-"));
  await writeFile(join(dir, "forge.yaml"), bindingsYaml ?? FORGE_YAML_NO_BINDINGS);
  await writeFile(join(dir, "serve-fixture.mjs"), SERVE_FIXTURE);
  return dir;
}

const testContext = (workspaceRoot: string): ForgeRuntimeContext =>
  ({
    workspaceRoot,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    outputFormat: "json",
  }) as unknown as ForgeRuntimeContext;

describe("RFC-1453 outcome session — page probes execute or report unverified", () => {
  test("AC-1: executes against served output — pass when selector matches, fail when it does not", async () => {
    const dir = await makeWorkspace(FORGE_YAML('node -e "process.exit(0)"', "node serve-fixture.mjs"));
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const pass = await session.runPageProbe(pageProbe());
      expect(pass.verdict).toBe("pass");
      expect(pass.ok).toBe(true);

      const fail = await session.runPageProbe(pageProbe({ selector: "header .missing" }));
      expect(fail.verdict).toBe("fail");
      expect(fail.ok).toBe(false);

      const textHit = await session.runPageProbe(pageProbe({ textPattern: "^DE$" }));
      expect(textHit.verdict).toBe("pass");
    } finally {
      await session.dispose();
    }
  }, 60_000);

  test("AC-1: a status mismatch fails; an expected non-200 passes", async () => {
    const dir = await makeWorkspace(FORGE_YAML('node -e "process.exit(0)"', "node serve-fixture.mjs"));
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const mismatch = await session.runPageProbe(pageProbe({ path: "/missing", selector: undefined }));
      expect(mismatch.verdict).toBe("fail");
      const expected = await session.runPageProbe(
        pageProbe({ path: "/missing", selector: undefined, expectStatus: 404 }),
      );
      expect(expected.verdict).toBe("pass");
    } finally {
      await session.dispose();
    }
  }, 60_000);

  test("AC-2: missing bindings → unverified, never ok", async () => {
    const dir = await makeWorkspace(null);
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const res = await session.runPageProbe(pageProbe());
      expect(res.verdict).toBe("unverified");
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("outcomeBuild");
    } finally {
      await session.dispose();
    }
  });

  test("AC-3: outcomeBuild failure → unverified with the build tail", async () => {
    const dir = await makeWorkspace(
      FORGE_YAML('node -e "console.error(\'boom\'); process.exit(1)"', "node serve-fixture.mjs"),
    );
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const res = await session.runPageProbe(pageProbe());
      expect(res.verdict).toBe("unverified");
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("outcomeBuild exited 1");
    } finally {
      await session.dispose();
    }
  });

  test("AC-3: outcomeServe printing no JSON line → unverified", async () => {
    const dir = await makeWorkspace(
      FORGE_YAML('node -e "process.exit(0)"', 'node -e "process.exit(0)"'),
    );
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const res = await session.runPageProbe(pageProbe());
      expect(res.verdict).toBe("unverified");
      expect(res.ok).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  test("AC-1: the handshake resolves when noise lines share its stdout chunk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfc1453-noisy-"));
    await writeFile(join(dir, "forge.yaml"), FORGE_YAML('node -e "process.exit(0)"', "node serve-noisy.mjs"));
    await writeFile(join(dir, "serve-noisy.mjs"), SERVE_FIXTURE_NOISY);
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const res = await session.runPageProbe(pageProbe());
      expect(res.verdict).toBe("pass");
      expect(res.ok).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 60_000);

  test("AC-1: a page probe without target reports unverified (V-47 companion)", async () => {
    const dir = await makeWorkspace(FORGE_YAML('node -e "process.exit(0)"', "node serve-fixture.mjs"));
    const session = createOutcomeSession({ workspaceRoot: dir });
    try {
      const res = await session.runPageProbe(pageProbe({ target: undefined }));
      expect(res.verdict).toBe("unverified");
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("target");
    } finally {
      await session.dispose();
    }
  });
});

describe("RFC-1453 rfc.acceptance.run — RFC-ACC-04 on unverified (AC-4)", () => {
  test("unverified page probes emit an error-severity RFC-ACC-04 diagnostic", async () => {
    const dir = await makeWorkspace(null);
    const rfcDir = join(dir, "docs", "rfcs");
    await mkdir(rfcDir, { recursive: true });
    await writeFile(
      join(rfcDir, "rfc-9000-unverified-page.md"),
      `---
id: RFC-9000
title: Unverified page probe fixture
status: accepted
kind: architecture
scope: workspace
owners: [architecture]
createdAt: 2026-10-30
updatedAt: 2026-10-30
acceptance:
  - probe: page
    criterion: AC-1
    target: fixture
    path: "/"
    selector: "header .lang-switcher__link"
---
# RFC-9000

## Acceptance criteria

- [ ] AC-1: THE page probe SHALL execute.
`,
    );
    const result = await runRfcAcceptanceRun(
      { argv: [], flags: { id: "RFC-9000" } },
      testContext(dir),
    );
    const acc04 = (result.data?.diagnostics ?? []).filter((d) => d.ruleId === "RFC-ACC-04");
    expect(acc04.length).toBe(1);
    expect(acc04[0]!.severity).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.data?.results[0]?.probeResults[0]?.verdict).toBe("unverified");
    expect(result.data?.results[0]?.probeResults[0]?.ok).toBe(false);
  });
});
