/*
<MODULE_CONTRACT>
<purpose>RFC-1330: verification-origin tests — derive probe origins over a real temporary git repository so range anchoring, rename-free file history, and trailer recognition are exercised end to end.</purpose>
<non-goals>
  <item>Do not touch the workspace repository — every test builds its own repo under the OS temp dir.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1330: initial tests for AC-1, AC-2, AC-3, AC-8, AC-13, AC-14, AC-15.</item>
  <item>RFC-1330: steps 1-2 — origin contracts and git-derived probe origin derivation

Range base = status: accepted transition, head = HEAD; declaration, test, and run rules; verifier-trailer recognition; presence classification.</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import {
  createOriginGit,
  deriveProbeOrigins,
  isPresenceProbe,
  resolveImplementationRange,
} from "./verification-origin.ts";
import type { AcceptanceProbe } from "./types.ts";

const RFC_PATH = "docs/rfcs/rfc-9001-fixture.md";
const TEST_PATH = "src/foo.test.ts";

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

function rfcSource(
  status: string,
  acceptance: AcceptanceProbe[],
  commands: Record<string, string[]> = {},
): string {
  const fm = yamlStringify({
    id: "RFC-9001",
    title: "Fixture",
    status,
    createdAt: "2026-10-18",
    commands: { proposed: [], added: [], changed: [], removed: [], ...commands },
    acceptance,
  });
  return `---\n${fm}---\n\n# RFC-9001\n`;
}

async function commit(message: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) await write(rel, content);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
}

const testProbe: AcceptanceProbe = {
  probe: "test",
  criterion: "AC-1",
  file: TEST_PATH,
  expect: { exitCode: 0 },
  expectationSource: "requirement",
};

const VERIFIER_BODY =
  "\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/reviews/acceptance/rfc-9001/acceptance-2026-10-18-r0.md";

async function derive(probes: AcceptanceProbe[], commands: Record<string, string[]> = {}) {
  const gitPort = createOriginGit(root);
  const fm = { commands: { proposed: [], added: [], changed: [], ...commands } };
  return deriveProbeOrigins({ git: gitPort, rfcRelPath: RFC_PATH, frontmatter: fm, probes });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-origin-"));
  git("init", "-q");
  await commit("draft", {
    [RFC_PATH]: rfcSource("draft", [testProbe]),
    [TEST_PATH]: "it('x', () => {});\n",
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("deriveProbeOrigins (RFC-1330)", () => {
  it("classes a test probe self when its file changed in the implementation range", async () => {
    await commit("accept", { [RFC_PATH]: rfcSource("accepted", [testProbe]) });
    const sha = await commit("unrelated subject", { [TEST_PATH]: "it('y', () => {});\n" });
    const [record] = await derive([testProbe]);
    expect(record?.derivedOrigin).toBe("self");
    expect(record?.effective).toBe("self");
    expect(record?.reason.join(" ")).toContain(sha.slice(0, 7));
  });

  it("classes a probe self when its declaration changed in the implementation range", async () => {
    await commit("accept", { [RFC_PATH]: rfcSource("accepted", [testProbe]) });
    const loosened: AcceptanceProbe = { ...testProbe, testName: "renamed" } as AcceptanceProbe;
    await commit("edit probe", { [RFC_PATH]: rfcSource("accepted", [loosened]) });
    const [record] = await derive([loosened]);
    expect(record?.derivedOrigin).toBe("self");
  });

  it("classes a run probe self when its command is listed in the RFC commands block", async () => {
    const runProbe: AcceptanceProbe = {
      probe: "run",
      criterion: "AC-2",
      command: "werkstatt run demo.validate --json",
      expect: { exitCode: 0 },
    };
    await commit("accept", {
      [RFC_PATH]: rfcSource("accepted", [runProbe], { changed: ["demo.validate"] }),
    });
    const [record] = await derive([runProbe], { changed: ["demo.validate"] });
    expect(record?.derivedOrigin).toBe("self");
  });

  it("keeps the declared origin for a test file touched only by sanctioned verifier commits", async () => {
    await commit("accept", { [RFC_PATH]: rfcSource("accepted", [testProbe]) });
    await commit(`test: verifier check${VERIFIER_BODY}`, { [TEST_PATH]: "it('v', () => {});\n" });
    const [record] = await derive([testProbe]);
    expect(record?.derivedOrigin).toBe("verifier");
    expect(record?.effective).toBe("independent");
    expect(record?.reason[0]).toContain("docs/reviews/acceptance/rfc-9001");
  });

  it("includes commits after the implementation commit up to HEAD in the range", async () => {
    await commit("accept", { [RFC_PATH]: rfcSource("accepted", [testProbe]) });
    await commit("implement: RFC-9001 step 1", { "src/foo.ts": "export const a = 1;\n" });
    const later = await commit("fix: review finding", { [TEST_PATH]: "it('z', () => {});\n" });
    const [record] = await derive([testProbe]);
    expect(record?.derivedOrigin).toBe("self");
    expect(record?.reason.join(" ")).toContain(later.slice(0, 7));
  });

  it("anchors the range base at the accepted transition of the RFC file", async () => {
    // Maturation edits the probe declaration and the test file before acceptance.
    const edited: AcceptanceProbe = { ...testProbe, testName: "maturation" } as AcceptanceProbe;
    await commit("enhance", {
      [RFC_PATH]: rfcSource("draft", [edited]),
      [TEST_PATH]: "it('pre', () => {});\n",
    });
    const accept = await commit("accept", { [RFC_PATH]: rfcSource("accepted", [edited]) });
    await commit("implement: later stamp-like edit", {
      [RFC_PATH]: rfcSource("implemented", [edited]),
    });
    const range = await resolveImplementationRange(createOriginGit(root), RFC_PATH);
    expect(range.base).toBe(accept);
    const [record] = await derive([edited]);
    expect(record?.derivedOrigin).not.toBe("self");
    expect(record?.derivedOrigin).toBe("unchanged");
  });

  it("exempts declarations introduced by a verifier-trailer commit from the declaration rule", async () => {
    await commit("accept", { [RFC_PATH]: rfcSource("accepted", [testProbe]) });
    const verifierProbe: AcceptanceProbe = {
      probe: "test",
      criterion: "AC-1",
      file: "src/verify.test.ts",
      expect: { exitCode: 0 },
      expectationSource: "independent",
    };
    await commit(`test: bind verifier check${VERIFIER_BODY}`, {
      [RFC_PATH]: rfcSource("accepted", [testProbe, verifierProbe]),
      "src/verify.test.ts": "it('cx-1', () => {});\n",
    });
    const records = await derive([testProbe, verifierProbe]);
    expect(records[1]?.derivedOrigin).toBe("verifier");
    expect(records[0]?.derivedOrigin).toBe("unchanged");
  });

  it("reports unresolved when the RFC was never accepted", async () => {
    const [record] = await derive([testProbe]);
    expect(record?.derivedOrigin).toBe("unresolved");
    expect(record?.effective).toBe("self");
  });

  it("classes structural probes as presence", () => {
    expect(isPresenceProbe({ probe: "file-exists", path: "a.ts" })).toBe(true);
    expect(isPresenceProbe({ probe: "file-contains", path: "src/a.ts", pattern: "x" })).toBe(true);
    expect(isPresenceProbe({ probe: "file-contains", path: "AGENTS.md", pattern: "x" })).toBe(
      false,
    );
  });
});
