/*
<MODULE_CONTRACT>
<purpose>RFC-1579: survival ledger merge — legacy/accepted code findings
survive with their first-seen stamp kept, vanished rows turn resolved,
introduced and configuration findings never enter the ledger.</purpose>
<non-goals>
  <item>Not a contract source of truth — ledger.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial suite.</item>
  <item>RFC-1579: close review REVIEW-CODE-2026-11-13-01 findings

F1 INSERT 'has no column named' is a finding; F2 severity/kind escalation since base is introduced; F3 unparseable machine tables are errors; F4 comma joins, string literals and comments in table extraction; F5 only migration INSERT/REPLACE seed writes; F6 SET-clause-only coverage; F7 method-call writers; F8 regex literals in the scanner; F9 alias resolution; F10 EC-34 judges the payload only; F11 EC-34 before the scoped gates with a dry-run line; F12/F13 config and YAML errors named; F14 config-only check skips snapshots; F15 git grep failures fail closed; F16 portable prefilter; F17 shell no-ops; F18 shared D1 schemas; in-code DDL scoped per package; ledger tests. DEV-1..DEV-4 recorded in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

import { mergeLedger, parseLedger, serializeLedger } from "./ledger.ts";
import type { AuditFinding } from "./types.ts";

const finding = (
  subject: string,
  attribution: AuditFinding["attribution"],
  check: AuditFinding["check"] = "ledger.orphans",
): AuditFinding => ({
  rule: "CORR-AUDIT-02",
  check,
  key: `k-${subject}`,
  subject,
  occurrences: 1,
  severity: "warning",
  attribution,
  message: "untouched",
});

describe("survival ledger", () => {
  it("keeps firstSeen, refreshes lastSeen, resolves vanished rows, skips introduced/config findings", () => {
    const first = mergeLedger(
      parseLedger(null),
      [finding("events", "legacy"), finding("old", "accepted")],
      { sha: "a1", date: "2026-11-01" },
    );
    expect(first.rows.map((r) => r.subject)).toEqual(["events", "old"]);
    const second = mergeLedger(
      parseLedger(serializeLedger(first)),
      [
        finding("events", "legacy"),
        finding("new", "introduced"),
        finding("bindings.commands.verify", "legacy", "bindings.verify.substance"),
      ],
      { sha: "b2", date: "2026-11-13" },
    );
    const by = new Map(second.rows.map((r) => [r.subject, r]));
    expect(by.get("events")).toMatchObject({
      status: "surviving",
      firstSeen: { sha: "a1" },
      lastSeen: { sha: "b2" },
    });
    expect(by.get("old")).toMatchObject({ status: "resolved", lastSeen: { sha: "a1" } });
    expect(by.has("new")).toBe(false);
    expect(by.has("bindings.commands.verify")).toBe(false);
  });
});
