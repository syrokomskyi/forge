/*
<MODULE_CONTRACT>
<purpose>
  RFC-1253 AC-8: compass.docs.validate scans docs/*.xml ∪ bindings.paths.compassDocs
  (deduped), applies COMPASS-DOC-04 schema-marker warnings to corpus documents only
  (canonical basenames ∪ bound paths), and leaves generated non-corpus XML untouched.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompassDocsValidate } from "../../os/compass/handlers/compass-docs-validate.ts";
import { forgeYaml } from "../../os/compass/handlers/tests/forge-yaml-fixture.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

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

const MARKED_DOC = `<requirements>
  <meta>
    <document>Requirements</document>
    <status>draft</status>
    <schema>forge/compass-docs@1</schema>
  </meta>
  <body><path>\`docs/other.xml\`</path></body>
</requirements>
`;

const UNMARKED_DOC = `<requirements>
  <meta>
    <document>Requirements</document>
    <status>active</status>
  </meta>
  <body><path>\`docs/other.xml\`</path></body>
</requirements>
`;

const WRONG_SCHEMA_DOC = `<requirements>
  <meta>
    <document>Requirements</document>
    <status>active</status>
    <schema>someone/else@9</schema>
  </meta>
  <body><path>\`docs/other.xml\`</path></body>
</requirements>
`;

const GENERATED_INVENTORY = `<inventory>
  <meta><generated>true</generated></meta>
  <files><file>src/x.ts</file></files>
</inventory>
`;

describe("compass.docs.validate — RFC-1253 scan union + COMPASS-DOC-04", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-docs-scope-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "other.xml"), "<root />");
    await writeFile(
      join(root, "forge.yaml"),
      forgeYaml("").replace(
        "  paths: {}",
        "  paths:\n    compassDocs:\n      - docs/requirements.xml",
      ),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("warns on a corpus doc missing the schema marker (COMPASS-DOC-04, warning not error)", async () => {
    await writeFile(join(root, "docs", "requirements.xml"), UNMARKED_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const doc04 = result.data?.diagnostics.filter((d) => d.ruleId === "COMPASS-DOC-04");
    expect(doc04).toHaveLength(1);
    expect(doc04?.[0]?.severity).toBe("warning");
    expect(doc04?.[0]?.file).toBe("docs/requirements.xml");
    expect(result.exitCode).toBe(0); // warnings never flip the verdict
    expect(result.data?.status).toBe("pass");
  });

  it("warns on a corpus doc declaring a foreign schema id", async () => {
    await writeFile(join(root, "docs", "requirements.xml"), WRONG_SCHEMA_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const doc04 = result.data?.diagnostics.filter((d) => d.ruleId === "COMPASS-DOC-04");
    expect(doc04).toHaveLength(1);
    expect(doc04?.[0]?.message).toContain("someone/else@9");
  });

  it("does not fire on a marked corpus doc or on generated non-corpus XML", async () => {
    await writeFile(join(root, "docs", "requirements.xml"), MARKED_DOC);
    await writeFile(join(root, "docs", "compass-inventory.xml"), GENERATED_INVENTORY);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const doc04 = result.data?.diagnostics.filter((d) => d.ruleId === "COMPASS-DOC-04");
    expect(doc04).toHaveLength(0);
  });

  it("scans a bound corpus doc outside docs/ and warns when unmarked", async () => {
    await writeFile(
      join(root, "forge.yaml"),
      forgeYaml("").replace(
        "  paths: {}",
        "  paths:\n    compassDocs:\n      - docs/requirements.xml\n      - corpus/extra-plan.xml",
      ),
    );
    await mkdir(join(root, "corpus"), { recursive: true });
    await writeFile(join(root, "corpus", "extra-plan.xml"), UNMARKED_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const doc04 = result.data?.diagnostics.filter((d) => d.ruleId === "COMPASS-DOC-04");
    expect(doc04?.map((d) => d.file).sort()).toEqual(["corpus/extra-plan.xml"]);
    // docs/other.xml (glob) + corpus/extra-plan.xml (bound); bound-but-missing docs/requirements.xml skipped
    expect(result.data?.scanned.xmlFiles).toBe(2);
  });

  it("skips missing bound paths silently (doctor owns missing-path diagnostics)", async () => {
    await writeFile(
      join(root, "forge.yaml"),
      forgeYaml("").replace(
        "  paths: {}",
        "  paths:\n    compassDocs:\n      - docs/requirements.xml\n      - docs/missing-doc.xml",
      ),
    );
    await writeFile(join(root, "docs", "requirements.xml"), MARKED_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics.filter((d) => d.file === "docs/missing-doc.xml")).toHaveLength(
      0,
    );
  });

  it("applies canonical-basename corpus scope even without a binding entry", async () => {
    await writeFile(join(root, "forge.yaml"), forgeYaml(""));
    await writeFile(join(root, "docs", "requirements.xml"), UNMARKED_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    const doc04 = result.data?.diagnostics.filter((d) => d.ruleId === "COMPASS-DOC-04");
    expect(doc04).toHaveLength(1);
  });

  it("degrades to glob-only when forge.yaml is absent", async () => {
    await rm(join(root, "forge.yaml"));
    await writeFile(join(root, "docs", "requirements.xml"), MARKED_DOC);
    const result = await runCompassDocsValidate(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.scanned.xmlFiles).toBe(2);
  });
});
