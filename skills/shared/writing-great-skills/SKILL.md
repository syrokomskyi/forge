---
name: writing-great-skills
description: Reference for writing and editing skills well — the vocabulary and principles that make a skill predictable.
invocation: user
category: shared
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

A skill exists to wrangle determinism out of a stochastic system. **Predictability** — the agent taking the same _process_ every run, not producing the same output — is the root virtue; every lever below serves it.

**Bold terms** are defined in [`GLOSSARY.md`](GLOSSARY.md); look them up there for the full meaning.

## Invocation

Two choices, trading different costs:

- A **model-invoked** skill keeps a **description**, so the agent can fire it autonomously _and_ other skills can reach it (you can still type its name too). It contributes to **context load** — the description sits in the window every turn. Mechanics: omit `disable-model-invocation`, and write a model-facing description with rich trigger phrasing ("Use when the user wants…, mentions…").
- A **user-invoked** skill strips the description from the agent's reach: only you, typing its name, can invoke it — and no other skill can. Zero context load, but it spends **cognitive load**: _you_ are the index that must remember it exists. Mechanics: set `disable-model-invocation: true`; the `description` becomes human-facing — a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each.

## Writing the description

A model-invoked **description** does two jobs — state what the skill is, and list the **branches** that should trigger it. Every word increases **context load**, so a description earns even harder pruning than the body:

- **Front-load the skill's leading word** — the description is where it does its invocation work.
- **One trigger per branch.** Synonyms that rename a single branch are **duplication** — "build features using TDD … asks for test-first development" is one branch written twice. Collapse them; keep only genuinely distinct branches.
- **Cut identity that's already in the body.** Keep the description to triggers, plus any "when another skill needs…" reach clause.

## Information hierarchy

A skill is built from two content types — **steps** and **reference** — that mix freely: a skill can be all steps, all reference, or both. The core decision is which to use and where each sits on the **information hierarchy**, a ladder ranked by how immediately the agent needs the material:

1. **In-skill step** — an ordered action in `SKILL.md`, the primary tier: what the agent does, in order. Each step ends on a **completion criterion**, the condition that tells the agent the work is done. Make it _checkable_ (can the agent tell done from not-done?) and, where it matters, _exhaustive_ ("every modified model accounted for", not "produce a change list") — a vague criterion invites **premature completion**.
2. **In-skill reference** — a definition, rule, or fact in `SKILL.md`, consulted on demand. Often a legitimately flat peer-set (every rule of a review on one rung) — a fine arrangement, not a smell. _This skill is all reference._
3. **External reference** — reference pushed out of `SKILL.md` into a separate file, reached by a **context pointer**, loaded only when the pointer fires. (Spans _disclosed_ reference — a sibling file like `GLOSSARY.md`, still part of the skill — through fully **external reference** that lives outside the skill system and any skill can point at.)

A demanding completion criterion drives thorough **legwork** — the digging the agent does within the work — whether the skill has steps or not, since "every rule applied" binds flat reference just as "every step done" binds a sequence.

Push too little down and the top bloats; push too much and you hide material the agent actually needs. That tension is the whole decision.

**Progressive disclosure** is the move down the ladder — out of `SKILL.md` into a linked file — so the top stays legible. Mechanics: a linked `.md` file in the skill folder, named for what it holds (this skill discloses its full definitions to `GLOSSARY.md`). Some skills are used in more than one way, and each distinct way is a **branch** — different runs taking different paths through the skill. Branching is the cleanest disclosure test: inline what every branch needs, and push behind a pointer what only some branches reach. A **context pointer**'s _wording_, not its target, decides when and how reliably the agent reaches the material.

Where the ladder decides _how far down_ a piece sits, **co-location** decides _what sits beside it_ once there: keep a concept's definition, rules, and caveats under one heading rather than scattered, so reading one part brings its neighbours with it.

## When to split

**Granularity** is how finely you divide skills, and each cut spends one of the two loads, so split only when the cut earns it. Two cuts:

