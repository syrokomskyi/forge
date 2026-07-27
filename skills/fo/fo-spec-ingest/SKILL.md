---
name: fo-spec-ingest
description: Ingest an external specification package into docs/specs/ or author a spec skeleton from fo-idea escalation. Builds forge-spec.yaml, validates, grills the spec delta, and obtains operator acceptance.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.specValidate]
  optional: [paths.invariantsFile]
triggers: ["ingest external specification", "vendor spec package into docs", "author spec skeleton"]
---

# Spec Ingest

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

> **This is a document-only skill.** It produces files under `docs/specs/<id>/` — snapshot, `forge-spec.yaml`, `integrity.yaml`, and `amendments/`. It must never modify source code in `apps/`, `packages/`, `services/`, or any other directory.

## Two modes

### Ingest mode

Invoked as `/fo-spec-ingest <path-to-package>` when the operator has an external specification package (e.g. a consultant deliverable, an Obsidian vault export).

### Authoring mode

Invoked inline by `fo-idea` when decomposition yields more than 7 atomic decisions with at least one dependency edge. The skeleton is built from `fo-idea`'s decomposition + grilling output instead of an external package.

## Process (ingest mode)

### 1. Locate and inventory the package

List all files in the package directory. Identify candidate roles by filename and headings:

- **Spec / overview** — README, index, overview
- **Entity model** — files with "entity", "model", "schema", "field" in name or headings
- **Roadmap** — files with "roadmap", "plan", "wave", "stage", "phase" in name or headings
- **Decision log** — files with "decision", "adr", "architecture" in name or headings

Facts are looked up from the files. Only ambiguous role mappings become operator questions — one at a time, recommended answer first.

### 2. Choose spec-id

Propose a kebab-case `spec-id` from the package title. Ask the operator to confirm.

### 3. Vendor the snapshot

Copy files byte-exact into `docs/specs/<id>/`. Generate `integrity.yaml` with SHA-256 hashes for every snapshot file (excluding `forge-spec.yaml`, `integrity.yaml`, and `amendments/**`). Create an empty `amendments/` directory.

### 4. Build forge-spec.yaml

Extract from the package documents:

- `documents` — logical name → relative path mapping
- `decisions[]` — id, title, status, rationale (from the decision log)
- `rfcs[]` — id, title, dependsOn, wave, sources (from the roadmap)
- `waves[]` — id, name, goal

Where the package predefines an RFC granularity that mismatches repository practice, you MAY merge nodes — but MUST respect any explicit "do not combine" constraints in the package, and MUST record every merge as a mapping note in the node's title suffix `(merges <id>, <id>)`.

### 5. Validate

Run `ref(forge.yaml bindings.commands.specValidate) --spec=<id>`. Fix projection errors until clean. **Never touch snapshot files** — if the package itself is inconsistent (e.g. a real dependency cycle), record the finding and ask the operator.

### 6. Spec-level grilling

Invoke `/grilling` to stress-test the spec delta against the project:

- Conflicts with the invariants file (`ref(forge.yaml bindings.paths.invariantsFile)`)
- Forward-only violations
- Storage policy conflicts
- Naming collisions
- Unrealistic dependencies

If `ref(forge.yaml bindings.paths.invariantsFile)` is `null` or the file is absent, skip the DNA-alignment part and report `Degraded: invariantsFile not configured — DNA alignment skipped`.

Findings that require spec changes are recorded as **pre-acceptance amendments** in `amendments/` (RFC-XXXX format). The snapshot stays immutable even before acceptance.

### 7. Acceptance decision

Present a compact summary:

```
## Spec Ingest Summary

### Spec: <id> (<title>)
### Snapshot: <N> files vendored, integrity manifest written
### Projection: <N> decisions, <N> roadmap nodes, <N> waves
### spec.validate: pass
### Spec-level grilling: <N> findings, <N> pre-acceptance amendments
### Degraded: <none | list of skipped capabilities>
### Acceptance: accepted by human:<handle> | declined (status: vendored)
### Next step: /fo-spec-materialize <id>
```

Ask the operator to accept or decline.

- **On acceptance**: set `status: accepted`, `reviewers: [human:<handle>]` in `forge-spec.yaml`.
- **On decline**: leave `status: vendored` and stop.

### 8. Commit

Commit with message `spec: ingest <id> …` staging only `docs/specs/<id>/**`.

### 9. Report

Present the summary above as the final report.

## Process (authoring mode)

Steps 2, 4–9 with the skeleton built from `fo-idea`'s decomposition + grilling output instead of an external package. `documents` may be empty. Set `sourceNote: "authored in-repo via fo-idea escalation"`.

## Failure modes

- Package path unreadable or empty: stop before touching `docs/specs/`.
- `spec-id` already exists in `docs/specs/`: stop; re-vendoring is RFC-XXXX's `@N+1` path.
- `spec.validate` cannot pass by projection fixes alone: record the finding, ask the operator — amend at ingest or abort.
- Operator declines acceptance: spec stays `vendored`; materialization refuses non-accepted specs.

## MUST NOT

- MUST NOT set `status: accepted` without an explicit operator acceptance in the session.
- MUST NOT modify snapshot files during ingest, including "obvious typo fixes" — pre-acceptance amendments are the only correction channel.
- MUST NOT ask mapping questions about anything derivable from the package files.
- MUST NOT record node merges silently — every merge must be noted in the node's title.
