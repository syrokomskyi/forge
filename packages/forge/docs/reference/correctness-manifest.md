# Correctness manifest reference

The correctness manifest (RFC-1578) declares what correctness means for a product in a form a machine can check. Every entry roots a check in a requirement, anchors it to an RFC-1390 code invariant, and names the oracles that check it together with the substrate they run on.

- **Schema id:** `forge/correctness-manifest@1` (capture sidecars: `forge/correctness-capture@1`)
- **Location:** `bindings.paths.correctnessManifest` in `forge.yaml` (default for new projects: `docs/correctness.yaml`; `null` = no manifest declared)
- **Validator:** `pnpm exec forge correctness.manifest.validate --json` (contract `correctness`, rules CORR-01..09, read-only)

## Anchor chain

```
requirement id / DNA-N / RFC-NNNN/AC-N / RFC-NNNN/FI-N / domain statement   (why — value)
  └─ manifest entry  CM-<scope>-<NN>  seam: data|lifecycle|provider|other
       └─ anchors: INV-<scope>-<NN>   @ai-invariant in code (RFC-1390)     (where)
            └─ checked-by: test:<path> …                                   (how)
                 └─ manifest oracle  check: test:<path>  substrate: L1     (how real)
```

An oracle is valid only when its `check` reference appears in the `checked-by` binding of at least one anchor of the same entry (CORR-05). Both sides are normalized to workspace-relative POSIX paths before comparison.

## Substrate ladder

`L0 double · L1 engine · L2 runtime · L3 live`

| Level | Name | Meaning | Example |
| --- | --- | --- | --- |
| L0 | double | mock, stub, schemaless fake | a schemaless `MockD1` — never satisfies a real-substrate minimum |
| L1 | engine | the production engine over the production schema artifact | `node:sqlite` over the real migration DDL; miniflare local D1 |
| L2 | runtime | the production runtime with real bindings, request through the real handler chain | spawned workerd / `wrangler dev`, HTTP round-trip |
| L3 | live | deployed environment or the real external provider | Workers AI, R2, a deployed Worker |

A recorded real response may stand in for L3 at L1/L2 when its capture sidecar carries provenance. A hand-written fixture never counts above L0.

## Seam-type minimums

`data → L1 · lifecycle → L2 · provider → L3 capture`

| Seam | Minimum | Catches |
| --- | --- | --- |
| `data` (SQL ↔ schema) | L1 | queries against columns no migration declares |
| `lifecycle` (state machine, ledger) | L2 | specified transitions or ledger writes that never happen |
| `provider` (external model/service contract) | L3, or L1/L2 whose declared captures are all fresh | provider output-shape drift |
| `other` | L0 allowed, reported | — |

The minimum is fixed by the seam type, not by the tier.

## Manifest source types

`req · dna · rfc-ac · fixed-input · domain`

| Source | `ref` | Resolves against |
| --- | --- | --- |
| `req` | literal `<requirement id>` | the compass doc (`bindings.paths.compassDocs`) whose `<document-id>` is `requirements` — no id pattern is imposed |
| `dna` | `DNA-N` | `## DNA-N` headings of `bindings.paths.invariantsFile` |
| `rfc-ac` | `RFC-NNNN/AC-N` | the RFC's `## Acceptance criteria` (searched in `docs/rfcs/` and `docs/rfcs/archive/**`) |
| `fixed-input` | `RFC-NNNN/FI-N` | the RFC's `## Fixed inputs` table (RFC-1455) |
| `domain` | — (needs `statement`) | a declared domain invariant |

## Example

```yaml
schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-07
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:apps/api/src/dispatch.schema.test.ts
        substrate: L1
  - id: CM-draft-01
    source: domain
    statement: "A drafting model response is accepted whether it is bare JSON, JSON wrapped in prose, or a json_schema object"
    seam: provider
    anchors: [INV-draft-01]
    oracles:
      - check: test:apps/api/src/draft-parse.test.ts
        substrate: L1
        captures: [apps/api/test/captures/workers-ai-draft-prose.json]
support:
  - vitest.config.ts
  - apps/api/test/harness/**
exemptions:
  - ref: REQ-04
    kind: deferred
    task: "verbund:T-0142"
  - ref: DNA-3
    kind: unverifiable
    reason: "Challenge pages are platform-side and cannot be provoked deterministically"
```

