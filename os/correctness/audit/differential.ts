/*
<MODULE_CONTRACT>
<purpose>RFC-1579 differential attribution — findings are keyed by
`sha256(check + "\0" + subject)` with an occurrence count; a code finding is
`introduced` when its key is new or its count grew since the base revision,
`legacy` when present at base with an equal or higher count, `resolved` when
present at base only. Configuration findings (CORR-AUDIT-04) are always
`introduced`. Allow-listed findings (`correctness.audit.allow[]`) are
`accepted`.</purpose>
<non-goals>
  <item>No line-based attribution — subject keys are immune to line shifts.</item>
  <item>No exit-code decisions — run.ts derives status from introduced errors only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial attribution.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

import {
  AUDIT_RULE_OF,
  CODE_CHECKS,
  type AllowEntry,
  type AuditFinding,
  type RawFinding,
} from "./types.ts";

export function findingKey(check: string, subject: string): string {
  return createHash("sha256").update(`${check}\0${subject}`).digest("hex");
}

interface Grouped {
  first: RawFinding;
  count: number;
}

function group(findings: RawFinding[]): Map<string, Grouped> {
  const out = new Map<string, Grouped>();
  for (const f of findings) {
    const key = findingKey(f.check, f.subject);
    const g = out.get(key);
    if (g) g.count += 1;
    else out.set(key, { first: f, count: 1 });
  }
  return out;
}

function toFinding(
  key: string,
  g: Grouped,
  attribution: AuditFinding["attribution"],
): AuditFinding {
  return {
    rule: AUDIT_RULE_OF[g.first.check],
    check: g.first.check,
    key,
    subject: g.first.subject,
    occurrences: g.count,
    severity: g.first.severity,
    attribution,
    ...(g.first.location ? { location: g.first.location } : {}),
    message: g.first.message,
  };
}

/** Attribute `now` findings against `base` findings (code checks) and apply the allow-list. */
export function attribute(
  base: RawFinding[],
  now: RawFinding[],
  allow: AllowEntry[],
): AuditFinding[] {
  const allowed = new Set(allow.map((a) => findingKey(a.check, a.subject)));
  const baseCode = group(base.filter((f) => CODE_CHECKS.has(f.check)));
  const nowGroups = group(now);
  const out: AuditFinding[] = [];
  for (const [key, g] of nowGroups) {
    let attribution: AuditFinding["attribution"];
    if (!CODE_CHECKS.has(g.first.check)) attribution = "introduced";
    else {
      const prior = baseCode.get(key);
      attribution = prior && prior.count >= g.count ? "legacy" : "introduced";
    }
    if (allowed.has(key)) attribution = "accepted";
    out.push(toFinding(key, g, attribution));
  }
  for (const [key, g] of baseCode) {
    if (!nowGroups.has(key)) out.push(toFinding(key, g, "resolved"));
  }
  const order = { introduced: 0, accepted: 1, legacy: 2, resolved: 3 };
  return out.sort(
    (a, b) =>
      order[a.attribution] - order[b.attribution] ||
      a.check.localeCompare(b.check) ||
      a.subject.localeCompare(b.subject),
  );
}

/** Parse `correctness.audit.allow[]` from a forge.yaml document object; malformed rows are dropped. */
export function readAllowList(config: unknown): AllowEntry[] {
  const allow = (config as { correctness?: { audit?: { allow?: unknown } } })?.correctness?.audit
    ?.allow;
  if (!Array.isArray(allow)) return [];
  return allow.filter(
    (a): a is AllowEntry =>
      !!a &&
      typeof (a as AllowEntry).check === "string" &&
      typeof (a as AllowEntry).subject === "string" &&
      typeof (a as AllowEntry).reason === "string" &&
      (a as AllowEntry).reason.trim().length > 0,
  );
}
