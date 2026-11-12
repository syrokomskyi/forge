/*
<MODULE_CONTRACT>
<purpose>RFC-1579 CORR-AUDIT-04 `bindings.verify.substance` — the verify
slot must prove more than tests or types. Error when
`bindings.commands.verify` is null, equals the `test` or `typecheck`
binding, or consists only of `test`, `typecheck`, `build:check`, `tsc`, or
`vitest` invocations. A configuration auditor: never differential, blocking
whenever present. `correctness.mode: exempt` skips it.</purpose>
<non-goals>
  <item>Do not run the verify command — the audit is static.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: close review REVIEW-CODE-2026-11-13-01 findings

F1 INSERT 'has no column named' is a finding; F2 severity/kind escalation since base is introduced; F3 unparseable machine tables are errors; F4 comma joins, string literals and comments in table extraction; F5 only migration INSERT/REPLACE seed writes; F6 SET-clause-only coverage; F7 method-call writers; F8 regex literals in the scanner; F9 alias resolution; F10 EC-34 judges the payload only; F11 EC-34 before the scoped gates with a dry-run line; F12/F13 config and YAML errors named; F14 config-only check skips snapshots; F15 git grep failures fail closed; F16 portable prefilter; F17 shell no-ops; F18 shared D1 schemas; in-code DDL scoped per package; ledger tests. DEV-1..DEV-4 recorded in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { parse as parseYaml } from "yaml";

import type { AuditorOutput } from "./types.ts";

const TRIVIAL = new Set(["test", "typecheck", "build:check", "tsc", "vitest"]);
const NO_OPS = new Set([
  "echo",
  "true",
  "cd",
  ":",
  "tee",
  "printf",
  "exit",
  "set",
  "export",
  "sleep",
]);
const RUNNERS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "turbo",
  "exec",
  "run",
  "dlx",
]);
/** Runner flags that take a value (`--filter <pkg>`, `-F <pkg>`, `-C <dir>`). */
const VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--workspace", "--cwd"]);

function normalize(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

/** The script or binary a single shell segment invokes, after runner words and flags. */
export function invokedTarget(segment: string): string | null {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) {
      i += 1; // env assignment
      continue;
    }
    if (RUNNERS.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) {
      i += VALUE_FLAGS.has(t) && !t.includes("=") ? 2 : 1;
      continue;
    }
    return t;
  }
  return null;
}

/** True when every segment of the command only runs tests or type checks. */
export function isTrivialVerify(cmd: string): boolean {
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return true;
  // Shell no-ops and builtins add no substance (`pnpm test && echo ok`).
  return segments.every((seg) => {
    const target = invokedTarget(seg);
    return target === null || TRIVIAL.has(target) || NO_OPS.has(target);
  });
}

export function auditVerifySubstance(
  forgeYaml: string | undefined,
  exempt: boolean,
): AuditorOutput {
  if (exempt)
    return { findings: [], unverifiable: 0, skipped: ["bindings.verify.substance: exempt"] };
  let commands: Record<string, unknown> = {};
  try {
    const doc = (forgeYaml ? parseYaml(forgeYaml) : {}) as {
      bindings?: { commands?: Record<string, unknown> };
    };
    commands = doc?.bindings?.commands ?? {};
  } catch (err) {
    return {
      findings: [
        {
          check: "bindings.verify.substance",
          subject: "bindings.commands.verify",
          severity: "error",
          message: `forge.yaml is not valid YAML (${(err as Error).message.split("\n")[0]}) — the verify binding cannot be judged`,
          location: { file: "forge.yaml", line: 1 },
        },
      ],
      unverifiable: 0,
      skipped: [],
    };
  }
  const verify =
    typeof commands["verify"] === "string" ? normalize(commands["verify"] as string) : null;
  const test = typeof commands["test"] === "string" ? normalize(commands["test"] as string) : null;
  const typecheck =
    typeof commands["typecheck"] === "string" ? normalize(commands["typecheck"] as string) : null;
  let reason: string | null = null;
  if (!verify) reason = "bindings.commands.verify is null — the verify slot proves nothing";
  else if (verify === test)
    reason = `bindings.commands.verify equals bindings.commands.test ("${verify}")`;
  else if (verify === typecheck)
    reason = `bindings.commands.verify equals bindings.commands.typecheck ("${verify}")`;
  else if (isTrivialVerify(verify)) {
    reason = `bindings.commands.verify ("${verify}") only runs test/typecheck/build:check/tsc/vitest`;
  }
  if (!reason) return { findings: [], unverifiable: 0, skipped: [] };
  return {
    findings: [
      {
        check: "bindings.verify.substance",
        subject: "bindings.commands.verify",
        severity: "error",
        message: `${reason} — bind a command that checks domain behaviour on a real substrate`,
        location: { file: "forge.yaml", line: 1 },
      },
    ],
    unverifiable: 0,
    skipped: [],
  };
}
