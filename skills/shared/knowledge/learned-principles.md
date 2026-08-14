<!-- knowledge-layer: L2 -->

# learned-principles.md (shared)

Promoted cross-skill principles. Entries are added by `fo-knowledge-distill` under operator grilling — never edited directly. Each entry uses `shared/K-NNNN` as its citation id.

### K-0001: Durable decisions are fail-closed and identity-bound

```knowledge-entry
id: K-0001
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 4
promotedFrom: [grilling/K-0002, grilling/K-0003, grilling/K-0005, grilling/K-0008]
status: active
```

- **Condition:** A consequential durable decision depends on evidence, policy, or artifact state that may later change or become unavailable.
- **Recommended answer:** Represent missing, stale, malformed, or unavailable evidence explicitly and fail closed. Bind the decision to immutable subject and policy bytes, preserve its evidence as append-only history, and calculate current health separately rather than rewriting the historical result.
### K-0002: Integrity requires authority ordering

```knowledge-entry
id: K-0002
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 2
promotedFrom: [grilling/K-0007, grilling/K-0009]
status: active
```

- **Condition:** Evidence or events may be produced concurrently, retried, submitted by the artifact author, delivered out of order, or received after a decision closes.
- **Recommended answer:** Admit evidence through a separate least-privilege authority that assigns a monotonic sequence and freezes every decision at an explicit evaluation cut. Producer timestamps never determine precedence, self-authored consistency is not authority, and late results create a new decision or incident instead of rewriting history.
### K-0003: Forward-only cutovers preserve recovery, not legacy authority

```knowledge-entry
id: K-0003
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 5
promotedFrom: [grilling/K-0001, grilling/K-0006, grilling/K-0010, grilling/K-0012, grilling/K-0016]
status: active
```

- **Condition:** A forward-only transition replaces an authority model, runtime, toolchain, or deployment contract while still requiring prerequisites and a recoverable first cutover.
- **Recommended answer:** Provision and verify the required executor and infrastructure before activating enforcement. Then supersede the old authority through the smallest complete cutover that fits the real estate. Preserve useful old mechanisms only as explicitly non-authorizing infrastructure; permit a narrow, one-time rollback target with explicit closure conditions, never an indefinite compatibility path.
### K-0004: Evaluation must not mutate its subject

```knowledge-entry
id: K-0004
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 1
promotedFrom: [grilling/K-0004]
status: active
```

- **Condition:** A gate, evaluator, audit, review, or certification process discovers a defect in the artifact it judges.
- **Recommended answer:** Keep evaluation read-only with respect to the judged artifact. Emit precise, anchored remediation tasks; apply fixes in a separate authoring flow that produces a new artifact identity and a new evidence chain.
### K-0005: Documents are executable boundaries

```knowledge-entry
id: K-0005
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 1
promotedFrom: [grilling/K-0011]
status: active
```

- **Condition:** A specification or implementation document will be executed by another agent—possibly less capable—in an isolated session.
- **Recommended answer:** Decompose work into dependency-ordered documents that each define their inputs, outputs, forbidden shortcuts, acceptance evidence, and bounded validation. Every document must leave its affected scope internally consistent; use a final integration document for cross-module laws instead of relying on unstated context.
### K-0006: Deterministic mechanisms require scale contracts

```knowledge-entry
id: K-0006
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 1
promotedFrom: [grilling/K-0013]
status: active
```

- **Condition:** A deterministic evaluator, selector, validator, or aggregator processes potentially growing collections and may gate a consequential transition.
- **Recommended answer:** Specify hard input limits, time and memory complexity, overflow behavior, and a deterministic stress fixture. Reject overflow explicitly without truncation or synthesized success, and forbid repeated full scans when an indexed or single-pass design is available.
### K-0007: Canonical identities use closed snapshots and named standards

```knowledge-entry
id: K-0007
layer: L2
created: 2026-08-15
lastConfirmedAt: 2026-08-15
confirmations: 2
promotedFrom: [grilling/K-0014, grilling/K-0015]
status: active
```

- **Condition:** A value contributes to a durable hash, signature, authority decision, permanent byte format, or interchange identity.
- **Recommended answer:** Convert untrusted input into a bounded, detached, immutable canonical snapshot before hashing. Reject ambiguous values, Unicode hazards, unstable traversal, and limit overflow. Base permanent bytes on an exact named standard with independent conformance vectors, expressing project rules as an explicit narrower profile rather than an almost-equivalent private algorithm.
