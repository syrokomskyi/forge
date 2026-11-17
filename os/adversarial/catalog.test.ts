/*
<MODULE_CONTRACT>
<purpose>RFC-1616 (AC-2, AC-3): every packaged adversarial scenario loads as a
valid forge/adversarial-scenario@1 and replays to its expected refusal —
CORR-GATE-02/03 for the eleven gate scenarios and FLOW-INT-18 for
downgrade-forge — against a minimal fixture repository.</purpose>
<non-goals>
  <item>Not a consumer-repo clone test — runScenario gets a tiny fixture; the full-repo replay is the shipped command's job.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial suite.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: fail closed on a missing or empty adversarial catalog</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog } from "./catalog.ts";
import { runScenario } from "./runner.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Minimal repo the scenarios clone — the contour arrives via each scenario's setup. */
function fixtureRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "adv-base-"));
  dirs.push(root);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  return root;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** this package's own forge bin — the install under test. */
const FORGE_ARGV = [process.execPath, path.resolve(MODULE_DIR, "../../bin/cli.js")];

describe("adversarial catalog (RFC-1616)", () => {
  it("loads the packaged catalog — 12 valid scenarios", () => {
    const catalog = loadCatalog();
    expect(catalog.length, "the RFC seeds 12 attacks").toBe(12);
    for (const e of catalog) {
      expect(e.error, `scenario ${e.name} must parse`).toBeUndefined();
    }
  });

  it("a missing or empty catalog dir is an error entry, never a vacuous pass (O-11)", () => {
    for (const dir of [
      "/nonexistent-catalog-dir",
      mkdtempSync(path.join(os.tmpdir(), "adv-empty-")),
    ]) {
      dirs.push(dir);
      const catalog = loadCatalog(dir);
      expect(catalog.length).toBe(1);
      expect(catalog[0]!.scenario).toBeUndefined();
      expect(catalog[0]!.error).toBeTruthy();
    }
  });

  const catalog = loadCatalog();
  for (const entry of catalog) {
    it(
      `${entry.name} refuses as expected (${entry.scenario?.expect.rule ?? "invalid"})`,
      { timeout: 180_000 },
      async () => {
        expect(entry.scenario).toBeDefined();
        const root = fixtureRepo();
        const r = await runScenario(entry.scenario!, {
          repoRoot: root,
          forgeArgv: FORGE_ARGV,
        });
        expect(
          r.observed,
          `${entry.name}: expected ${r.expected}, gate observed ${r.observed}`,
        ).toBe(r.expected);
      },
    );
  }
});
