/*
<MODULE_CONTRACT>
<purpose>
Unit tests for skill validate knowledge covering RFC-0660: SKILL-19/SKILL-20 validation.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the skill suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1481: verify consumer-local IDs are accepted only for consumer-authored skill packs.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkill19And20, runSkillValidate } from "../validators/skill-validate.ts";

let fixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs = [];
});

function knowledgeFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-skill-knowledge-"));
  fixtureDirs.push(dir);
  const file = join(dir, "learned-principles.md");
  writeFileSync(file, content, "utf8");
  return file;
}

describe("RFC-0660: SKILL-19/SKILL-20 validation", () => {
  test("SKILL-19: zero violations on real workspace after migration", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill19Violations = result.violations.filter((v) => v.rule === "SKILL-19");
    expect(skill19Violations).toEqual([]);
  });

  test("SKILL-20: zero violations on real workspace after migration", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill20Violations = result.violations.filter((v) => v.rule === "SKILL-20");
    expect(skill20Violations).toEqual([]);
  });

  test("SKILL-19/SKILL-20: knowledge-adjacent files produce no violations", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const knowledgeViolations = result.violations.filter(
      (v) => v.rule === "SKILL-19" || v.rule === "SKILL-20",
    );
    // forge-bootstrap has knowledge-adjacent files (forge-about.md, etc.)
    // These should produce zero SKILL-19/SKILL-20 violations
    expect(knowledgeViolations).toEqual([]);
  });

  test("RFC-1481: consumer skill packs may use L-K IDs and references", () => {
    const file = knowledgeFixture(`<!-- knowledge-layer: L1 -->

### L-K-0002: Local pattern
\`\`\`knowledge-entry
id: L-K-0002
layer: L1
created: 2026-08-03
supersedes: [K-0001]
promotedTo: shared/L-K-0003
promotedFrom: [another-skill/L-K-0002]
status: active
\`\`\`

Local body.

### K-0001: Previous upstream pattern
\`\`\`knowledge-entry
id: K-0001
layer: L1
created: 2026-08-03
status: active
\`\`\`

Previous body.
`);

    const result = checkSkill19And20("consumer-skill", "learned-principles.md", file, "consumer-pack");

    expect(result.errors).toEqual([]);
  });

  test("RFC-1481: Forge-authored source skills reject consumer-local IDs", () => {
    const file = knowledgeFixture(`<!-- knowledge-layer: L0 -->

### L-K-0001: Invalid upstream ID
\`\`\`knowledge-entry
id: L-K-0001
layer: L0
created: 2026-08-03
status: active
\`\`\`

Local namespace must not ship upstream.
`);

    const result = checkSkill19And20("forge-skill", "qa-log.md", file);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("consumer-local");
  });

  test("RFC-1481: Forge-authored source references cannot point into the consumer namespace", () => {
    const file = knowledgeFixture(`<!-- knowledge-layer: L0 -->

### K-0001: Invalid local target
\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
promotedTo: shared/L-K-0003
status: active
\`\`\`

An upstream entry cannot reference a consumer-local shared ID.
`);

    const result = checkSkill19And20("forge-skill", "qa-log.md", file);

    expect(result.errors.some((error) => error.message.includes("consumer-local"))).toBe(true);
  });
});
