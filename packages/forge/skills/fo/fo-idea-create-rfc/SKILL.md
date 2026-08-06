---
name: fo-idea-create-rfc
description: Create a full RFC draft from the rfc-0000-template.md template and prepare it for human architecture review. Use when the user asks to draft or scaffold an RFC.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile]
triggers: ["draft an RFC", "create a full RFC", "scaffold an RFC from template"]
---

# RFC Create

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

**Language policy**

- Every natural-language message shown to the operator in this session — greetings, questions, explanations, and status updates — must use `aiLanguage`.
- The generated RFC draft must be written in `documentationLanguage`.
- Internal reasoning, tool-call planning, and intermediate agent monologue may stay in the agent's working language (usually English); do not translate them for the operator.
- Do not translate existing files automatically; preferences affect only new output and the current session.

Create a complete, `rfc.validate`-ready RFC draft in `docs/rfcs/` using the full template. Do not implement the RFC — only produce the draft. The user must still request architecture acceptance explicitly.

## Process

### 1. Identify the RFC need

Confirm that the proposed change is not already covered by an accepted/implemented RFC. Before drafting, run:

> Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```sh
ref(forge.yaml bindings.commands.validateRfc) --status accepted --json
```

If a relevant accepted RFC exists, point the user to it and stop. If an existing draft covers the topic, ask whether to enhance that draft instead of creating a duplicate.

### 2. Collect required metadata

Ask the user for, or infer from context:

- **title** (required) — short imperative sentence.
- **kind** — `architecture`, `contract`, `command`, `policy`, or `deprecation`. Default to `architecture` for structural/cross-workspace changes.
- **scope** — `workspace` unless the change is strictly inside one app.
- **owners** — default `architecture`; confirm before using a different owner.
- **commands.proposed / changed / removed** — any new, modified, or removed Site OS commands.
- **packagesImpacted / appsImpacted** — concrete workspace names.
- **satisfies** — for `architecture` or `contract` RFCs, at least one `DNA-NN` invariant from `ref(forge.yaml bindings.paths.invariantsFile)`.
- **related** — relevant RFCs, DNA ids, anti-patterns, specs.
- **reviewer** — if the caller specifies a reviewer identity, use it. If not, default to `human:andrii-syrokomskyi` (matching the default in `os/rfc/rfc-0000-template.md` inside `@warpgogol/forge`) **only when the skill is also responsible for moving the RFC out of draft**. For a pure draft scaffold, leave `reviewers: []`.

### 3. Grill the concept

Before creating the file, invoke the `/grilling` skill to stress-test the proposed RFC concept. The grilling examines:

- Is the decision concrete enough to write an RFC for, or is it still vague?
- Is the scope correct — should this be an ADR instead of an RFC?
- Are there hidden dependencies or conflicts with existing accepted RFCs?
- Is the kind correct (architecture vs contract vs command vs policy)?
- Are the proposed commands well-formed and necessary?
- Does the proposed `satisfies[]` list actually match the DNA invariants the RFC will touch?
- Are there alternative approaches that haven't been considered?

Address every concern the grilling raises by adjusting the metadata, scope, or concept before proceeding. Do not create the RFC file until the grilling is satisfied with the concept.

### 4. Create the RFC file

Run:

```sh
ref(forge.yaml bindings.commands.validateRfc) --create --title="<title>" --kind=<kind> --scope=<scope>
```

### 5. Fill every section

Read the generated file and the full template (`os/rfc/rfc-0000-template.md` inside `@warpgogol/forge`) as a guide. Replace placeholder text in every required section:

- **Context** — the concrete situation, not a generic preamble.
- **Problem** — the exact risk or gap this RFC closes.
- **Decision** — a single sentence in the present tense stating the decision as fact.
- **Architectural fit** — which DNA invariants or accepted RFCs this aligns with or extends.
- **Design** — files, commands, type signatures, pipelines, output formats, failure modes.
- **Rollout** — implementation order, generated-file refresh, migration path for existing apps.
- **Alternatives considered** — at least one real alternative with a rejection reason.
- **Risks** — including agent-misinterpretation risk and false-positive rates for validators.
- **Acceptance criteria** — ≥3 checkable checkboxes mapped to implementation artifacts.
- **Implementation notes for agents** — explicit MAY/MUST NOT rules, status-gate reminders, escalation triggers.

When a section cannot be filled with confidence, insert `> NEEDS CLARIFICATION: <question>` instead of guessing. Do not leave sections empty or fill them with speculative content. Markers are resolved during the enhance step.

### 6. Validate and report

Run:

```sh
ref(forge.yaml bindings.commands.validateRfc) <rfc-id> --json
```

Fix every violation. Then report in `aiLanguage`. **Translate all labels to `aiLanguage`** — the template below is structural only.

```
RFC draft created: <file>
Status: draft
Next step: human architecture review (status may not change before acceptance).
```

### 7. Commit

Commit the RFC draft. This is **mandatory** — the RFC file must be committed, not left in the working tree.

Commit message format:

```txt
rfc: create RFC-XXXX <short title>

Draft RFC-XXXX (<title>) from template. Status: draft, awaiting human architecture review.
```

Stage only the RFC file — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

## Constraints

- **Grilling is mandatory before file creation.** Do not skip step 3 — the concept must survive grilling before the RFC file is created.
- Use the **full** RFC template for every RFC. Lightweight local decisions now use ADRs instead.
- Do not change `status` past `draft`.
- Do not add self-authorizing language such as "implementation may start before acceptance."
- Do not default `reviewers` on drafts unless the skill is explicitly performing a status transition and the caller has not supplied a reviewer — in that case use `human:andrii-syrokomskyi`.
- Keep `rfc.validate` clean before presenting the draft.
- **Commit the RFC draft.** The RFC file must be committed after creation and validation — never left in the working tree.
- **Never manually determine the RFC number.** Always use `rfc.create` (step 4) to assign the number. The RFC number space includes archived RFCs under `docs/rfcs/archive/` — a top-level-only scan of `docs/rfcs/` misses them and produces duplicate IDs. `rfc.create` scans the full tree recursively and picks the correct next number.
