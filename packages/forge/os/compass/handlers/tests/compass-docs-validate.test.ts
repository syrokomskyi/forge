/*
<MODULE_CONTRACT>
  <purpose>
    RFC-1242 AC-1..AC-4: compass.docs.validate scans the docs/*.xml corpus and
    must fail on unresolvable <path> entries (COMPASS-DOC-01) and dead workspace
    ids (COMPASS-DOC-02), warn on unresolvable link targets (COMPASS-DOC-03),
    and flag malformed XML (COMPASS-DOC-00). A green corpus exits 0 with
    status-shaped data.
  </purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompassDocsValidate } from "../compass-docs-validate.ts";
import { ambientIo } from "../../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeRuntimeContext,
} from "../../../../src/types.ts";

const logger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
  getEvents() {
    return [];
  },
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    logger: logger as never,
    dryRun: false,
    outputFormat: "json",
    io: ambientIo,
    actualState: undefined as never,
    fileIntents: [],
  } as unknown as ForgeRuntimeContext;
}

function makeInput(): ForgeCommandInput {
  return { argv: [], flags: {} } as unknown as ForgeCommandInput;
}

const GREEN_DOC = `<root>
  <path>\`docs/other.xml\`</path>
  <workspace id="pkg-foo"><path>\`packages/foo\`</path></workspace>
  <node id="packages.foo" type="package"><path>\`packages/foo\`</path></node>
  <node id="root.a" type="compass-doc"><link rel="binds-to" target="root.b" /></node>
  <node id="root.b" type="compass-doc" />
</root>
`;

describe("compass.docs.validate — RFC-1242", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-docs-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "packages", "foo"), { recursive: true });
    await writeFile(join(root, "packages", "foo", "index.ts"), "export {};\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-2: green corpus exits 0 and reports scanned counts", async () => {
    await writeFile(join(root, "docs", "a.xml"), GREEN_DOC, "utf8");
    await writeFile(join(root, "docs", "other.xml"), "<root/>", "utf8");
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      scanned: { xmlFiles: number; pathsChecked: number; idsChecked: number };
      diagnostics: Diagnostic[];
    };
    expect(data.scanned.xmlFiles).toBe(2);
    expect(data.diagnostics).toEqual([]);
  });

  it("AC-3: dead <path> emits COMPASS-DOC-01 error", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><path>\`packages/gone\`</path></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Diagnostic[] }).diagnostics;
    expect(
      diagnostics.some((d) => d.ruleId === "COMPASS-DOC-01" && d.severity === "error"),
      "dead <path> must emit COMPASS-DOC-01 — check pathTokens/pathCheckTarget resolution",
    ).toBe(true);
  });

  it("AC-4: dead <path> produces a non-zero exit", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><path>\`packages/gone\`</path></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(1);
  });

  it("dead workspace id emits COMPASS-DOC-02 error", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><workspace id="pkg-gone"/></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Diagnostic[] }).diagnostics;
    expect(
      diagnostics.some((d) => d.ruleId === "COMPASS-DOC-02" && d.message.includes("pkg-gone")),
      "dead workspace id must emit COMPASS-DOC-02 — check workspaceIdTarget mapping",
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("glob-tail <path> resolves against the parent directory", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><path>\`packages/*\`</path></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
  });

  it("unresolvable link target emits COMPASS-DOC-03 warning, never an error", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><node id="x"><link rel="binds-to" target="docs.rfcs.rfc-9999" /></node></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Diagnostic[] }).diagnostics;
    expect(
      diagnostics.some((d) => d.ruleId === "COMPASS-DOC-03" && d.severity === "warning"),
      "dangling link target must warn via COMPASS-DOC-03",
    ).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("link target resolving to an archived RFC file passes", async () => {
    await mkdir(join(root, "docs", "rfcs", "archive"), { recursive: true });
    await writeFile(join(root, "docs", "rfcs", "archive", "rfc-0097-old.md"), "x", "utf8");
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><node id="x"><link rel="binds-to" target="docs.rfcs.rfc-0097" /></node></root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
  });

  it("malformed XML emits COMPASS-DOC-00 and skips ref checks for that file", async () => {
    await writeFile(
      join(root, "docs", "a.xml"),
      `<root><name>oops</root>`,
      "utf8",
    );
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const diagnostics = (result.data as { diagnostics: Diagnostic[] }).diagnostics;
    expect(diagnostics.some((d) => d.ruleId === "COMPASS-DOC-00")).toBe(true);
    expect(diagnostics.some((d) => d.ruleId === "COMPASS-DOC-01")).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("AC-1: result data carries command-shaped payload fields", async () => {
    await writeFile(join(root, "docs", "a.xml"), GREEN_DOC, "utf8");
    await writeFile(join(root, "docs", "other.xml"), "<root/>", "utf8");
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty("scanned");
    expect(data).toHaveProperty("diagnostics");
    expect(Array.isArray(data.diagnostics)).toBe(true);
  });
});
