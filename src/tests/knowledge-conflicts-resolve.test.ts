/*
<MODULE_CONTRACT>
<purpose>knowledge-conflicts-resolve tests for planKnowledgeConflictResolution: identity deduplication, safe reference remapping, deterministic local-ID allocation.</purpose>
<non-goals>
  <item>Not a contract source of truth — RFC-1481 and the knowledge resolver own the behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: test first — pin knowledge collision remediation outcomes before implementation.</item>
  <item>RFC-1481: add knowledge collision resolution and surfacing

Add the explicit resolver, namespace-aware parsing and validation, safe reference remapping, doctor/upgrade hints, and regression coverage.</item>
  <item>RFC-1481: enforce resolver IO and path boundaries

Use WorkspaceIO for pack discovery, reject escaping knowledge paths, remap cross-file provenance, and declare the mutating command's empty generation set.</item>
  <item>RFC-1481: honor kernel dry-run and expose resolver reachability

Recognize the kernel dry-run context, declare coverage and dynamic pack reads, and assert local authoring guidance plus zero-write preview behavior.</item>
  <item>RFC-1481: collapse compass summaries and add missing contract blocks</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allocateLocalKnowledgeId,
  planKnowledgeConflictResolution,
  planKnowledgeSync,
} from "../knowledge/sync.ts";
import { parseKnowledgeContent } from "../knowledge/parse.ts";
import { runKnowledgeConflictsResolve } from "../../os/knowledge/handlers/knowledge-conflicts-resolve.ts";
import { forgeKnowledgeModule } from "../../os/knowledge/knowledge.module.ts";
import { FORGE_SKILLS } from "../registry.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let workspaceRoot: string;
let forgeRoot: string;
let sourcePath: string;
let destinationPath: string;

function entry(
  id: string,
  title: string,
  body: string,
  options: { status?: string; supersedes?: string[] } = {},
): string {
  const supersedes =
    options.supersedes === undefined ? "" : `supersedes: [${options.supersedes.join(", ")}]\n`;
  return `### ${id}: ${title}

\`\`\`knowledge-entry
id: ${id}
layer: L0
created: 2026-08-03
${supersedes}status: ${options.status ?? "active"}
\`\`\`

${body}
`;
}

function knowledgeFile(entries: string[]): string {
  return `<!-- knowledge-layer: L0 -->

# Q&A Log (L0)

${entries.join("\n")}`;
}

function l2KnowledgeFile(entries: string[]): string {
  return `<!-- knowledge-layer: L2 -->

# Learned Principles (L2)

${entries.join("\n")}`;
}

function plan(
  source: string,
  destination: string,
  externalReferences?: { ids: ReadonlyMap<string, string>; ambiguous: ReadonlySet<string> },
) {
  return planKnowledgeConflictResolution(
    parseKnowledgeContent(source, "source/qa-log.md"),
    parseKnowledgeContent(destination, "fo-idea/qa-log.md"),
    externalReferences,
  );
}

describe("knowledge conflict resolution planning (RFC-1481)", () => {
  test("adopts the upstream collision and keeps the divergent local entry under a free local ID", () => {
    const source = knowledgeFile([entry("K-0007", "Upstream title", "Canonical body.")]);
    const destination = knowledgeFile([
      entry("K-0007", "Local title", "Local body."),
      entry("L-K-0001", "Earlier local", "Already namespaced."),
    ]);

    const result = plan(source, destination);

    expect(result.resolution.renumbered).toEqual([{ from: "K-0007", to: "L-K-0002" }]);
    expect(result.resolution.adopted).toEqual(["K-0007"]);
    expect(result.content).toContain("### L-K-0002: Local title");
    expect(result.content).toContain("### L-K-0001: Earlier local");
    expect(result.content).toContain("### K-0007: Upstream title");
    expect(result.unresolved).toEqual([]);
  });

  test("deduplicates equal title and body and remaps same-file supersedes references", () => {
    const source = knowledgeFile([entry("K-0007", "Canonical", "Same body.")]);
    const destination = knowledgeFile([
      entry("K-0010", "Canonical", "Same body.", { status: "stale" }),
      entry("K-0011", "Depends on duplicate", "Follow-up.", { supersedes: ["K-0010"] }),
    ]);

    const result = plan(source, destination);

    expect(result.resolution.deduped).toEqual([{ localId: "K-0010", canonicalId: "K-0007" }]);
    expect(result.content).not.toContain("### K-0010:");
    expect(result.content).toContain("supersedes: [K-0007]");
    expect(result.content).toContain("### K-0007: Canonical");
  });

  test("uses upstream metadata when same-ID title and body match", () => {
    const source = knowledgeFile([entry("K-0007", "Same", "Same body.", { status: "active" })]);
    const destination = knowledgeFile([
      entry("K-0007", "Same", "Same body.", { status: "stale" }),
    ]);

    const result = plan(source, destination);

    expect(result.resolution.adopted).toEqual(["K-0007"]);
    expect(result.resolution.renumbered).toEqual([]);
    expect(result.content).toContain("status: active");
    expect(result.content).not.toContain("status: stale");
  });

  test("leaves ambiguous identity matches untouched instead of choosing an upstream entry", () => {
    const source = knowledgeFile([
      entry("K-0007", "Same", "Same body."),
      entry("K-0008", "Same", "Same body."),
    ]);
    const destination = knowledgeFile([entry("K-0010", "Same", "Same body.")]);

    const result = plan(source, destination);

    expect(result.content).toBeNull();
    expect(result.unresolved).toEqual([
      { file: "fo-idea/qa-log.md", reason: "ambiguous-identity" },
    ]);
  });

  test("remaps unambiguous cross-file promotion references", () => {
    const source = knowledgeFile([entry("K-0001", "New upstream", "New body.")]);
    const destination = knowledgeFile([
      entry("L-K-0002", "Promoted pointer", "Pointer.", {
        supersedes: [],
      }).replace(
        "status: active",
        "promotedTo: shared/K-0007\npromotedFrom: [fo-session-save/K-0008]\nstatus: active",
      ),
    ]);
    const references = {
      ids: new Map([
        ["shared/K-0007", "shared/L-K-0001"],
        ["fo-session-save/K-0008", "fo-session-save/L-K-0003"],
      ]),
      ambiguous: new Set<string>(),
    };

    const result = plan(source, destination, references);

    expect(result.content).toContain("promotedTo: shared/L-K-0001");
    expect(result.content).toContain("promotedFrom: [fo-session-save/L-K-0003]");
  });

  test("does not rewrite an ambiguous cross-file promotion reference", () => {
    const source = knowledgeFile([entry("K-0001", "New upstream", "New body.")]);
    const destination = knowledgeFile([
      entry("L-K-0002", "Promoted pointer", "Pointer.").replace(
        "status: active",
        "promotedFrom: [fo-session-save/K-0008]\nstatus: active",
      ),
    ]);

    const result = plan(source, destination, {
      ids: new Map(),
      ambiguous: new Set(["fo-session-save/K-0008"]),
    });

    expect(result.content).toBeNull();
    expect(result.unresolved).toEqual([
      { file: "fo-idea/qa-log.md", reason: "unmapped-reference" },
    ]);
  });

  test("rejects malformed cumulative files without proposing a rewrite", () => {
    const source = knowledgeFile([entry("K-0007", "Upstream", "Canonical.")]);
    const destination = knowledgeFile([
      `### K-0010: Broken\n\n\`\`\`knowledge-entry\nid: K-0010\nlayer: L0\ncreated: nope\nstatus: active\n\`\`\`\n\nLocal.`,
    ]);

    const result = plan(source, destination);

    expect(result.content).toBeNull();
    expect(result.unresolved).toEqual([
      { file: "fo-idea/qa-log.md", reason: "parse-failure" },
    ]);
  });

  test("does not rewrite knowledge-adjacent files", () => {
    const result = planKnowledgeConflictResolution(
      parseKnowledgeContent("# source note\n", "source/forge-about.md"),
      parseKnowledgeContent("# local note\n", "fo-idea/forge-about.md"),
    );

    expect(result.content).toBeNull();
    expect(result.unresolved).toEqual([
      { file: "fo-idea/forge-about.md", reason: "non-cumulative" },
    ]);
  });
});

describe("local knowledge ID allocation", () => {
  test("allocates after the greatest local ordinal without reusing a local ID", () => {
    expect(allocateLocalKnowledgeId(["K-0099", "L-K-0002", "L-K-0008"])).toBe("L-K-0009");
    expect(allocateLocalKnowledgeId(["K-0099"])).toBe("L-K-0001");
  });
});

function l2Entry(id: string, body: string): string {
  return `### ${id}: Same title

\`\`\`knowledge-entry
id: ${id}
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
\`\`\`

${body}
`;
}

function commandContext(dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    forgeRoot,
    io: ambientIo,
    logger: { section() {}, success() {}, warn() {}, error() {}, info() {} },
    outputFormat: "json",
    dryRun,
  } as unknown as ForgeRuntimeContext;
}

function commandInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as ForgeCommandInput;
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "knowledge-conflicts-resolve-"));
  forgeRoot = join(workspaceRoot, "packages", "forge");
  const skill = FORGE_SKILLS.find((candidate) => candidate.name === "fo-session-save");
  if (!skill?.knowledge?.includes("learned-principles.md")) {
    throw new Error("Fixture requires fo-session-save to declare learned-principles.md.");
  }

  const skillSourceDir = dirname(join(forgeRoot, skill.path));
  sourcePath = join(skillSourceDir, "learned-principles.md");
  destinationPath = join(workspaceRoot, ".agents", "skills", skill.name, "learned-principles.md");
  await mkdir(skillSourceDir, { recursive: true });
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(join(forgeRoot, "package.json"), '{"name":"@warpgogol/forge","version":"9.0.0"}');
  await writeFile(
    join(forgeRoot, skill.path),
    "---\nname: fo-session-save\nknowledge: [learned-principles.md]\n---\n# fo-session-save\n",
  );
  await writeFile(
    join(workspaceRoot, "forge.yaml"),
    `schema: "forge/config@1"
project:
  name: test-project
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
  sessionsDir: docs/sessions
`,
  );
  await writeFile(sourcePath, l2KnowledgeFile([l2Entry("K-0007", "Upstream canonical.")]));
  await writeFile(destinationPath, l2KnowledgeFile([l2Entry("K-0007", "Local divergent body.")]));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("knowledge.conflicts.resolve command", () => {
  test("consumer-authing guidance teaches the local namespace", async () => {
    const forgePackageRoot = join(import.meta.dirname, "../..");
    const docs = [
      "skills/fo/fo-session-save/SKILL.md",
      "skills/shared/grilling/SKILL.md",
      "skills/fo/fo-memory-sync/SKILL.md",
      "skills/fo/fo-knowledge-distill/SKILL.md",
      "skills/shared/writing-great-skills/SKILL.md",
    ];
    const contents = await Promise.all(
      docs.map((relative) => readFile(join(forgePackageRoot, relative), "utf8")),
    );

    expect(contents.every((content) => content.includes("L-K-NNNN"))).toBe(true);
  });

  test("is registered in the standalone Forge knowledge module", () => {
    expect(
      forgeKnowledgeModule.commands.some((command) => command.name === "knowledge.conflicts.resolve"),
    ).toBe(true);
  });

  test("dry-run shows the complete resolution without changing consumer knowledge", async () => {
    const before = await readFile(destinationPath, "utf8");

    const result = await runKnowledgeConflictsResolve(
      commandInput(),
      commandContext(true),
    );

    expect(result.data?.status).toBe("pass");
    expect(result.data?.resolved[0]?.renumbered).toEqual([
      { from: "K-0007", to: "L-K-0001" },
    ]);
    expect(result.data?.resolved[0]?.adopted).toEqual(["K-0007"]);
    expect(await readFile(destinationPath, "utf8")).toBe(before);
    expect(existsSync(join(workspaceRoot, ".forge"))).toBe(false);
  });

  test("programmatic dry-run flag also suppresses every write", async () => {
    const before = await readFile(destinationPath, "utf8");
    const result = await runKnowledgeConflictsResolve(
      commandInput({ "dry-run": true }),
      commandContext(),
    );

    expect(result.data?.dryRun).toBe(true);
    expect(await readFile(destinationPath, "utf8")).toBe(before);
    expect(existsSync(join(workspaceRoot, ".forge"))).toBe(false);
  });

  test("resolves the collision, clears the sync conflict, and is idempotent", async () => {
    const first = await runKnowledgeConflictsResolve(commandInput(), commandContext());
    const resolvedContent = await readFile(destinationPath, "utf8");
    const second = await runKnowledgeConflictsResolve(commandInput(), commandContext());

    expect(first.data?.status).toBe("pass");
    expect(planKnowledgeSync(sourcePath, destinationPath).conflicts).toEqual([]);
    expect(resolvedContent).toContain("### L-K-0001: Same title");
    expect(resolvedContent).toContain("### K-0007: Same title");
    expect(second.data?.resolved).toEqual([]);
    expect(await readFile(destinationPath, "utf8")).toBe(resolvedContent);
  });

  test("concurrent invocations cannot allocate duplicate IDs or overwrite resolved knowledge", async () => {
    const results = await Promise.all([
      runKnowledgeConflictsResolve(commandInput(), commandContext()),
      runKnowledgeConflictsResolve(commandInput(), commandContext()),
    ]);
    const content = await readFile(destinationPath, "utf8");
    const ids = [...content.matchAll(/^id: (L-K-\d{4})$/gm)].map((match) => match[1]);

    expect(results.some((result) => result.data?.status === "pass")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(planKnowledgeSync(sourcePath, destinationPath).conflicts).toEqual([]);
  });

  test("rejects pack knowledge paths that escape their declared workspace roots", async () => {
    const packDir = join(workspaceRoot, "skills", "wg");
    const maliciousSkillDir = join(packDir, "wg-malicious");
    const outsideFile = join(workspaceRoot, "outside.md");
    const before = await readFile(destinationPath, "utf8");
    await mkdir(maliciousSkillDir, { recursive: true });
    await writeFile(join(packDir, "forge.plugin.yaml"), "id: wg\nversion: 1.0.0\n");
    await writeFile(
      join(maliciousSkillDir, "SKILL.md"),
      `---
name: wg-malicious
description: test
concerns: read-only
knowledge: ["../../../../outside.md"]
---
`,
    );
    await writeFile(outsideFile, "must remain untouched\n");
    await writeFile(
      join(workspaceRoot, "forge.yaml"),
      `schema: "forge/config@1"
project:
  name: test-project
  stack: []
  packageManager: pnpm
paths:
  skillsDir: .agents/skills
skillPacks:
  - prefix: wg
    dir: skills/wg
`,
    );

    const result = await runKnowledgeConflictsResolve(commandInput(), commandContext());

    expect(result.data?.status).toBe("fail");
    expect(result.summary).toContain("escapes its declared root");
    expect(await readFile(destinationPath, "utf8")).toBe(before);
    expect(await readFile(outsideFile, "utf8")).toBe("must remain untouched\n");
  });
});
