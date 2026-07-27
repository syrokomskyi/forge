---
name: fo-architecture
description: Scan a codebase for deepening opportunities, present as HTML report, then grill through the chosen one. Uses deep-module vocabulary.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
triggers: ["analyze codebase architecture", "find deepening opportunities", "review code structure quality"]
---

# fo-architecture

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

This skill uses the deep-module vocabulary from `architecture-vocabulary.md` (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**). Use these terms exactly in every suggestion — don't drift into "component," "service," "API," or "boundary."

## Process

### 1. Explore

The scope of the review must be determined **explicitly** before any other action. Search for the package or repository root to review in this order:

1. **Prompt** — the operator's invocation arguments (a package path, a folder, or the repository root).
2. **Session context** — files open in the IDE or prior conversation context that clearly indicates which package to review.
3. **Stop** — if no scope is found, ask: "Which package or folder should I review? Provide a path like `packages/growth` or specify the repository root for a full review."

Read the project's domain glossary (`CONTEXT.md` or `UBIQUITOUS_LANGUAGE.md`) and any ADRs in the area you're touching first.

Then explore the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file into `docs/reviews/architecture/`. Derive the subfolder name from the relative path of the reviewed module folder, converted to kebab-case and lowercased (for example, `packages/agent-gate` becomes `packages-agent-gate`). Name the file `arch-[YYYY-MM-DD]-[HH]-<short-desc>.html`.

If the review target is the repository root, use `root` as both the subfolder and the `<short-desc>`.

See `html-report.md` for the full HTML scaffold, diagram patterns, and styling guidance.

For each candidate, render a card with:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram** — side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

Use domain glossary vocabulary for the domain, and the deep-module vocabulary for the architecture. If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card.

Do NOT propose interfaces yet. After the file is written, ask the operator: "Which of these would you like to explore?"

### 3. Grilling loop

Once the operator picks a candidate, run the `grilling` skill to walk the design tree — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept not in the domain glossary?** Add the term. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update the glossary right there.
- **Operator rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: "Want me to record this as an ADR so future architecture reviews don't re-suggest it?" Only offer when the reason would actually be needed by a future explorer.
- **Want to explore alternative interfaces for the deepened module?** Use the design-it-twice parallel sub-agent pattern from `design-it-twice.md`.

## Constraints

- **Document-only.** This skill produces HTML reports and domain glossary updates — it does not modify source code.
- **Use the deep-module vocabulary exactly.** Don't substitute "component," "service," "API," or "boundary." See `architecture-vocabulary.md`.
- **Commit only your own files.** Stage only the HTML report and glossary updates. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
