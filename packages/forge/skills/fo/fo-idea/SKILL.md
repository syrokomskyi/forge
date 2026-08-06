---
name: fo-idea
description: Analyze a user's idea, decompose if too large, and route to fo-idea-create-rfc or fo-idea-create-adr. Use when the user describes a change and is unsure if it needs an RFC or ADR.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [paths.invariantsFile]
triggers: ["I have an idea for a change", "analyze this idea and route it", "decompose this feature idea"]
---

# Idea → RFC or ADR

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

> **This is a document-only skill.** It produces RFC and/or ADR files in `docs/rfcs/` or `docs/adrs/` — nothing else. It must never modify, create, or delete source code files in `apps/`, `packages/`, `services/`, or any other directory. It must not run build commands, tests, or validation suites. If the operator's description sounds like a concrete implementation task (e.g. "replace fonts", "add a button", "fix the sitemap"), that is expected — this skill's job is to **create the document that precedes implementation**, not to implement the change itself. Implementation is handled by `fo-idea-implement` after the document is accepted.

Analyze the operator's text to determine whether the task requires a single RFC, a single ADR, or a **series** of documents. When a series is needed, decompose the task into atomic decisions, classify each, and create all documents in dependency order.

## Process

### 1. Analyze the request

Read the operator's description and identify:

- **What is being decided** — the core decision or change.
- **What is affected** — packages, apps, commands, DNA invariants, AGENTS.md rules, existing RFCs.
- **The blast radius** — is this local to one package/app, or does it cross workspace boundaries?
- **The atomic decisions** — can the task be cleanly split into independent decisions that each stand alone as RFCs or ADRs?

**Implementation-language guard.** The operator may describe the task in concrete implementation terms ("replace the fonts", "add italic support", "switch to self-hosted fonts", "add a new check command"). This is normal — the operator is describing the _what_, not asking for the _how right now_. This skill converts that description into a governance document. Do not interpret concrete language as a request to start coding. If the description is ambiguous between "create a document" and "implement now", ask one clarifying question using `ask_user_question`:

> "This sounds like a concrete change. Should I create an RFC/ADR draft for it, or do you want me to implement it directly?"
>
> Recommended option: "Create RFC/ADR draft" — because this skill is `fo-idea`, not `fo-idea-implement`.

Default to document creation. Only route to implementation if the operator explicitly says "implement" or "don't create a document, just do it".

### 1b. Explore suggestion

If the operator's description is ambiguous, exploratory, or contains phrases like "what are the options", "let me think about", "explore", or "what if we", suggest using `fo-explore` before creating an RFC. Use `ask_user_question`:

> "This sounds like an exploration rather than a settled decision. Should I explore the codebase first, or create an RFC/ADR draft directly?"
>
> Recommended option: "Explore first" — because exploration is low-commitment and the results inform a better RFC.

If the operator chooses "Explore first", invoke `/fo-explore` inline. Do not proceed to classification or document creation in this invocation — `fo-explore` will produce an exploration note and suggest next steps, which may include creating an RFC or ADR in a separate invocation.

### 1a. Accepted-decision fast path

When the operator signals that a decision is **already made** and provides justification, the skill must take a fast path. Recognition signals include:

- Explicit markers: "принятое решение", "accepted decision", "we decided", "decision:", "решение:", "we use", "используем", "standard:", "правило:"
- The text includes a full rationale or justification (not just a question or vague idea)
- The text reads as a pronouncement, not a proposal

When the accepted-decision fast path is triggered:

1. **Classify using the decision table in step 3a** — but do not ask clarifying questions unless the table is genuinely ambiguous after reading the full justification.
2. **If ADR**: invoke `/fo-idea-create-adr` inline, but **skip grilling** — the operator has already decided and justified. Tell `fo-idea-create-adr` to skip its step 4 (grilling) by passing the operator's justification as the ADR's `Justification` section directly. Proceed to file creation, fill all sections from the operator's text, validate, and report.
3. **If RFC**: still invoke `/fo-idea-create-rfc` with full grilling — RFCs govern cross-workspace contracts and need stress-testing even when the operator has decided.
4. **Do not search for RFC numbers, run `rfc.list`, or scan the `docs/rfcs/` directory** when the classification is ADR. This is a waste of time and a misclassification signal.

The fast path does **not** skip validation (`adr.validate` / `rfc.validate`) — only the grilling step is skipped for ADRs.

### 2. Assess scope: single document or series?

A task needs a **series** when **any** of the following is true:

- The task introduces multiple new Site OS commands across different domains (e.g. a new check command + a new codegen command + a new build pipeline command).
- The task spans multiple independent package boundaries with separate concerns (e.g. changes to multiple shared packages that are each independently useful).
- The task naturally decomposes into phases with clear dependency edges (e.g. a contract definition RFC must be accepted before a command implementation RFC that depends on it).
- A single RFC's Design section would be unmanageably long — covering unrelated files, unrelated type signatures, and unrelated failure modes.
- The task amends multiple existing RFCs in unrelated areas.
- Some parts are local (ADR) and some are cross-workspace (RFC), and the local parts do not depend on the RFC parts.

