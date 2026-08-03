---
name: grilling
description: Grill the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
invocation: user
category: shared
concerns: read-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
knowledge:
  - qa-log.md
  - learned-principles.md
---

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Read `learned-principles.md` (L2) at the start of each session to improve recommended answers. Apply only entries with `status: active`; skip entries with `status: stale`, `superseded`, or `archived`. Principles with `confirmations >= 3` may be applied autonomously — but re-evaluate if context changes.

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a _fact_ can be found by exploring the codebase, look it up rather than asking me. The _decisions_, though, are mine — put each one to me and wait for my answer.

Do not ask a question whose answer is already obvious from the codebase, prior answers, or surrounding context. If you can infer the answer with reasonable confidence, state your inference as the recommended answer and let the operator correct you if wrong. Reserve questions for genuine uncertainty.

Do not enact the plan until I confirm we have reached a shared understanding.

At the end of the session, perform meta-analysis: identify recurring decision patterns from `qa-log.md` (L0), formulate concrete principles, present to operator for approval, and append approved principles to `learned-principles.md` (L2). Append Q&A pairs to `qa-log.md` (L0) during the session.
