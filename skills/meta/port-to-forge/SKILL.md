---
name: port-to-forge
description: Port reusable patterns from project work into forge — identify pattern, grill operator about portability boundaries, create RFC/ADR if needed, scaffold, implement, validate, and update registry.
invocation: user
category: meta
concerns: code-mutation
dependsOn: ['grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [paths.invariantsFile]
---

# port-to-forge

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the `my-preferences` skill semantics.

Interactive skill for porting reusable patterns from project work into forge. Process: identify pattern → grill operator about portability boundaries → create RFC/ADR if needed → scaffold via `port.scaffold` → implement → validate via `port.validate` → update registry.

## Process

### 1. Identify the pattern

Ask the operator what pattern (skill, command, or workflow) they want to port into forge.

### 2. Grill portability boundaries

Use the `grilling` skill to stress-test:

- Is the pattern truly project-agnostic? Does it reference Forge-specific concepts (cosmic names, sections, biomes)?
- Does it depend on project-specific packages (`@warpgogol/site-kernel`, `@warpgogol/ui`)?
- What are the minimal dependencies needed (ontology, fingerprint, share)?
- Should it be a skill, a command, or both?

### 3. Create RFC/ADR if needed

If the port involves architectural decisions (new package boundaries, command ownership changes), create an RFC or ADR first using `fo-idea-create-rfc` or `fo-idea-create-adr`.

### 4. Scaffold

Run `port.scaffold --name <name> --type <skill|command> --category <category>` to generate the skeleton.

### 5. Implement

Port the implementation, ensuring:

- No imports from `@warpgogol/site-kernel` or other project-specific packages.
- Use `@warpgogol/ontology` for schemas, `@warpgogol/fingerprint` for hashing, `@warpgogol/share` for fs helpers.
- Add Compass scaffolding (MODULE_CONTRACT, CHANGE_SUMMARY) to new TypeScript files.

### 6. Validate

Run `port.validate --name <name>` to verify the ported artifact has no project-specific dependencies.

### 7. Update registry

If porting a skill, add it to `packages/forge/src/registry.ts`.

### 8. Commit

```txt
forge: port <name> from project to forge

Port <name> from <source> to @warpgogol/forge — <one-line description>.
```