A task is a **single document** when:

- All decisions are tightly coupled and cannot stand alone.
- The task is local to one package/app with one coherent decision.
- Splitting would produce documents that reference each other so heavily that they cannot be read independently.

If the task is a single document, proceed to step 3 (classify and create).

If the task needs a series, proceed to step 4 (decompose).

### 3. Single document: classify and create

#### 3a. Classify: RFC or ADR

Use the following decision table:

| Criterion | RFC | ADR | Examples |
| --- | --- | --- | --- |
| Adds, removes, or changes a Site OS command | yes | no | New `fonts.selfhost.validate` command; changing `content.surface.validate` behavior |
| Modifies a DNA invariant or AGENTS.md rule | yes | no | Changing the cosmic naming contract; adding a new storage policy to AGENTS.md |
| Establishes a cross-workspace package boundary or contract | yes | no | New shared package exported schema; new package interface; inter-package type contract |
| Changes a currently accepted or implemented RFC | yes | no | Amending RFC-XXXX content surface; superseding RFC-XXXX |
| Introduces a new policy or governance process | yes | no | RFC lifecycle process; feature visibility policy; verification evidence pipeline |
| A convention, standard, or tooling choice applied across apps | no | yes | "Use Fontsource for all fonts"; "Self-host Playfair Display"; CSS methodology; lint rule choices |
| Local to one package, one app, or one narrow convention | no | yes | Changing a biome's typography tokens; adding a font family to the self-host registry |
| Does not touch commands, DNA, AGENTS.md, or cross-workspace contracts | no | yes | Choosing a library; picking a CSS token naming scheme; selecting an image format strategy |

**If any RFC criterion is met → RFC.** Only if all ADR criteria are met and no RFC criterion applies → ADR.

#### Common misclassification traps

These patterns **look like RFCs but are ADRs**:

- **"Applied to all apps" ≠ "cross-workspace contract"** — a convention like "use Fontsource for fonts" or "self-host all web fonts" applies everywhere but does not create a package boundary, inter-package type contract, or new command. It is an ADR with `scope: workspace`.
- **"Changes a shared package" ≠ "establishes a package boundary"** — extending `packages/os/site-kernel-checks/src/fonts.ts` with a new font family modifies shared code, but the decision is about which fonts to use, not about the package's interface or contract. ADR.
- **"Might be mentioned in AGENTS.md" ≠ "modifies a DNA invariant"** — a decision might be documented in AGENTS.md for visibility, but unless it changes a DNA-NN invariant or a governance rule, it is an ADR.
- **"Has cross-app impact" ≠ "cross-workspace contract"** — adding a font to the shared registry affects all apps' builds, but the decision itself is a tooling/standard choice, not a contract between packages.

These patterns **look like ADRs but are RFCs**:

- **"Just adding one field to a schema"** — if the schema is a cross-workspace contract (e.g. a shared package exported types), changing it is an RFC even if the diff is small.
- **"It's only a convention"** — if the convention is enforced by a new Site OS command or validator, it needs an RFC to define the command.
- **"It's local to one package"** — if that package's change breaks an accepted RFC or changes a DNA invariant, it needs an RFC.

