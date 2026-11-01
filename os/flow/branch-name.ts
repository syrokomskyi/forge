/*
<MODULE_CONTRACT>
<purpose>Fixed branch-model grammar (RFC-1486) — the single normative
implementation of `auto/<kind>-<YYMMDD>-<NN>-<slug>` plus the protected names
`develop`/`main`. The POSIX guard asset carries the same grammar text and the
parity test proves both executions agree.</purpose>
<non-goals>
  <item>No git operations — this file is pure string/date logic.</item>
  <item>No sequence-number assignment — NN allocation is RFC-1487.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>YYMMDD is validated as a real UTC calendar date (leap years included) — a regex alone cannot express that, so the pattern check is followed by a Date round-trip.</item>
  <item>Slug length 3–48 is enforced outside the pattern so the regex literal stays byte-identical between TypeScript and the shell guard.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 1 — fixed branch-model grammar, marker detection contracts, git helpers</item>
  <item>RFC-1486: step 1 — branch grammar, marker detection, git helpers</item>
</CHANGE_SUMMARY>
*/

export type FlowBranchKind = "task" | "session" | "fix";

export const PROTECTED_BRANCHES = ["develop", "main"] as const;
export type ProtectedBranch = (typeof PROTECTED_BRANCHES)[number];

/**
 * The normative grammar — the SAME literal text appears in
 * `os/flow/assets/flow-guard.sh` (grep -E compatible: no non-capturing
 * groups). flow-guard-parity.test.ts pins the byte equality. Kind and NN are
 * further constrained in code (kind ∈ {task,session,fix} is expressed by the
 * alternation; NN 01–99, slug length 3–48 and the calendar date cannot be
 * expressed in the regex and are checked by parseFlowBranch — the shell guard
 * mirrors the same checks).
 */
export const FLOW_BRANCH_PATTERN =
  "^auto/(task|session|fix)-[0-9]{6}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$";

const FLOW_BRANCH_RE = new RegExp(FLOW_BRANCH_PATTERN);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 48;

export interface ParsedFlowBranch {
  /** Full ref short name, e.g. "auto/session-261101-01-forge-flow". */
  name: string;
  kind: FlowBranchKind;
  /** "YYMMDD" — UTC calendar date of branch creation. */
  date: string;
  /** 1..99 — unique per repository per day (assigned by RFC-1487). */
  seq: number;
  slug: string;
}

export type BranchClass =
  | { kind: "protected"; name: ProtectedBranch }
  | { kind: "flow"; branch: ParsedFlowBranch }
  | { kind: "nonconforming"; name: string; reason: string };

/** YYMMDD must be a real UTC calendar date — rejects 261332, 260230, 260229. */
export function isValidFlowDate(yymmdd: string): boolean {
  if (!/^[0-9]{6}$/.test(yymmdd)) return false;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  return (
    date.getUTCFullYear() === 2000 + yy &&
    date.getUTCMonth() === mm - 1 &&
    date.getUTCDate() === dd
  );
}

/**
 * Parse a branch name against the FI-1 grammar. Returns null for protected
 * names and every non-conforming name — callers use classifyBranch for the
 * three-way verdict.
 */
export function parseFlowBranch(name: string): ParsedFlowBranch | null {
  const match = FLOW_BRANCH_RE.exec(name);
  if (!match) return null;
  const kind = match[1] as FlowBranchKind;
  // Layout is fixed by the pattern: auto/<kind>-<YYMMDD>-<NN>-<slug>.
  const tail = name.slice("auto/".length + kind.length + 1);
  const date = tail.slice(0, 6);
  const seqText = tail.slice(7, 9);
  const slug = tail.slice(10);
  const seq = Number(seqText);
  if (!Number.isInteger(seq) || seq < 1 || seq > 99) return null;
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) return null;
  if (!SLUG_RE.test(slug)) return null;
  if (!isValidFlowDate(date)) return null;
  return { name, kind, date, seq, slug };
}

export function classifyBranch(name: string): BranchClass {
  if ((PROTECTED_BRANCHES as readonly string[]).includes(name)) {
    return { kind: "protected", name: name as ProtectedBranch };
  }
  const branch = parseFlowBranch(name);
  if (branch) return { kind: "flow", branch };
  return {
    kind: "nonconforming",
    name,
    reason:
      "outside the fixed branch model grammar auto/<kind>-<YYMMDD>-<NN>-<slug> (RFC-1486)",
  };
}

/**
 * Format a conforming branch name. `date` is rendered in UTC — a caller-local
 * timezone must never leak into the name (FI-6).
 */
export function formatFlowBranch(input: {
  kind: FlowBranchKind;
  date: Date;
  seq: number;
  slug: string;
}): string {
  if (!Number.isInteger(input.seq) || input.seq < 1 || input.seq > 99) {
    throw new Error(`formatFlowBranch: seq must be an integer in 1..99, got ${input.seq}`);
  }
  if (
    input.slug.length < SLUG_MIN_LENGTH ||
    input.slug.length > SLUG_MAX_LENGTH ||
    !SLUG_RE.test(input.slug)
  ) {
    throw new Error(
      `formatFlowBranch: slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be ${SLUG_MIN_LENGTH}..${SLUG_MAX_LENGTH} chars, got "${input.slug}"`,
    );
  }
  const yy = String(input.date.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(input.date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(input.date.getUTCDate()).padStart(2, "0");
  const nn = String(input.seq).padStart(2, "0");
  return `auto/${input.kind}-${yy}${mm}${dd}-${nn}-${input.slug}`;
}
