/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-6: `bindings.verify.substance` — a null verify binding is
an introduced error even when the base already had it null (configuration
auditor, never differential); test/typecheck duplicates and trivial
invocations are errors; exempt repositories skip.</purpose>
<non-goals>
  <item>Not a contract source of truth — the auditor owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial suite.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { auditVerifySubstance, isTrivialVerify } from "./bindings-verify-substance.ts";
import { runCorrectnessAudit } from "./run.ts";
import { FORGE_YAML, makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

const NULL_VERIFY = FORGE_YAML.replace(
  "verify: pnpm exec tsx scripts/verify-dispatch.ts",
  "verify: null",
);

describe("bindings.verify.substance", () => {
  it("AC-6: verify null at base and now is an introduced error", async () => {
    const f = makeGitFixture({ "forge.yaml": NULL_VERIFY });
    fixtures.push(f);
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    const finding = out.result.findings.find((x) => x.check === "bindings.verify.substance");
    expect(finding, "the configuration auditor blocks from day one").toBeDefined();
    expect(finding!.attribution).toBe("introduced");
    expect(finding!.severity).toBe("error");
    expect(finding!.rule).toBe("CORR-AUDIT-04");
    expect(out.result.status).toBe("fail");
  });

  it("flags a verify equal to test or typecheck and trivial invocations", () => {
    const yaml = (verify: string) =>
      FORGE_YAML.replace("verify: pnpm exec tsx scripts/verify-dispatch.ts", `verify: "${verify}"`);
    expect(auditVerifySubstance(yaml("pnpm test"), false).findings[0]?.message).toMatch(
      /equals bindings.commands.test/,
    );
    expect(auditVerifySubstance(yaml("turbo run build:check"), false).findings).toHaveLength(1);
    expect(
      auditVerifySubstance(yaml("pnpm --filter api run test && pnpm exec tsc --noEmit"), false)
        .findings,
    ).toHaveLength(1);
    expect(isTrivialVerify("pnpm exec vitest run apps/api")).toBe(true);
    expect(isTrivialVerify("pnpm exec vitest run && pnpm run verify:dispatch")).toBe(false);
  });

  it("a substantive verify passes and an exempt repository is skipped", () => {
    expect(auditVerifySubstance(FORGE_YAML, false).findings).toEqual([]);
    const exempt = auditVerifySubstance(NULL_VERIFY, true);
    expect(exempt.findings).toEqual([]);
    expect(exempt.skipped).toEqual(["bindings.verify.substance: exempt"]);
  });
});
