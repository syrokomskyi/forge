---
name: fo-reproduce
description: Bounded reproduction phase for claimed defects — produce a verified failing test BEFORE the fix, with an attempt-budgeted loop, a no-source-modification boundary, and an honest inconclusive exit carrying the attempt log.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [commands.verifyReproduction]
triggerPhrases: ["reproduce the bug", "reproduce this defect", "prove it fails first", "reproduction-first", "подтверди дефект тестом", "воспроизведи баг"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-reproduce skill — bounded reproduction phase for claimed defects: produce a verified failing test before the fix, with a named attempt budget, no production-source modification, and honest inconclusive exits.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
  <item>Do not change the three-verdict contract of the reproduction verifier (reproduced / not-reproduced / inconclusive) — this skill earns the verdict, it does not redefine it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1440: initial skill — reproduce claimed defects in a bounded phase before the fix.</item>
  <item>RFC-1440: fo-reproduce skill + pipeline wiring

New fo-reproduce skill (bounded 5-attempt reproduction loop, no-source-
modification boundary, verifier exit, honest inconclusive attempt log);
wired into fo-idea-implement defect path, fo-fix reproduce-first, fo-triage
verify step, fo-add-tests defect branch; AGENTS.md reproduction-first rule;
compass inventory regenerated.</item>
</CHANGE_SUMMARY>
-->

# fo-reproduce

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Produce a **verified failing test** for a claimed defect — before any fix work. Reproduction-first means the failing test drives the fix; a defect test written after the fix is retroactive paperwork and cannot inform it.

## Input

A defect claim: a reference (issue id, review-finding id, failing-log path, RFC id) plus whatever is known of the symptom and the suspected location. Any element may be `unknown`; step 1 narrows the claim before loop budget is spent.

## Early classification

Not every defect is vitest-testable. Before entering the loop, classify:

- **vitest-testable** — the defect lives in logic a test can reach → enter the process below.
- **untestable** (UI timing, deploy topology, content bugs, environment) → exit early; the caller keeps the prose verification path. No loop budget is burned.
- **already fixed** (drift, or the operator fixed it inline) → a `defect` claim can no longer be verified; report it — the reason is reclassified or the test proceeds under another honest reason (`regression <risk>`).

## Process

### 1. Frame the target

Translate the claim into ⟨public surface, failure signature, suspected seam⟩. Extract concrete keywords — symbol names, error text, input shapes — from the claim and the suspected location. Retrieval starts local: the named file, its importers, the nearest existing tests reaching the same seam. Do NOT start with a global traversal — unguided repository-wide search burns the budget without finding the failure (the dominant reproduction failure mode).

### 2. Confirm signatures locally

Read the actual declarations and the nearest existing tests that reach the same seam **before** synthesizing any call. APIs are never invoked from model memory — wrong-version signatures produce tests that fail for the wrong reason and still look like reproductions.

### 3. Bounded reproduction loop

Up to **5 attempts**:

1. Draft a minimal failing test at the public seam — smallest input that exercises the claimed failure signature.
2. Run it.
3. Diagnose the output — did it fail at the claimed signature, at a different assertion, or pass?
4. Revise and repeat.

**The agent MUST NOT modify production source during the reproduction phase.** The moment the loop tempts a source edit, the reproduction phase stops and hands its findings back — drifting into fixing is a named failure mode, not a shortcut.

### 4. Exit through the verifier

Run `ref(forge.yaml bindings.commands.verifyReproduction)` with `{test}` = the candidate test file and `{sha}` = the commit before the fix work began:

- `reproduced` → the test earns `Test-Reason: defect <ref>` + `Repro-Verified: <sha>` in its commit (the RFC-1332 contract, unchanged).
- `not-reproduced` → return to the loop while budget remains.
- `inconclusive` → restructure the test against the old public surface, or exit honestly per step 5.

When the `verifyReproduction` binding is absent (foreign workshop), degrade exactly as RFC-1332 defines: record the observed red run in the commit body and report `Degraded: commands.verifyReproduction`.

### 5. Honest exhaustion

A loop that exhausts its budget exits `inconclusive` and reports the **attempt log**: what was tried in each attempt and where it failed. The defect claim is never committed under a `defect` reason without a `reproduced` verdict (or the degraded-mode red-run record) — and the failure is never silent. The fix may still proceed best-effort; the commit then MUST NOT carry `Repro-Verified:`.

## Quality bar (inherited from fo-add-tests)

- **Public seam only.** No private/internal API manipulation unless the defect genuinely lives behind it — in that case the test header says so.
- **Behavioral name.** The test name describes the defect *behavior*, not the mechanism (`returns stale pin after close`, not `testCountCommits2`).
- **Header cites the defect ref** — one comment line naming the issue/finding id and the verified pre-fix sha.

## Exit states

| Exit | Meaning | Payload |
| --- | --- | --- |
| `reproduced` | Verified red test at the pre-fix commit | test path + `Repro-Verified` sha |
| `not-reproduced` (in-loop) | Candidate test does not fail on old code | iterate while budget remains |
| `inconclusive` | Budget exhausted or old surface unreachable | **attempt log** (mandatory) |
| `untestable` | Defect class is not vitest-testable | early exit, prose path continues |
| `already-fixed` | Claim no longer verifiable | reason reclassification note |

## Degraded mode

Missing `verifyReproduction` binding → observed red run recorded in the commit body + `Degraded: commands.verifyReproduction` in the report. Missing test infrastructure entirely → `untestable`, no loop.

## Orchestrated runs

Inside queue/batch runs this skill applies non-interactively: a defect claim inside a queue item triggers the loop during the implement stage; `inconclusive` is recorded with its attempt log — never parked as an open decision, never silently dropped.

## What this skill is not

- Not a fix skill — it stops at a verified red test. The fix belongs to the caller (`fo-fix`, `fo-idea-implement`, `fo-triage` routing).
- Not a gate — `inconclusive` never halts work by itself.
- Not for `regression <risk>` reasons — a regression risk is anticipatory; there is no defect to reproduce. It keeps the RFC-1332 path.
