---
name: grilling
description: Grill the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
invocation: user
category: shared
concerns: read-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
knowledge:
  - qa-log/
  - learned-principles.md
---

<!--
<MODULE_CONTRACT>
<purpose>grilling skill — Grill the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1460: recurring frictions escalate to mechanical measures — FRICTION-06/07/08, registry flips, session-retro escalation</item>
  <item>RFC-1481: sync namespaces, rollout, and verification guidance</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
  <item>RFC-1604: correct the validator rules pinned false-positive by the friction registry (RFC-1604)

- probe-meta: mask [...] classes before metachar scans (F-0224)
- skill.validate: exempt managed .agents/skills twins from SKILL-11 (sf-F-0004)
- rfc-0000 template: emit reviewers ["human:<handle>"] placeholder (ds-F-0017)
- robots.generate: drop wildcard no-op directives; PUBTXT-09 scoped to the * group (F-0232)
- page.render.check: dead exemptions move to staleExemptions channel (F-0233)
- cosmic.literals.lint: extend retired-channel scan to systems/*.yaml (F-0172)
- price.presence.validate: accept Intl-emitted price shapes incl. attribute resolution (F-0231)
- ecosystem.commit EC-33: scan over maskSource keepComments (F-0221)</item>
  <history>RFC-1097, RFC-1250, RFC-1455</history>
</CHANGE_SUMMARY>
-->

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

## Modes

Grilling runs in one of two modes — the caller selects:

- **`interview`** (default — standalone, operator-invoked runs): the interactive behavior below, one question at a time.
- **`emit`** (inside an orchestrator-driven queue run — `fo-idea-i-just-want-to-see-the-result` queue mode): never ask the operator. Generate the same questions you would have asked, climb the self-resolution ladder (`_shared/fo-pipeline-conventions.md` §Self-resolution ladder), and append each surviving question to the queue's decision ledger `docs/queues/<id>.decisions.yaml` as an `open` entry (`id: Q-N`, `doc`, `stage`, `question`, `resolutionPath`, `options` with `recommended: true` on your recommended answer, `status: open`). Branching questions are written conditionally ("if Q-3 resolves to X, then…"). The pipeline's decision window consumes the emitted entries.

Mode trigger: `emit` activates only when the invoking skill passes a queue manifest / ledger path; otherwise `interview`.

Read `learned-principles.md` (L2) at the start of each session to improve recommended answers. Apply only entries with `status: active`; skip entries with `status: stale`, `superseded`, or `archived`. Principles with `confirmations >= 3` may be applied autonomously — but re-evaluate if context changes.

When writing consumer-local knowledge entries, use the next `L-K-NNNN` ID (max existing local ordinal + 1). Upstream Forge source entries keep `K-NNNN`; do not hand-renumber collision cases — preview and use `forge knowledge.conflicts.resolve`.

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a _fact_ can be found by exploring the codebase, look it up rather than asking me. The _decisions_, though, are mine — put each one to me and wait for my answer.

Do not ask a question whose answer is already obvious from the codebase, prior answers, or surrounding context. If you can infer the answer with reasonable confidence, state your inference as the recommended answer and let the operator correct you if wrong. Reserve questions for genuine uncertainty.

When an answer fixes an observable value — verbatim copy, a label, a name, a decided option value — say so explicitly in the summary (mark it `fixes value`), so the RFC author carries the literal into the RFC's `## Fixed inputs` section with a bound criterion.

Do not enact the plan until I confirm we have reached a shared understanding.

At the end of the session, perform meta-analysis: identify recurring decision patterns from every shard under `qa-log/` in name order (L0), formulate concrete principles, present to operator for approval, and append approved principles to `learned-principles.md` (L2). Append Q&A pairs to your own session shard `qa-log/<session-id>.md` (L0) during the session — one file per session, never the shared `qa-log.md`.

All knowledge writes resolve under the writing session's own checkout (RFC-1599): walk cwd upward to the nearest `.git` — a gitfile marks the session worktree — and root `.agents/` there, never at a fixed primary path a parallel session shares. When no checkout owns the cwd, write under `.agents-local/` instead. <!-- skill-lint-disable SKILL-17 -->