- **By invocation** — split off a **model-invoked** skill when you have a distinct **leading word** that should trigger it on its own, or another skill must reach it. You pay **context load** for the new always-loaded **description**, so that independent reach has to be worth it.
- **By sequence** — split a run of **steps** when the steps still ahead (a step's **post-completion steps**) tempt the agent to rush the one in front of it (**premature completion**). Keeping them out of view encourages the agent to do more **legwork** on the current task.

## Pruning

Keep each meaning in a **single source of truth**: one authoritative place, so changing the behaviour is a one-place edit.

Check every line for **relevance**: does it still bear on what the skill does?

Then hunt **no-ops** sentence by sentence, not just line by line: run the no-op test on each sentence in isolation, and when one fails, delete the whole sentence rather than trim words from it. Be aggressive — most prose that fails should go, not be rewritten.

## Leading words

A **leading word** is a compact concept already living in the model's pretraining that the agent thinks with while running the skill (e.g. _lesson_, _fog of war_, _tracer bullets_). Repeated throughout the text (though not necessarily - a strong leading word might only be needed once), it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens, by recruiting priors the model already holds.

It serves predictability twice. In the body it anchors _execution_: the agent reaches for the same behaviour every time the word appears. In the description it anchors _invocation_: when the same word lives in your prompts, docs, and code, the agent links that shared language to the skill and fires it more reliably.

Hunt for opportunities to refactor skills to use leading words. A triad spelled out at three sites (**duplication**), a description spending a sentence to gesture at one idea — each is a passage begging to **collapse** into a single token. Examples include:

- "fast, deterministic, low-overhead" -> _tight_ — one quality restated across a phase — into a single pretrained word (a _tight_ loop).
- "a loop you believe in" -> _red_ — converts a fuzzy gate into a binary observable state (the loop goes _red_ on the bug, or it doesn't).

You win twice over: fewer tokens, _and_ a sharper hook for the agent to hang its thinking on. Assume every skill is carrying restatements that leading words retire — go find them.

## Failure modes

Use these to diagnose issues the user may be having with the skill.

- **Premature completion** — ending a step before it's genuinely done, attention slipping to _being done_. Defence, in order: sharpen the completion criterion first (cheap, local); only if it is irreducibly fuzzy _and_ you observe the rush, hide the post-completion steps by splitting (the sequence cut).
- **Duplication** — the same meaning in more than one place. Costs maintenance and tokens, and inflates a meaning's prominence on the ladder past its real rank.
- **Sediment** — stale layers that settle because adding feels safe and removing feels risky. The default fate of any skill without a pruning discipline.
- **Sprawl** — a skill simply too long, even when every line is live and unique. Hurts readability and maintainability and wastes tokens. The cure is the ladder: disclose **reference** behind pointers, and split by **branch** or sequence so each path carries only what it needs.
- **No-op** — a line the model already obeys by default, so you pay load to say nothing. The test: does it change behaviour versus the default? A weak leading word (_be thorough_ when the agent is already thorough-ish) is a no-op; the fix is a stronger word (_relentless_), not a different technique.
- **Negation** — steering by prohibition backfires: _don't think of an elephant_ names the elephant and makes it more available, not less. Prompt the **positive** — state the target behaviour so the banned one is never spoken; keep a prohibition only as a hard guardrail you can't phrase positively, and even then pair it with what to do instead.

## Cumulative knowledge pattern

Skills that run repeatedly accumulate knowledge across sessions. The cumulative knowledge convention provides an opt-in three-layer reference pattern (plus one shared cross-skill layer) for this.

### Knowledge frontmatter

A skill declares its knowledge files by adding a `knowledge:` array to SKILL.md frontmatter, listing file names relative to the SKILL.md directory:

```yaml
knowledge:
  - qa-log.md
  - learned-principles.md
```

`forge.skill.validate` enforces SKILL-13: declared knowledge files must exist. `forge.create` syncs them to `.agents/skills/`. `forge.doctor` detects stale copies.

### Three-layer reference pattern

Skills adopt 0, 1, 2, or 3 layers as needed — the pattern is adaptive, not mandatory.

| Layer | File name | Role |
| --- | --- | --- |
| L0 | `qa-log.md` | Append-only log of questions asked and answers given during runs |
| L1 | `fix-patterns.md` | Baseline fix patterns for recurring violations |
| L2 | `learned-principles.md` | Concrete principles distilled from past runs, with `confirmations: N` counter |

Not every skill needs all three. `grilling` uses L0 and L2 only (no fix patterns). A site-scanning skill may use all three.

### Shared layer (L2, cross-skill)

In addition to the three skill-local layers, there is a fourth tier: the **shared knowledge layer** at `packages/forge/skills/shared/knowledge/learned-principles.md`. This file holds promoted cross-skill principles with `shared/K-NNNN` identifiers.

- **Detection**: `forge.doctor` reports cross-skill duplicate L2 entries via normalized-title matching (exact and bounded containment).
- **Promotion**: `fo-knowledge-distill` executes promotions under operator grilling — the principle moves to the shared layer with summed confirmations and `promotedFrom` provenance; each skill-local copy is rewritten to a pointer entry (`promotedTo: shared/K-NNNN`, `status: superseded`).
- **Consumption**: knowledge-adopting skills read the shared layer at run start and cite shared principles as `shared/K-NNNN`.
- **Validation**: `forge.doctor` validates the shared layer file for schema validity and id uniqueness (it is not inside a skill directory, so `forge.skill.validate` does not reach it).
- **npm portability**: the shared layer ships as an empty template — accumulated promotions are project-specific.

### Entry format

Each knowledge entry is a `### K-NNNN: title` heading followed by a `knowledge-entry` YAML metadata block and a markdown body:

````markdown
### K-0001: Skip non-project sessions

```knowledge-entry
id: K-0001
layer: L1
created: 2026-08-03
status: active
````

**Situation:** ...

**Action:** ...

```

#### Metadata schema

| Field | Type | Required | Layers | Meaning |
| --- | --- | --- | --- | --- |
| `id` | `K-NNNN` | all | all | Unique 4-digit identifier within the file |
| `layer` | `L0` \| `L1` \| `L2` | all | all | Knowledge layer |
| `created` | `YYYY-MM-DD` | all | all | Date the entry was first written |
| `lastConfirmedAt` | `YYYY-MM-DD` \| `null` | L2 only | L2 | Date of last operator confirmation |
| `confirmations` | integer ≥ 0 | L2 only | L2 | Confirmation counter for autonomous application |
| `expiresAt` | `YYYY-MM-DD` \| `null` | optional | all | Date after which the entry is stale |
| `supersedes` | `K-NNNN[]` | optional | all | Entries this one replaces (must resolve in same file) |
| `promotedTo` | `shared/K-NNNN` \| `null` | optional | all | Cross-file promotion target |
| `promotedFrom` | `<skill>/K-NNNN[]` | optional | shared | Provenance — which skill-local entries were promoted into this shared entry |
| `status` | `active` \| `stale` \| `superseded` \| `archived` | all | all | Lifecycle state |

#### Layer-specific rules

- **L0** (`qa-log.md`): `confirmations` and `lastConfirmedAt` are forbidden.
- **L1** (`fix-patterns.md`): `confirmations` and `lastConfirmedAt` are forbidden.
- **L2** (`learned-principles.md`): `confirmations` and `lastConfirmedAt` are required.

#### Knowledge-adjacent files

Files declared in `knowledge:` frontmatter that do not use `### K-NNNN:` headings and have no `<!-- knowledge-layer: ... -->` preamble are **knowledge-adjacent** — they are exempt from SKILL-19/SKILL-20. Examples: `forge-about.md`, `operator-profile-template.md`, `project-narrative-template.md`.

#### Validation

`forge.skill.validate` enforces:
- **SKILL-19**: entry metadata schema validity (errors) and legacy section warnings (migration window).
- **SKILL-20**: identifier uniqueness (`K-NNNN` format, no duplicates, `supersedes` references resolve, `promotedTo` format).
- **SKILL-21**: hot (L2) and warm (L1) layer character budget warnings — warnings only, never build gates. Defaults: hot=4096, warm=8192. Override in `forge.yaml` under `bindings.knowledge.budgets`.

`forge.doctor` reports legacy section counts and knowledge budget summaries as informational warnings.

### Reading discipline

When a skill declares `knowledge:` files, the skill body MUST include a one-line instruction telling the agent how to read them. Add this line to the skill's process section:

> Read declared knowledge files at the start of each run, in declaration order. Apply only entries with `status: active`. Skip entries with `status: stale`, `superseded`, or `archived`.

This ensures the agent knows to load and filter knowledge entries by lifecycle status, rather than blindly applying all entries including stale ones.

### Confidence progression

L2 entries carry a `confirmations: N` counter. When confirmations reach threshold 3, the skill may apply the principle autonomously without asking the operator. Rejecting a recommended answer resets confirmations to 0. Autonomous application is context-dependent — the skill should re-evaluate if context changes.

### Mutation contract

- **Source-of-truth**: `packages/forge/skills/<category>/<name>/`. Skills mutate knowledge files here during runs and commit to main repo. Skills always read from source.
- **Runtime copy**: `.agents/skills/<name>/`. Synced by `forge.create`. Read-only — skills never write here. The `.agents/` copy exists for consumers who install `@warpgogol/forge` as an npm package.
- **Sync**: one-way (source → `.agents/`), never the reverse.
- **Stale detection**: `forge.doctor` compares source and `.agents/` copies, reports drift as warnings.

### npm portability

`@warpgogol/forge` is published to npm with `skills/` in the `files` array. Knowledge files ship as empty templates (header comments only). Forge's accumulated Q&A and learned principles are project-specific and should not leak to npm consumers. Each project accumulates its own knowledge locally after running `forge.create`.
```
