# Compass docs corpus

The Compass docs corpus is a small set of machine-readable XML documents that gives AI agents a semantic layer over the repository: _what reads X, what breaks if I change Y_ — without a full re-scan.

Canonical documents (default layout, all under `docs/`):

| Document | Status on scaffold | Content |
| --- | --- | --- |
| `requirements.xml` | draft (TODOs) | What the repository exists to do; what "correct" is |
| `technology.xml` | active | Stack, toolchain, workspace inventory (from state) |
| `development-plan.xml` | draft (TODOs) | Durable principles and change workflow |
| `knowledge-graph.xml` | active | Workspace nodes + links (generated, merge-only) |
| `verification-plan.xml` | draft (TODOs) | Gates, commands, evidence standards |
| `source-markup.xml` | active | Compass source-markup contract (resolved policy) |

## Format contract

Every corpus document declares the schema marker inside its `<meta>` block:

```xml
<meta>
  <document-id>requirements</document-id>
  <version>1.0.0</version>
  <status>active</status>
  <schema>forge/compass-docs@1</schema>
</meta>
```

`forge/compass-docs@1` identifies the corpus format generation. Documents without the marker — or with a different schema id — still validate but earn a `COMPASS-DOC-04` warning so migration drift stays visible.

Corpus membership for that check: the six canonical basenames plus every path listed in `bindings.paths.compassDocs`. Generated non-corpus XML such as `docs/compass-inventory.xml` is never expected to carry the marker.

## Binding

The corpus lives behind `bindings.paths.compassDocs` in `forge.yaml`:

```yaml
bindings:
  paths:
    compassDocs:
      - docs/requirements.xml
      - docs/technology.xml
      - docs/development-plan.xml
      - docs/knowledge-graph.xml
      - docs/verification-plan.xml
      - docs/source-markup.xml
```

Paths may point anywhere in the workspace; `compass.docs.scaffold` maps the canonical documents onto declared paths by basename (custom layouts are honored, never rewritten). `forge doctor` reports declared-but-missing paths as invalid and emits a scaffold remediation notice; paths outside `docs/` get a convention notice.

## Commands

```sh
forge compass.docs.scaffold [--dry-run]   # materialize/merge the corpus
forge compass.docs.validate               # corpus integrity gate
```

`compass.docs.scaffold` reads the real repository state — workspace discovery, stack profile, resolved Compass policy — and:

- creates missing corpus documents from templates,
- merges **only missing workspace nodes** into an existing `knowledge-graph.xml` (authored content is never overwritten),
- writes/merges `bindings.paths.compassDocs` in `forge.yaml`,
- stays byte-stable on reruns; `--dry-run` prints the action manifest.

`compass.docs.validate` scans `docs/*.xml` ∪ the bound paths (deduplicated) and enforces:

| Rule             | Severity | Check                                                |
| ---------------- | -------- | ---------------------------------------------------- |
| `COMPASS-DOC-00` | error    | well-formed XML (tag balance)                        |
| `COMPASS-DOC-01` | error    | `<path>` references resolve under the workspace root |
| `COMPASS-DOC-02` | error    | workspace ids (`pkg-*`, `svc-*`, `app-*`) exist      |
| `COMPASS-DOC-03` | warning  | `<link>` targets resolve to nodes or files           |
| `COMPASS-DOC-04` | warning  | corpus docs carry the `forge/compass-docs@1` marker  |

`forge validate` runs the corpus validator automatically when the binding resolves non-empty and feeds errors into `allPassed`.

### Workspace id convention

Workspace node ids follow the **location** convention `COMPASS-DOC-02` enforces — the prefix names the top-level directory, not the detected workspace type:

| Location                      | Emitted id                | Example                    |
| ----------------------------- | ------------------------- | -------------------------- |
| `apps/<name>`                 | `app-<name>`              | `apps/api` → `app-api`     |
| `packages/<name>`             | `pkg-<name>`              | `packages/foo` → `pkg-foo` |
| `services/<name>`             | `svc-<name>`              | `services/x` → `svc-x`     |
| anywhere else / nested deeper | `<dir>.<…>.<name>` dotted | `tools/x` → `tools.x`      |

The prefix never comes from content detection — a worker under `apps/` still gets `app-*`, so scaffold output always validates clean. Dotted ids outside `apps`/`packages`/`services` are semantic handles: `COMPASS-DOC-02` resolves only their first two segments (or leaves unmapped prefixes unchecked), while the node's `<path>` still pins the real directory via `COMPASS-DOC-01`.


## Lifecycle opt-in

```sh
forge create --in-place --profile <profile> --compass-docs
forge init --compass-docs          # (hidden recovery command)
forge upgrade --compass-docs
```

`--compass-docs` runs `compass.docs.scaffold` after the primary operation.
When the binding resolves non-empty, `forge agents.generate` emits a
"Semantic layer — read first" block — marker-wrapped in
`<!-- forge:begin semantic-layer -->` / `<!-- forge:end semantic-layer -->` —
into the generated root `AGENTS.md` and every generated nested workspace
guide, so agents read the corpus before planning or editing code.

### Discoverability in hand-written AGENTS.md

Hand-written files are never overwritten — but they can opt in to the block.
Drop the sentinel anywhere in the file:

```md
<!-- forge:semantic-layer -->
```

The next `agents.generate` (or `upgrade`, or `doctor --fix`) expands it into
a full marker-wrapped region listing the bound corpus docs. Regions already
present are refreshed in place — a block pasted from generated output keeps
updating when `paths.compassDocs` changes. Files without the sentinel are
left untouched.

