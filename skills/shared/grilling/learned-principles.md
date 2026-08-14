# Learned Principles (L2)

Concrete principles distilled from past grilling sessions. Each principle has a condition and a recommended answer. The skill checks these before asking the operator.

<!-- Entries are appended by the skill after meta-analysis and operator approval. -->
<!-- Format:
## <principle title>
- **Condition:** <when this applies>
- **Recommended answer:** <what to recommend>
- **confirmations:** <N>
- **Added:** <date>
-->

### K-0001: Extend infrastructure before feature logic

```knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

- **Condition:** Plan grilling reveals that a feature depends on a schema field, serializer entry, or validation path that doesn't exist in the underlying module yet.
- **Recommended answer:** Add a separate plan step to extend the infrastructure (schema, serializer, validator) before any step that creates or reads the new field/path. Zod safeParse silently strips unknown fields; fixed-order serializers skip unknown fields. Without the extension step, data is silently lost.

### K-0002: Unknown is not green

```knowledge-entry
id: K-0002
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A readiness, quality, safety, or compliance decision depends on evidence that may be missing, stale, malformed, unclassified, or unavailable.
- **Recommended answer:** Represent uncertainty explicitly and fail closed at consequential transitions. Never synthesize success from absence, fallback stubs, grace periods, timeouts, or infrastructure failure.

### K-0003: Quality claims bind to immutable identity

```knowledge-entry
id: K-0003
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A system certifies, approves, tests, scores, or otherwise makes a durable claim about an artifact.
- **Recommended answer:** Bind the claim to the exact source, content, artifact, configuration, policy, and toolchain identity. Any bound-identity change invalidates the claim and requires a new candidate and evidence chain.

### K-0004: Evaluation must not mutate its subject

```knowledge-entry
id: K-0004
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A gate, evaluator, audit, or certification process discovers a defect in the artifact it is judging.
- **Recommended answer:** Keep evaluation read-only with respect to the judged artifact. Emit anchored remediation tasks; perform fixes in a separate authoring flow that produces a new artifact identity and new evidence.

### K-0005: Immutable history and current health are separate

```knowledge-entry
id: K-0005
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A past decision must remain auditable while real-world conditions can change after that decision.
- **Recommended answer:** Preserve historical decisions and evidence as append-only records. Compute current health as a separate projection over later evidence and events; never rewrite the historical decision to imitate present state.

### K-0006: Migration complexity follows the real estate

```knowledge-entry
id: K-0006
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A migration design is accumulating compatibility paths for hypothetical consumers or legacy estates that do not exist in the actual deployment scope.
- **Recommended answer:** Prefer the smallest safe migration that fits the real estate. For a replaceable single target, use a clean cutover and preserve only the audit history that remains valuable; do not build generic legacy infrastructure without a concrete consumer.

### K-0007: Integrity requires an independent authority

```knowledge-entry
id: K-0007
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** An agent or process that creates an artifact can also write its evidence, recompute its hash chain, or access the credentials that authorize the consequential transition.
- **Recommended answer:** Put authoritative append, signing, and operation authorization behind a separate least-privilege authority boundary. A self-consistent hash chain detects corruption only relative to a trusted root; it does not prove who was entitled to issue that root.

### K-0008: Historical verification preserves policy bytes

```knowledge-entry
id: K-0008
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A durable decision depends on schemas, policy rules, rubrics, producer declarations, toolchains, or issuer material that can change after the decision.
- **Recommended answer:** Store the exact semantic policy inputs as a content-addressed immutable bundle and bind its root to the decision subject. A hash or version string without the hashed bytes is insufficient for independent historical interpretation and verification.

### K-0009: Distributed evidence uses authority order and immutable cuts

```knowledge-entry
id: K-0009
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** Concurrent, retried, remote, or scheduled producers can return out of order, with clock skew, duplication, or after a decision has already been made.
- **Recommended answer:** Order admitted results by a monotonic authority sequence and freeze every decision at an explicit evaluation cut. Producer timestamps describe observation and freshness, never precedence; late results create a new decision or incident instead of changing history.

### K-0010: Bootstrap safety does not create legacy authority

```knowledge-entry
id: K-0010
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A clean migration needs a recovery path to pre-migration state, but importing or retroactively approving that state would undermine the new authority model.
- **Recommended answer:** Permit an exact, narrow, one-time rollback-only bootstrap target with explicit closure conditions. Never let bootstrap evidence satisfy forward gates, acquire the new certified status, or survive as an indefinite compatibility path.

### K-0011: Documents are execution boundaries

```knowledge-entry
id: K-0011
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** An implementation document is expected to be executed by a less capable agent in one isolated session, but its scope combines several independently testable architectural changes.
- **Recommended answer:** Decompose the work into dependency-ordered documents that each leave the affected packages compiling and pass their own bounded validation. Keep a final integration document for cross-module laws instead of making one agent carry the whole program at once.

### K-0012: Supersede decision authority, preserve useful mechanisms deliberately

```knowledge-entry
id: K-0012
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A new authority model replaces older normative decisions while some underlying storage, hashing, validation, transport, or adapter mechanisms remain technically useful.
- **Recommended answer:** Supersede the old contract's right to authorize outcomes and state explicitly which mechanisms remain reusable but non-authorizing. Never let retained infrastructure imply that the old decision path is still valid.

### K-0013: Deterministic aggregators need scale contracts

```knowledge-entry
id: K-0013
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A deterministic evaluator, selector, or aggregator consumes potentially growing collections and its result gates a consequential transition.
- **Recommended answer:** Specify hard input limits, time and memory complexity, and a deterministic stress fixture. Reject overflow explicitly without truncation or synthesized success, and forbid nested full scans when an indexed or single-pass design is available.

### K-0014: Canonical identities require a closed snapshot boundary

```knowledge-entry
id: K-0014
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A JavaScript value contributes to a durable content identity, authority decision, signature payload, or append-only history.
- **Recommended answer:** Convert untrusted input first into a bounded, detached, immutable, engine-branded canonical snapshot. Reject ambiguous Unicode, unstable traversal, non-canonical values, and limit overflow before hashing. Keep canonical byte/hash operations deterministic and total over accepted snapshots rather than traversing arbitrary caller-owned objects.

### K-0015: Permanent formats profile standards instead of imitating them

```knowledge-entry
id: K-0015
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** An internal permanent byte, signature, identity, or interchange format substantially overlaps a mature external standard.
- **Recommended answer:** Name and pin the exact standard plus independent conformance vectors, then define project-specific restrictions as an explicit narrower profile. Do not create an unnamed almost-equivalent algorithm whose compatibility and edge cases the project must maintain alone.

### K-0016: Cutover enforcement starts after executor bootstrap

```knowledge-entry
id: K-0016
layer: L2
created: 2026-08-14
lastConfirmedAt: 2026-08-14
confirmations: 1
status: active
```

- **Condition:** A cutover removes an old runtime or toolchain and introduces fail-closed enforcement while the executor environment still uses the old version.
- **Recommended answer:** Provision and verify the executor environment before any repository mutation, then enable the new enforcement. If bootstrap fails, stop with a clean repository. Explicit environment provisioning is not a product fallback or compatibility path.