- Entry ids match `^CM-[a-z0-9]+(-[a-z0-9]+)*-\d{2,3}$`, are unique, and are never reused.
- `support` lists files that shape how oracles execute (runner config, setup files, harness helpers); every glob must match a file.
- `unverifiable` exemptions and new requirement text are operator decisions; agents may draft `deferred` exemptions that name a real queue task.

## Capture sidecar

Next to each capture file sits `<capture file>.capture.yaml` (the extension-less spelling `<name>.capture.yaml` is accepted too):

```yaml
schema: forge/correctness-capture@1
recordedAt: 2026-11-12T14:05:00Z
provider: workers-ai
model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
ttlDays: 30
origin: "L3 run: dialogue-steward correctness.capture 2026-11-12"
```

A capture older than `ttlDays` is a CORR-07 error; within 7 days of expiry it is a warning, so a refresh can be scheduled before the integration gate (RFC-1580) refuses.

## Correctness modes

`warn · enforce · exempt`

| Mode | Effect |
| --- | --- |
| `warn` (default) | CORR-01 and CORR-08 are warnings; every other rule is an error; exit 0 without errors |
| `enforce` | CORR-01 and CORR-08 are errors; `bindings.commands.checkRun` is required |
| `exempt` | a repository without a product runtime: no rule is evaluated, status `exempt`, exit 0; a manifest binding beside it is CORR-02 |

A product flips to `enforce` in the commit that adds its manifest. `correctness.tier` (`standard | high | formal`) is repository-level; its effect is enforced at integration by RFC-1580.

## Rules

| Rule | Severity | Condition |
| --- | --- | --- |
| `CORR-01` | error in `enforce`, warning in `warn` | manifest binding unset, file absent, or unparseable; or `bindings.commands.checkRun` unset in `enforce` |
| `CORR-02` | error | schema violation, malformed or duplicate entry id, `domain` entry without `statement`, non-`domain` entry without `ref`, `support` glob matching nothing, invalid `mode`/`tier`, `exempt` with a manifest binding |
| `CORR-03` | error | `ref` does not resolve |
| `CORR-04` | error | an anchor id is declared by no `@ai-invariant[…]`, or is declared without a `checked-by` binding |
| `CORR-05` | error | an oracle `check` is not named in the `checked-by` binding of any anchor of its entry, or is not an RFC-1390 binding reference |
| `CORR-06` | error | an entry's best oracle substrate is below its seam minimum |
| `CORR-07` | error; warning within 7 days of expiry | a `provider` entry's capture is missing, lacks a sidecar or provenance fields, or is older than `ttlDays` |
| `CORR-08` | error in `enforce`, warning in `warn` | a requirement id or DNA id is referenced by no entry and listed in no exemption; a missing requirements document is a warning |
| `CORR-09` | error | an exemption is malformed: `unverifiable` without `reason`, `deferred` without `task`, or a ref that resolves to no requirement or DNA id |

Anchors are read from `docs/invariants.generated.yaml` (RFC-1390 `compass.invariants.generate`) when it is not older than any scanned source file; otherwise source files are scanned with the forge RFC-1390 parser.

## Promoted acceptance criteria

An RFC frontmatter may carry `promotes: [AC-N, …]` naming criteria that describe lasting behaviour. `rfc.validate` reports V-55 when a listed id is not one of the RFC's criteria. In a project with a manifest binding, `rfc.implement.stamp` refuses (RFC-IMP-16) while a promoted criterion has no entry with `source: rfc-ac` and `ref: RFC-NNNN/AC-N`; without a binding RFC-IMP-16 is a warning. One-off criteria (a command is registered, a file exists) are not promoted.
