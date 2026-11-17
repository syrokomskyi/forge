/*
<MODULE_CONTRACT>
<purpose>RFC-1616 (O-3, AC-7/AC-8): the trust-boundary scaffold — the workflow
invokes correctness.gate --policy-only, pinned.validate --mode ci and
policy.digest --verify; CODEOWNERS covers forge.yaml, .forge/, hooks/ and
.github/workflows/ under project.owner (or the documented @OWNER placeholder);
writes are absent-only — operator-tuned files are never overwritten.</purpose>
<non-goals><item>No GitHub-side enforcement — branch protection is documented, not flipped.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial suite.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: keep an unconfigured scaffold owner from rewriting real CODEOWNERS ownership</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseForgeConfigDocument } from "../config/forge-config.ts";
import { codeownersTemplate, scaffoldTrustBoundary } from "./trust-boundary.ts";

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "forge-tb-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("trust-boundary scaffold (RFC-1616)", () => {
  it("AC-7: the workflow runs the three policy-surface commands", () => {
    const r = root();
    scaffoldTrustBoundary(r, "@octo");
    const wf = readFileSync(path.join(r, ".github/workflows/forge-policy.yml"), "utf8");
    expect(wf).toContain("correctness.gate --policy-only");
    expect(wf).toContain("pinned.validate --mode ci");
    expect(wf).toContain("policy.digest --verify");
  });

  it("AC-8: CODEOWNERS covers the policy-surface paths under project.owner", () => {
    const co = codeownersTemplate("@octocat");
    for (const p of ["forge.yaml", ".forge/", "hooks/", ".github/workflows/"]) {
      expect(co).toContain(p);
    }
    expect(co).toContain("@octocat");
  });

  it("an absent owner keeps the documented @OWNER placeholder", () => {
    const co = codeownersTemplate(undefined);
    expect(co).toContain("@OWNER");
    expect(co).toContain("project.owner");
  });

  it("write-when-absent: files adopted for the configured owner are never overwritten", () => {
    const r = root();
    writeFileSync(path.join(r, "dummy"), "");
    const first = scaffoldTrustBoundary(r, "@a");
    expect(first.created.sort()).toEqual(
      [".github/CODEOWNERS", ".github/workflows/forge-policy.yml"].sort(),
    );
    const second = scaffoldTrustBoundary(r, "@a");
    expect(second.created).toEqual([]);
    expect(second.replaced).toEqual([]);
    expect(second.skipped.join(" ")).toContain("already exists");
  });

  it("CX-56: a CODEOWNERS tuned to a different anchor gains the boundary block, keeping its lines", () => {
    const r = root();
    mkdirSync(path.join(r, ".github"), { recursive: true });
    const tuned = "# operator tuned CODEOWNERS\nforge.yaml @team\n.github/CODEOWNERS @team\n";
    writeFileSync(path.join(r, ".github/CODEOWNERS"), tuned);
    const result = scaffoldTrustBoundary(r, "@b");
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([".github/CODEOWNERS"]);
    const body = readFileSync(path.join(r, ".github/CODEOWNERS"), "utf8");
    expect(body).toContain("forge.yaml @team");
    expect(body).toMatch(/forge\.yaml\s+@b\b/);
  });

  it("an unconfigured owner keeps an operator-owned CODEOWNERS verbatim", () => {
    const r = root();
    mkdirSync(path.join(r, ".github"), { recursive: true });
    const body = [
      "forge.yaml              @syrokomskyi",
      ".forge/                 @syrokomskyi",
      "hooks/                  @syrokomskyi",
      ".github/workflows/     @syrokomskyi",
      ".github/CODEOWNERS     @syrokomskyi",
      "",
    ].join("\n");
    writeFileSync(path.join(r, ".github/CODEOWNERS"), body);
    const result = scaffoldTrustBoundary(r, undefined);
    // Any effective coverage counts under the @OWNER placeholder — a
    // placeholder write can never claim the boundary and must never
    // downgrade a real owner's file.
    expect(result.replaced).toEqual([]);
    expect(result.skipped.join(" ")).toContain(".github/CODEOWNERS");
    expect(readFileSync(path.join(r, ".github/CODEOWNERS"), "utf8")).toBe(body);
  });

  it("CX-56: session-owned anchors never count as operator-adopted", () => {
    const r = root();
    mkdirSync(path.join(r, ".github"), { recursive: true });
    writeFileSync(
      path.join(r, ".github/CODEOWNERS"),
      "forge.yaml @session-agent\n.github/CODEOWNERS @session-agent\n",
    );
    const result = scaffoldTrustBoundary(r, "@operator");
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([".github/CODEOWNERS"]);
  });

  it("CX-56: suffix-spoofed and doc-named lines own nothing", () => {
    const r = root();
    mkdirSync(path.join(r, ".github"), { recursive: true });
    writeFileSync(
      path.join(r, ".github/CODEOWNERS"),
      "forge.yaml.bak @x\n.github/CODEOWNERS.bak @x\ndocs/forge.yaml-owners.md @x\n.github/CODEOWNERS.md @x\n",
    );
    const result = scaffoldTrustBoundary(r, "@operator");
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([".github/CODEOWNERS"]);
  });

  it("CX-57: a dispatch-only echo workflow is not the enforcement artifact", () => {
    const r = root();
    mkdirSync(path.join(r, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(r, ".github/workflows/forge-policy.yml"),
      `name: forge-policy
on: [workflow_dispatch]
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo "correctness.gate policy.digest pinned.validate"
`,
    );
    const result = scaffoldTrustBoundary(r, "@operator");
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([".github/workflows/forge-policy.yml"]);
    // the foreign file is preserved before the template lands
    expect(readFileSync(path.join(r, ".github/workflows/forge-policy.yml.pre-scaffold"), "utf8")).toContain(
      "workflow_dispatch",
    );
  });

  it("CX-28: an inert pre-planted file is rewritten, keeping its lines verbatim", () => {
    const r = root();
    const inert = path.join(r, ".github", "CODEOWNERS");
    mkdirSync(path.dirname(inert), { recursive: true });
    writeFileSync(inert, "# agent's own file\ndocs/ @agent\n");
    const result = scaffoldTrustBoundary(r, "@a");
    expect(result.created).toContain(".github/CODEOWNERS");
    expect(result.replaced).toEqual([".github/CODEOWNERS"]);
    const body = readFileSync(inert, "utf8");
    expect(body).toContain("forge.yaml");
    expect(body).toContain("docs/ @agent");
  });

  it("config schema accepts project.owner and push.requireVerifierReview", () => {
    const cfg = parseForgeConfigDocument(
      "schema: forge/config@1\nproject:\n  name: x\n  owner: \"@octo\"\npaths: {}\npush:\n  requireVerifierReview: false\n",
      "forge.yaml",
    );
    expect(cfg.project.owner).toBe("@octo");
    expect(cfg.push?.requireVerifierReview).toBe(false);
  });
});
