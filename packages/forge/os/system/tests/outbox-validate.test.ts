/*
<MODULE_CONTRACT>
<purpose>Tests for outbox.validate (RFC-1510): absent docs/outbox passes
(AC-1), schema violations OUTBOX-01 (AC-2), filename-stem binding OUTBOX-02
(AC-3) and profile-agnostic behavior — never SYSTEM-01 (AC-4).</purpose>
<non-goals><item>System-side scan coverage lives in system-outbox-scan.test.ts.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1510: step 1 — outbox.validate tests</item>
  <item>RFC-1510: implement RFC-1510 — product outbox for dependency-contract requests</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runOutboxValidate } from "../handlers/outbox-validate.ts";
import { makeContext, makeSystemRepo } from "./helpers.ts";

function input() {
  return { argv: [], flags: {} };
}

const VALID_ENTRY = `schema: forge/outbox@1
id: OB-0001
contract: alpha-contract
need: "a stable consumer surface"
why: "our product composes it"
state: open
`;

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-outbox-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe("outbox.validate", () => {
  it("AC-1: a repository without docs/outbox/ exits 0", async () => {
    const root = await makeRepo({ "forge.yaml": "profile: typescript\n" });
    const result = await runOutboxValidate(input(), makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.checked).toBe(0);
  });

  it("AC-2: an entry failing forge/outbox@1 refuses OUTBOX-01", async () => {
    const root = await makeRepo({
      "forge.yaml": "profile: typescript\n",
      "docs/outbox/OB-0001.yaml": VALID_ENTRY.replace("state: open", "state: bogus"),
    });
    const result = await runOutboxValidate(input(), makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "OUTBOX-01")).toBe(true);
  });

  it("AC-3: an entry whose id differs from the filename stem refuses OUTBOX-02", async () => {
    const root = await makeRepo({
      "forge.yaml": "profile: typescript\n",
      "docs/outbox/OB-0002.yaml": VALID_ENTRY, // declares id OB-0001
    });
    const result = await runOutboxValidate(input(), makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "OUTBOX-02")).toBe(true);
  });

  it("AC-4: a non-system profile never reports SYSTEM-01", async () => {
    const root = await makeRepo({
      "forge.yaml": "profile: typescript\n",
      "docs/outbox/OB-0001.yaml": VALID_ENTRY,
    });
    const result = await runOutboxValidate(input(), makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-01")).toBe(false);
  });

  it("a valid entry passes inside a system repository too", async () => {
    const root = await makeSystemRepo({
      "docs/outbox/OB-0001.yaml": VALID_ENTRY,
    });
    const result = await runOutboxValidate(input(), makeContext(root));
    expect(result.exitCode).toBe(0);
    expect(result.data?.checked).toBe(1);
  });
});