If the classification is ambiguous (e.g. the operator's description is too vague), ask a clarifying question using `ask_user_question` with the recommended classification first.

#### 3b. Invoke the creation skill inline

Once classified, invoke the matching skill **inline** — execute it fully without stopping or returning control to the user:

- **RFC** → invoke `/fo-idea-create-rfc`. It will collect metadata, grill the concept, create the file, fill it, validate, and report.
- **ADR** → invoke `/fo-idea-create-adr`. It will collect metadata, grill the concept, create the file, fill it, validate, and report. **On the accepted-decision fast path (step 1a)**, tell `fo-idea-create-adr` to skip grilling and use the operator's justification text directly.

Do not duplicate the creation skill's work — just route to it and let it run.

#### 3c. Report

After the creation skill completes, present its final report to the user in `aiLanguage`. Add a one-line prefix indicating which path was taken — translate the label to `aiLanguage`:

```
<Classified as in aiLanguage>: RFC (cross-workspace command addition) / ADR (local package convention)
```

Followed by the creation skill's own report.

### 4. Series: decompose, classify, and create each document

#### 4a. Decompose into atomic decisions

Break the task into the smallest set of independent decisions such that:

- Each decision can be read, reviewed, accepted, and implemented on its own.
- Each decision has a clear, single-sentence Decision statement.
- Dependencies between decisions are explicit (document A must be accepted before document B can be implemented).
- No decision is so small that it would be better as a section of another document.

For each atomic decision, record:

- **Title** — short imperative sentence.
- **Type** — RFC or ADR (use the decision table from step 3a).
- **Scope** — `workspace`, `package`, or `app`.
- **Depends on** — other documents in this series that must be accepted first.
- **Summary** — one or two lines describing what this document decides.

#### 4a-spec. Spec escalation check

After decomposition, check whether this is a **specification**, not a document series:

- If decomposition yields **more than 7 atomic decisions** with at least one dependency edge, OR
- The operator's description mentions waves/stages/data migration across many documents

Then propose escalation using `ask_user_question`:

> "This is a specification, not a document series. Create a spec package via fo-spec-ingest authoring mode?"

- **Recommended option**: "Create spec package" — because a pre-designed roadmap with 65 nodes is a spec, not a series of independent RFCs.
- **Alternative**: "Continue as series" — the operator may decline and stay with the series path.

If the operator accepts escalation, invoke `/fo-spec-ingest` in authoring mode, passing the decomposition results. Do not continue with the series creation steps below.

#### 4b. Present the decomposition plan

Present the full plan to the operator before creating any files, in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only.

```
## <Decomposition Plan in aiLanguage>

This task requires <N> documents:

1. **<Title 1>** — <RFC|ADR> (scope: <scope>)
   Depends on: none
   <one-line summary>

2. **<Title 2>** — <RFC|ADR> (scope: <scope>)
   Depends on: <Title 1>
   <one-line summary>

...

### Creation order: 1 → 2 → ... → N
```

Ask the operator to confirm or adjust the decomposition using `ask_user_question`. Do not proceed to creation until the plan is confirmed.

#### 4c. Create each document in dependency order

Process documents **sequentially in dependency order** — foundational documents first. For each document:

1. Invoke the appropriate creation skill **inline** (`/fo-idea-create-rfc` or `/fo-idea-create-adr`).
2. When the creation skill collects metadata, include the cross-references:
   - **`related`** — list all other documents in the series by their assigned id (once created) or by title (if not yet created).
   - **`amends`** — if a document in the series amends an existing accepted RFC, set the `amends` field.
3. The creation skill will grill, create, fill, validate, and report — let it run fully.
4. After each document is created, record its assigned id for use in subsequent documents' `related` fields.
5. Do not pause between documents in the series — continue to the next immediately.

If a creation skill's grilling reveals that a document in the series is unnecessary (the decision is already covered by an existing RFC/ADR), skip it and note this in the final report. If grilling reveals that a missing document is needed, add it to the plan and create it in the correct dependency position.

#### 4d. Series report

After all documents are created, present a single batch report in `aiLanguage`. **Translate all labels, headings, and column names to `aiLanguage`** — the template below is structural only.

```
## <Series Creation Summary in aiLanguage>

### Task: <original operator request — one line>
### Documents created: <N>

| # | ID | Type | Title | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | RFC-XXXX | RFC | <title> | — | draft |
| 2 | ADR-XXXX | ADR | <title> | RFC-XXXX | proposed |
| 3 | RFC-XXXX | RFC | <title> | RFC-XXXX | draft |
...

### Next steps
- Human architecture review for all RFC drafts (status may not change before acceptance).
- ADRs are ready for the named decider to accept.
- Implement in dependency order: 1 → 2 → 3 → ...
```

## Constraints

- **Document-only. This skill must never modify, create, or delete source code files.** It must not touch files in `apps/`, `packages/`, `services/`, `tools/`, `scripts/`, or any other source directory. It must not run `pnpm`-based builds, `pnpm test`, `astro check`, or any build/validation command other than `rfc.validate` / `adr.validate` (which run inside the delegated creation skills). The only files this skill may produce are RFC files in `docs/rfcs/` and ADR files in `docs/adrs/` — and even those are created by the delegated `fo-idea-create-rfc` / `fo-idea-create-adr` skills, not by this skill directly. If you feel the urge to "quickly fix something in the code while I'm here" — stop. That is not this skill's job.
- **Classify before invoking.** Do not invoke both skills for one document — pick one based on the decision table.
- **When genuinely ambiguous, ask — do not default to RFC.** Conventions, tooling choices, library selections, and standards applied across apps are ADRs even when they touch shared packages. Defaulting to RFC for every cross-app decision clogs the RFC pipeline and wastes architecture review time on local technical choices. If the table and examples do not resolve the classification, ask the operator with `ask_user_question` presenting both options. Reserve RFC for decisions that genuinely change commands, DNA, AGENTS.md rules, cross-workspace contracts, or governance process.
- **Do not skip the creation skill's grilling step — except on the accepted-decision fast path (step 1a).** When the operator has signaled an already-made decision with justification and the classification is ADR, grilling is skipped because the operator has already decided. In all other cases, grilling happens inside the invoked skill — this skill only routes.
- **Do not create files directly.** This skill never writes RFC or ADR files — it delegates to `fo-idea-create-rfc` or `fo-idea-create-adr`.
- **Decomposition must produce independent documents.** Each document in a series must be readable, reviewable, and implementable on its own. If two decisions cannot be separated, keep them in one document.
- **Cross-reference all documents in a series.** Every document in a series must list all other documents in the series in its `related` field. Update `related` fields as ids are assigned.
- **Respect dependency order.** A document that depends on another must not be created before its prerequisite — the prerequisite's id is needed for the `related` field.
- **Commit only your own files.** Stage only the files this skill produces or modifies — RFC/ADR files and nothing else. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- **Present the decomposition plan before creating files.** The operator must confirm the decomposition before any document is created. Adjust if requested.
