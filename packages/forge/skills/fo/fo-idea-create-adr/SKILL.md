---
name: fo-idea-create-adr
description: Create a lightweight Architectural Decision Record (ADR) draft in docs/adrs/. Use when the user asks to record a local technical decision that does not need a full RFC.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateAdr]
  optional: [paths.invariantsFile]
triggers: ["record this architectural decision", "create an ADR", "document a local technical decision"]
---

# ADR Create

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

**Language policy**

- Every natural-language message shown to the operator in this session — greetings, questions, explanations, and status updates — must use `aiLanguage`.
- The generated ADR draft and any edited ADR prose must use `documentationLanguage`.
- Internal reasoning, tool-call planning, and intermediate agent monologue may stay in the agent's working language (usually English); do not translate them for the operator.
- Do not translate existing files automatically; preferences affect only new output and the current session.

Create a complete, `adr.validate`-ready ADR draft. ADRs are for **local technical decisions** (one package, one app, or one narrow workspace convention) that do not introduce a new Site OS command, change a DNA invariant, or establish cross-workspace policy.

ADR lifecycle (full RFC parity): `proposed → reviewing → accepted → implemented`. Any status may transition to `superseded` or `rejected`. ADR frontmatter includes `implementedAt`, `closedAt`, and `reviewers` fields matching RFC frontmatter.

## Process

### 1. Prefix and existing-ADR checks

1. **Prefix check** — if the user provides an id starting with `RFC-`, stop with message: `RFC-XXXX is an RFC, not an ADR. Use /fo-idea-create-rfc for RFCs, or /fo-idea-audit, /fo-idea-enhance, /fo-idea-plan, /fo-idea-implement for RFC pipeline steps.`

2. **Existing ADR check** — if the user provides an existing ADR id (e.g. to amend or supersede), read the ADR's `status` frontmatter from `docs/adrs/adr-XXXX-*.md`. If the status is `implemented`, `rejected`, or `superseded` (terminal), stop with message: `ADR-XXXX is <status> (terminal). Terminal ADRs cannot be amended in place. To change this decision, create a new ADR or RFC that supersedes ADR-XXXX.`

If no existing ADR is referenced, proceed to step 2.

### 2. Decide whether an ADR is appropriate

Prefer an ADR when **all** of the following are true:

- The decision is local to one `packages/*` workspace, one `apps/*` site, or one internal convention.
- It does not add, remove, or change a Site OS command.
- It does not modify `AGENTS.md`, `ref(forge.yaml bindings.paths.invariantsFile)`, or any RFC.
- It does not establish a new package boundary or cross-app contract.
- It does not change a currently accepted or implemented RFC.

If any item is false, use `fo-idea-create-rfc` instead and stop.

### 3. Collect required metadata

- **title** (required) — short imperative sentence.
- **scope** — `package`, `app`, or `workspace`. Default `package`.
- **decider** — default `architecture`. The named decider is the only role that may move the ADR out of `proposed`.
- **reviewers** — default empty. When the operator has not specified a reviewer, read the default reviewer(s) from the `reviewers` field comment in `docs/adrs/adr-0000-template.md` (currently `human:andrii-syrokomskyi`). Set all listed default reviewers.
- **related** — any RFCs, ADRs, DNA invariants, or specs this decision relates to.

### 4. Grill the concept (skip if invoked with an accepted decision)

**Skip condition:** If the caller (e.g. `fo-idea` accepted-decision fast path) explicitly states that the operator has already decided and provided justification, skip grilling and proceed directly to step 5. The operator's justification text will be used as the ADR's `Justification` section.

Otherwise, before creating the file, invoke the `/grilling` skill to stress-test the proposed ADR concept. The grilling examines:

- Is the decision truly local, or does it actually need an RFC?
- Is the scope correct — `package`, `app`, or `workspace`?
- Are there hidden dependencies or conflicts with existing accepted RFCs or ADRs?
- Is the decision concrete enough to record, or is it still vague?
- Are there alternative approaches that haven't been considered?
- Does the `related[]` list accurately capture the RFC/DNA context?

Address every concern the grilling raises by adjusting the metadata, scope, or concept before proceeding. Do not create the ADR file until the grilling is satisfied with the concept.

### 5. Create the ADR file

Run:

> Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```sh
ref(forge.yaml bindings.commands.validateAdr) --create --title="<title>" --scope=<scope> --related=<related-ids>
```

### 6. Fill every section

Read the generated file and the template (`docs/adrs/adr-0000-template.md`). Replace placeholder text in every required section:

- **Context** — the concrete local situation, constraints, and relevant RFC/DNA context.
- **Decision** — a single sentence in the present tense stating the decision as fact.
- **Justification** — forces, trade-offs, and alternatives considered.
- **Consequences** — positive, negative, and any knowingly postponed technical debt.
- **Evolution** — thresholds that would trigger revisiting the decision; references to commits/PRs if the ADR is post-hoc.

### 7. Validate and report

Run:

```sh
ref(forge.yaml bindings.commands.validateAdr) <adr-id> --json
```

Fix every violation. Then report in `aiLanguage`. **Translate all labels to `aiLanguage`** — the template below is structural only.

```
ADR draft created: <file>
Status: proposed
Next step: the named decider must change status to accepted before implementation. Use /fo-idea-implement to implement the decision once accepted.
```

### 8. Commit

Commit the ADR draft. This is **mandatory** — the ADR file must be committed, not left in the working tree.

Commit message format:

```txt
adr: create ADR-XXXX <short title>

Draft ADR-XXXX (<title>) from template. Status: proposed, awaiting decider acceptance.
```

Stage only the ADR file — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

## Constraints

- **Grilling is mandatory before file creation — unless the caller explicitly signals an accepted-decision fast path.** When invoked from `fo-idea` with an already-made decision and operator-provided justification, skip step 4 and use the operator's text as the ADR's `Justification` section. In all other cases, do not skip step 4 — the concept must survive grilling before the ADR file is created.
- Do not change an ADR status out of `proposed`. Status transitions (`proposed → reviewing → accepted → implemented`) are handled by the implement skill or the named decider, not by this creation skill.
- Do not use an ADR for command/policy/DNA-level decisions — those require a full RFC.
- Do not create an ADR that contradicts an accepted/implemented RFC. If implementation reveals a conflict, escalate via `rfc.supersede.propose` or request a new RFC/ADR instead of silently working around it.
- Keep `adr.validate` clean before presenting the draft.
- **Commit the ADR draft.** The ADR file must be committed after creation and validation — never left in the working tree.
