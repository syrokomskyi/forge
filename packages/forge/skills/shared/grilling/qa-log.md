<!-- knowledge-layer: L0 -->

# Q&A Log (L0)

Append-only log of questions asked and answers given during grilling sessions. Used for meta-analysis to distill recurring decision patterns.

### K-0001: Entry format for L0/L1/L2 knowledge records

```knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Entry format for L0/L1/L2 knowledge records?
- **Answer:** Markdown files with per-entry YAML metadata blocks (human-readable, grep-able, parseable); soft migration for existing freeform entries.

### K-0002: How to define and enforce layer token budgets

```knowledge-entry
id: K-0002
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** How to define and enforce layer token budgets?
- **Answer:** Hard defaults in forge (L2 hot ~4KB, L1 warm ~8KB, L0 cold unbudgeted), optional override in forge.yaml bindings; warning on exceed, not error.

### K-0003: Where does AI distillation L0→L1/L2 live

```knowledge-entry
id: K-0003
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Where does AI distillation L0→L1/L2 live?
- **Answer:** New skill fo-knowledge-distill alongside deterministic forge.skill.knowledge.compact command; code mutates metadata, agent distills meaning.

### K-0004: Should .agents/memory/ be versioned in git

```knowledge-entry
id: K-0004
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Should .agents/memory/ be versioned in git?
- **Answer:** Hybrid — MEMORY.md (curated) versioned, daily logs git-ignored.

### K-0005: Schema extension before logic that depends on new fields

```knowledge-entry
id: K-0005
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (cross-skill knowledge promotion)
- **Question:** RFC proposes a new metadata field (promotedFrom) but the underlying schema (RFC-0660) doesn't define it. Where should schema extension live in the plan?
- **Answer:** Schema extension must be a separate step before any logic that creates or reads the field. Zod safeParse silently strips unknown fields; the serializer uses a fixed FIELD_ORDER array. Without extending both, the field is lost on parse and never written on serialize.

### K-0006: Doctor check status for informational warnings

```knowledge-entry
id: K-0006
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (knowledge-duplicate doctor check)
- **Question:** RFC says "informational warnings, never affects exit status." Should the doctor check use status "pass" or "warn"?
- **Answer:** Use "warn" when duplicates found, "pass" when none. Only "fail" affects exit status. "warn" makes duplicates visible in doctor summary (N warn(s)) and --json output, consistent with RFC-0661 SKILL-21 budget warnings. "pass" always would hide duplicates in the summary.

### K-0007: Validating non-skill knowledge files in doctor

```knowledge-entry
id: K-0007
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (shared knowledge layer validation)
- **Question:** The shared knowledge layer file is not inside a skill directory (no SKILL.md). Existing checks (checkLegacyKnowledgeSections, checkKnowledgeBudgets) and forge.skill.validate (SKILL-19/SKILL-20) discover knowledge files only through the skill registry. How to validate it?
- **Answer:** Add a dedicated checkSharedKnowledgeFile() in doctor.ts that parses the shared file via parseKnowledgeFile and checks SKILL-19 (schema validity) and SKILL-20 (id uniqueness) directly. A skill-wrapper would misrepresent the shared layer as a skill; skipping validation leaves schema violations undetected.

### K-0008: Dogfood criterion when no real duplicates exist

```knowledge-entry
id: K-0008
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (dogfood acceptance criterion)
- **Question:** RFC requires "at least one real duplicate pair promoted end-to-end" but the current monorepo has very few L2 entries across skills. Real duplicates are unlikely. How to handle the dogfood criterion?
- **Answer:** Conditional dogfood: run detection on the monorepo. If duplicates found, promote with operator approval. If none found, the detection pipeline running end-to-end (detection → doctor report → zero duplicates) serves as evidence. Promotion mechanics are verified by unit tests. Creating artificial test duplicates is not natural and would not test the real promotion path.

### K-0009: Certification semantics for missing or stale evidence

```knowledge-entry
id: K-0009
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** How should release certification represent required evidence that is absent, outdated, or belongs to a different commit, configuration, or toolchain?
- **Answer:** Certification uses explicit `pass`, `fail`, `incomplete`, and `stale` states. Missing evidence must never be synthesized as success. Local authoring may continue with `incomplete` evidence so that content creation remains possible, but Alt/Main transitions require `pass`; `fail`, `incomplete`, and `stale` all block publication.

### K-0010: Identity of the certified release candidate

```knowledge-entry
id: K-0010
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** What exact object receives a readiness certificate?
- **Answer:** Certification applies to an immutable release candidate, not to a site in general, a branch, a mission, or a URL. The identity binds at least `systemId`, `releaseId`, exact source commit, content and build-artifact hashes, configuration/policy/toolchain versions, and the evidence environment. Dev, Alt, and Main promote the same artifact without rebuilding; any bound-identity change invalidates the certificate and requires a new candidate and fresh evidence.

### K-0011: Ownership boundary for release certification

```knowledge-entry
id: K-0011
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** Should release certification belong to the stack-agnostic Werkstatt engine or to the site plugin?
- **Answer:** The engine owns the certificate schema and lifecycle, candidate identity checks, storage, invalidation, and promotion enforcement. The one active stack plugin supplies the required-evidence profile and evidence producers. Universal integrity, provenance, freshness, and completeness rules stay in the engine; site-content, accessibility, SEO, Lighthouse, visual, and Astro-specific checks stay in `@warpgogol/werkstatt-site`. Existing closed `checkGate` and `releaseEvidence` plugin hooks must be used strictly or superseded explicitly rather than bypassed with an ad hoc sixth hook.

### K-0012: Stage-specific decisions in one append-only certification dossier

```knowledge-entry
id: K-0012
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** Should certification be one final flag, separate certificates per channel, or one dossier with stage-specific gate decisions?
- **Answer:** Each immutable release candidate has one append-only certification dossier containing immutable, environment-bound evidence records and separate `dev-deploy`, `propagate-alt`, and `promote-main` decisions. Every decision uses `pass`, `fail`, `incomplete`, or `stale`; only the current `pass` for the relevant gate permits its transition. Re-runs append evidence and a new decision instead of overwriting history, while later gates may consume the required earlier evidence chain.

### K-0013: Versioned certification profile as the normative gate policy

```knowledge-entry
id: K-0013
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** What is the authoritative source for the required checks at each certification gate?
- **Answer:** Each stack plugin supplies one declarative, versioned certification profile as the sole normative source for gate composition. Every requirement has a stable id, applicability, gate placement, required/conditional/advisory classification, expected evidence type and producer, permitted environment, freshness and candidate-binding rules, timeout/retry policy, recovery diagnostic, and normative RFC/DNA/spec reference. The engine rejects structurally invalid profiles, and the profile hash is bound into candidate identity so policy cannot change invisibly after evidence collection.

### K-0014: Deterministic aggregation of certification requirements

```knowledge-entry
id: K-0014
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** How should individual requirement outcomes aggregate into a stage-gate decision?
- **Answer:** Applicability is evaluated explicitly; a conditional requirement that does not apply records `not-applicable` plus its reason. Fresh required failures produce `fail`; candidate/policy identity mismatches produce `stale`; missing evidence, timeouts, producer crashes, infrastructure unavailability, malformed output, or unclassified results produce `incomplete`. A gate passes only when every applicable required requirement has a current `pass`; advisory results remain visible but do not change status. Mixed problems use top-level precedence `fail` → `stale` → `incomplete` → `pass`, while all non-pass states block Alt/Main.

### K-0015: Agent-only independent qualitative evaluation

```knowledge-entry
id: K-0015
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** If the authoring agent cannot approve its own qualitative work and the workflow uses agents only, who supplies approval evidence?
- **Answer:** A separate read-only Evaluator Agent run, with a clean context and a versioned rubric, evaluates rendered pages, screenshots, source content/claims, and the business brief and emits structured qualitative evidence. The deterministic Certification Engine—not the evaluator—computes the gate decision. One evaluator is sufficient for ordinary releases; critical or borderline cases require consensus from two independent evaluator runs. The process requires no human approver, and the authoring agent cannot submit its own approving qualitative evidence.

### K-0016: No agent waivers for required certification requirements

```knowledge-entry
id: K-0016
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** May an agent bypass, suppress, or downgrade a required certification requirement to promote a new release?
- **Answer:** No runtime agent waiver exists for required Alt/Main requirements: no force, skip-gate, grace-period, or automatic required-to-advisory downgrade. Suppressions apply only to advisory diagnostics. A required false positive must be fixed in its producer or through a normative, versioned certification-profile change that invalidates prior evidence and triggers recertification. Infrastructure unavailability remains `incomplete`. The only bypass-like operation is rollback to a previously certified immutable artifact, which is recovery rather than promotion of a new candidate.

### K-0017: Mandatory quality dimensions for the site certification profile

```knowledge-entry
id: K-0017
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, site certification profile v1
- **Question:** Which quality dimensions must the first site certification profile cover before Main promotion?
- **Answer:** The profile must cover nine dimensions: candidate integrity; business truth and compliance; editorial quality and localization; information architecture and discoverability; UX and conversion; visual quality and accessibility; performance and runtime correctness; security and operational readiness; and independent qualitative evaluation. Each dimension must have at least one applicable required evidence item before Main. A genuinely irrelevant dimension requires explicit, verifiable `not-applicable` evidence; silent omission is invalid.

### K-0018: Stage placement of site certification evidence

```knowledge-entry
id: K-0018
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, site certification profile v1
- **Question:** How should required evidence be distributed across Authoring, Dev, Alt, and Main?
- **Answer:** Authoring may remain `incomplete`. The `dev-deploy` gate requires a pass for all pre-deploy evidence available from immutable source/content/artifact identity, build, schemas, business truth, authored content, and static safety contracts. Dev then produces rendered, browser, integration, performance, accessibility, and independent-evaluator evidence; `propagate-alt` requires all nine quality dimensions covered from Dev. Alt rechecks environment-dependent URL/DNS/routes, headers, integrations, runtime, screenshots, and qualitative evidence; `promote-main` reuses still-current environment-independent evidence and requires current Alt evidence for environment-dependent requirements. Cross-environment reuse is forbidden unless the profile explicitly classifies the evidence as environment-independent.

### K-0019: Transactional Main verification and automatic rollback

```knowledge-entry
id: K-0019
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** What should happen when required checks can only run after Main traffic is switched?
- **Answer:** Main promotion enters `main-verifying`, preferably after isolated slot/preview verification, and becomes `main-certified` only after required Main smoke, build-identity, critical route/form, header, and health evidence passes. Any required `fail`, `stale`, or `incomplete` invalidates the promotion and automatically rolls traffic back to the last immutable `main-certified` artifact. The restored version receives its own health verification and incident evidence. Missing prior certified artifacts or failed rollback produces a critical incident and must never be reported as successful publication.

### K-0020: Provenance and tamper evidence for certification records

```knowledge-entry
id: K-0020
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** What provenance and integrity guarantees must every certification evidence record provide?
- **Answer:** The engine defines one `EvidenceEnvelope@1` containing requirement/candidate/environment identity, registered producer identity plus version/source hash, run and timestamp data, normalized input hashes, status, diagnostics, payload/artifact hashes, and redaction metadata. Producers submit results through the engine rather than writing dossiers directly. Evidence is content-addressed, appended through a hash-chained manifest, and every gate decision records the evidence IDs and resulting dossier-root hash. Remote producers use registered workload-identity attestations; local results receive an engine attestation bound to command and module hash. Manual files, unknown producers, broken signatures/chains, or unsafe secret-bearing payloads cannot certify a gate.

### K-0021: Location-independent dossier identity with durable replication

```knowledge-entry
id: K-0021
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** Where is the authoritative certification dossier stored, and what durability is required before promotion?
- **Answer:** The logical dossier is identified by its root hash rather than by a filesystem path or bucket. Authoring and Dev use a local content-addressed cache; before Alt the complete dossier must be replicated through a provider-neutral adapter to a durable object store (R2 may be the current adapter). Uploads require read-after-write size/digest verification and immutable digest keys. Alt/Main require a verified durable replica, while release state stores the root hash and safe locators only. Local loss is recoverable from durable storage; missing or unavailable durable evidence produces `incomplete`.

### K-0022: Retention tiers for certification evidence

```knowledge-entry
id: K-0022
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, release certification module
- **Question:** How long must certification records and heavy evidence artifacts be retained?
- **Answer:** Compact audit records—candidate identity, profile, decisions, metadata/digests, diagnostic summaries, incidents, and rollback chain—are retained indefinitely. Full `main-certified` dossiers remain while active or rollback-eligible plus 24 months after supersession; unsuccessful-candidate evidence remains 180 days. Heavy screenshots/video/traces/full logs remain 12 months for certified releases and 90 days for unsuccessful runs. Current releases, rollback targets, open incidents, and audit holds are exempt from garbage collection. Payload deletion appends a hash-chained tombstone with digest, reason, policy version, and timestamp.

### K-0023: Clean single-site republish instead of legacy migration

```knowledge-entry
id: K-0023
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, certification rollout
- **Question:** How should the existing production estate migrate when this workshop operates only one site and can republish it?
- **Answer:** Use a clean republish rather than generic legacy infrastructure. Keep the current site serving during rollout without labeling it certified; do not import old evidence or add bootstrap/legacy commands. Create a fresh candidate from current source, run the complete Dev → Alt → Main certification chain, and switch atomically or through an isolated slot. Remove the transition mode after the first `main-certified` release. Activate the new gate and remove the old grace behavior only after all required producers, evaluator agents, and durable storage are operational.

### K-0024: Post-cutover removal of bulky legacy operational artifacts

```knowledge-entry
id: K-0024
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, single-site cleanup
- **Question:** May old release and archived-mission data be removed to simplify the clean cutover?
- **Answer:** Yes, through a separate post-cutover cleanup RFC after the active mission is archived and the first new release is `main-certified`. Preserve compact immutable audit history—IDs, states, commit hashes, relationships, digests, Bordbuch, git history, normative documents, transcripts, manifests, and material incident/validation/close reports—while removing obsolete workpieces, heavy evidence/snapshots, staging directories, and old release payloads. Cleanup must use a dedicated idempotent command with dry-run, exact allow-list, mirror/source verification, tombstones, and a final report; never manual recursive deletion.

### K-0025: Automatic idempotent certification orchestration in deploy transitions

```knowledge-entry
id: K-0025
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, certification operator UX
- **Question:** Should agents run certification manually before deployment, or should deployment transitions orchestrate it automatically?
- **Answer:** Deployment transitions automatically invoke their certification gate through one goal-oriented `release.certify --release=<id> --gate=<dev-deploy|propagate-alt|promote-main>` entrypoint. The run executes only missing/stale producers, accepts evidence, evaluates the decision, syncs the dossier, is idempotent and resumable, and uses one release+gate lock. Explicit `release.certify` remains available for early checks, while deployment always re-verifies the current decision and dossier hash. Read-only status, integrity verification, and profile validation commands provide inspection; no deploy bypass flags exist.

### K-0026: Read-only certification with agent-ready remediation packs

```knowledge-entry
id: K-0026
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, certification remediation UX
- **Question:** May certification mutate the candidate to repair failures, and what output must a non-pass result provide?
- **Answer:** Certification is read-only with respect to source, content, and build artifacts and writes only dossier, telemetry, and reports. Every non-pass produces canonical `CertificationActionPack@1` tasks classified as product fix, infrastructure retry, or policy defect. Tasks contain stable requirement/dimension/gate identity, priority and dependencies, blocking rationale, precise evidence and file/URL/DOM/screenshot anchors, bounded repair instructions, and exact verification commands; JSON is canonical and Markdown/HTML are projections. Product fixes create a new candidate and dossier, infrastructure retries may resume the same candidate, and policy defects require a separate normative profile/producer change.

### K-0027: Risk-based routing for independent evaluator agents

```knowledge-entry
id: K-0027
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, qualitative certification
- **Question:** Which releases require one evaluator versus two, and how is evaluator disagreement handled?
- **Answer:** Ordinary changes require one isolated evaluator. Critical changes require two isolated evaluator runs with distinct evaluator identities and, where possible, different model families/providers; critical includes the first certified cutover and changes to business identity/offerings/prices/claims, legal/privacy/data collection, auth/payments/forms/integrations, locales, site-wide navigation/layout/CTA, public agent/action surfaces, security headers, or DNS. Borderline confidence/threshold/ambiguity or high-severity advisory outcomes automatically trigger a second evaluator. Evaluators cannot see each other's outputs. Two passes yield pass, two failures yield fail, and disagreement, missing evaluation, or insufficient independence yields `incomplete`. Risk rules and thresholds live in the versioned profile.

### K-0028: Continuous certification health after Main publication

```knowledge-entry
id: K-0028
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, continuous certification
- **Question:** Does `main-certified` remain valid forever, or must environment-sensitive evidence be refreshed after publication?
- **Answer:** Historical `main-certified` decisions remain immutable while a separate current `certificationHealth` state is maintained as `current`, `degraded`, or `revoked`. Environment-independent evidence remains valid until candidate/profile identity changes; DNS, external integrations, runtime, security headers, performance, and freshness use profile-defined TTLs and schedules. Monitoring appends evidence and health decisions. Non-critical non-pass outcomes degrade health, open incident/action packs, retry, and block new promotions; critical regressions revoke health. Each requirement declares `retry`, `incident-only`, or `rollback`, and rollback is forbidden when it cannot remedy a shared external outage. Passing refreshes restore `current` without erasing history.

### K-0029: Explicit immutable Main verification decision after traffic switch

```knowledge-entry
id: K-0029
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** How is the post-switch proof between a pre-switch `promote-main: pass` gate decision and the final `main-certified` state represented without overloading either the gate decision or mutable current health?
- **Answer:** Add an immutable `MainVerificationDecisionV1` dossier event. It binds the candidate, pre-switch promotion decision and dossier root, deployment operation and target slot, exact Main evidence IDs, status, rollback decision/result, and before/after dossier roots. `main-certified` is allowed only when this decision is `pass` and its resulting dossier root has a verified durable replica. Continuous health begins afterward and never substitutes for Main verification.

### K-0030: One-time bootstrap rollback target for the first certified cutover

```knowledge-entry
id: K-0030
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** How can the first clean cutover be reversible when the currently serving legacy production artifact is intentionally not retroactively certified and no previous new-system `main-certified` candidate exists yet?
- **Answer:** CERT-009 may register one exact `bootstrap rollback target` consisting of the current provider deployment snapshot or provider-native rollback slot. The target must have verified identity, availability, restoration capability, and a rehearsal before traffic switching, but it is never labeled `main-certified` and its evidence cannot satisfy any candidate gate or future promotion. It is eligible only to undo the first certified cutover. If no recoverable target can be proved, cutover remains `incomplete`. Cleanup protects it until the new candidate has a passing Main verification decision, a verified durable dossier, one successful continuous-health window, and a committed cutover marker; all later rollbacks require prior certified candidates.

### K-0031: Separate build identity, deployment plan, and observed environment identity

```knowledge-entry
id: K-0031
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** How should environment/configuration identity be bound without turning the identical Dev, Alt, and Main artifact into three different release candidates or allowing target drift after certification?
- **Answer:** Candidate identity contains `buildConfigHash` for build-affecting inputs and `deploymentPlanHash` for the intended adapter, channel targets/domains, binding contract, and public runtime contract. Each environment-specific evidence envelope and deployment operation separately records the actually observed `environmentIdentityHash`. A plan/observation mismatch is `stale`. Secret values are never stored or directly hashed; environment identity uses safe provider reference/version/presence metadata or a keyed non-reversible fingerprint. Thus one immutable candidate/artifact moves through all channels while deployment topology and runtime drift remain detectable.

### K-0032: Separate Certification Authority trust boundary

```knowledge-entry
id: K-0032
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** What prevents an author agent with workspace access from fabricating evidence, rewriting a local dossier and hash chain, or using certification/deployment credentials directly while keeping the workflow agent-only?
- **Answer:** Introduce a separate trusted `Certification Authority` executor. Author/evaluator agents may request producer runs and submit typed results but cannot sign decisions, append the authoritative dossier, or access authority signing, durable-write, or deployment credentials. The authority independently verifies candidate/profile/evidence, aggregates, atomically appends, durably replicates, and signs the exact decision/root/operation authorization. Deployment accepts only a current signature from the registered issuer for the exact candidate/gate/root/target. Local reports without authority are explicitly non-authoritative and open no gate. The first adapter may be a CI/Worker executor, while the engine contract remains provider-neutral; authority unavailability is `incomplete`, never a bypass.

### K-0033: Immutable policy bundle for historical certification verification

```knowledge-entry
id: K-0033
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** How can an old certification decision remain independently verifiable after the installed plugin, profile, evidence schemas, rubric, producer modules, toolchain, or authority issuer registry have changed?
- **Answer:** Candidate creation materializes a content-addressed durable `CertificationPolicyBundleV1` containing the canonical profile/resolved requirements, evidence schemas, rubric/risk/calibration manifest, producer declarations and source hashes, engine/plugin/toolchain manifests, deployment plan, retention policy, and then-current issuer public verification material. Its root hash contributes to `candidateId`. Historical verification uses this bundle rather than current installed code. Compact policy/schema/rubric/manifests/public keys are retained indefinitely; executable producer/container artifacts may follow bounded retention because cryptographic decision verification does not require re-execution.

### K-0034: Authority-ordered evidence selection with immutable evaluation cuts

```knowledge-entry
id: K-0034
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — Werkstatt quality-hardening architecture program, specification-level grilling
- **Question:** How is “newest compatible evidence” selected deterministically when producers run concurrently, retry, have clock skew, or return after a gate/health operation has already closed?
- **Answer:** Every run has `certificationOperationId`, every attempt has `producerAttemptId`, and the authority assigns each admitted evidence record a monotonic dossier `admissionSequence`. Decisions select the latest compatible record by admission sequence and freeze an `evaluationCutSequence`; producer timestamps never determine ordering. Evidence cannot be admitted into a closed operation, and late results append a late-result incident rather than shadowing evidence. New evidence requires a new immutable decision. TTL uses authority time with bounded signed producer-clock checks. Continuous monitoring also uses stable `scheduleWindowId` values so duplicate or late deliveries cannot alter another window.

### K-0035: Core owns the runtime Diagnostic schema through a forward-only cutover

```knowledge-entry
id: K-0035
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — CERT-001 RFC-level grilling, canonical diagnostic dependency
- **Question:** Where must the strict runtime schema for `Diagnostic[]` live so the stack-agnostic certification engine can validate evidence without importing or duplicating the site plugin contract?
- **Answer:** Move `diagnosticSchema`, `diagnosticEvidenceSchema`, and their inferred types into the Werkstatt engine schema layer; kernel types and the site plugin import/re-export the engine-owned contract. The migration is a forward-only clean cut: no duplicate implementation, deprecated compatibility aliases, dual-read/dual-write, or temporary success fallback. The operator accepts that the wider project may remain operationally unavailable while the full certification transition is implemented, provided every landed core contract is internally complete, type-safe, and tested.

### K-0036: Separate artifact, deployment-operation, and certification state machines

```knowledge-entry
id: K-0036
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — CERT-001 RFC-level grilling, conflicting release-state vocabularies
- **Question:** How should CERT-001 reconcile the incompatible `published/promoted`, `ready/main-deployed`, and command-written state vocabularies without continuing to conflate artifact readiness, deployment history, and production health?
- **Answer:** Replace the single overloaded release state with three contracts: `ReleaseArtifactState = prepared | ready`; append-only per-channel `DeploymentOperationState = planned | authorized | deploying | deployed | verifying | succeeded | failed | rollback-authorized | rolling-back | rolled-back`; and certification represented by immutable gate/Main decisions plus separate current health. Remove legacy deployment labels from release manifest without aliases or translation. Until CERT-007 wires the new deployment workflow, any old command that cannot operate truthfully against the new model fails closed with an explicit transition diagnostic rather than using legacy semantics.

### K-0037: Certification starts from a clean namespace and strict canonicalization

```knowledge-entry
id: K-0037
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — CERT-001 RFC-level grilling, identity canonicalization and legacy evidence
- **Question:** Must the new certification identity preserve or migrate any prior readiness/certification evidence, and should it reuse the permissive general-purpose stable JSON hash contract?
- **Answer:** No prior readiness report, test-evidence file, quality score, or release-state claim is imported or treated as authoritative certification. The new `@1` certification namespace starts clean, with no legacy readers, aliases, dual-write, or evidence migration; old material is non-authoritative history until post-cutover cleanup. Certification uses new strict `canonicalJsonBytesV1`/`canonicalJsonHashV1` APIs that reject non-JSON and ambiguous values and record `werkstatt/canonical-json@1`. Existing `stableJsonHash` behavior remains unchanged only for unrelated cache/platform consumers, preventing accidental global hash churn.

### K-0038: Decompose CERT-001 into one-session implementation RFCs

```knowledge-entry
id: K-0038
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0848 enhancement after semantic audit, implementation by less capable agents
- **Question:** Should CERT-001 remain one large implementation RFC, or be decomposed so each document can be implemented safely by a separate agent session?
- **Answer:** Keep RFC-0848 as the integration contract for CERT-001 and split implementation into three dependent RFCs: strict runtime contracts/Diagnostic ownership/canonical JSON/identity; deterministic evidence selection/aggregation/dossier/action packs; and release/deployment state replacement with the fail-closed legacy command boundary. Each child RFC must compile and pass its own tests independently. RFC-0848 completes only after all three children are implemented and its cross-module integration checks pass.

### K-0039: Supersede legacy release and deployment authority without rebuilding infrastructure

```knowledge-entry
id: K-0039
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0848 enhancement after semantic audit, clean certification reset
- **Question:** Which prior RFCs lose normative authority immediately, and which existing mechanisms remain reusable without being allowed to certify publication?
- **Answer:** RFC-0848 fully supersedes RFC-0357, RFC-0358, RFC-0608, RFC-0627, RFC-0628, and RFC-0842 because their release/deployment authority and state machines conflict with the new artifact/operation/certification separation. Diagnostic, consistency locks, fingerprinting, artifact storage, deploy adapters, freshness primitives, evidence archives, the testing pyramid, validators, and release-ready reliability remain reusable infrastructure, but none may independently authorize a deployment. Later CERT RFCs explicitly reconnect or supersede their affected authority behavior.

### K-0040: Bound deterministic certification workloads explicitly

```knowledge-entry
id: K-0040
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0848 enhancement after semantic audit, certification performance contract
- **Question:** Which hard input limits and algorithmic bounds must prevent a weak implementation from introducing unbounded or quadratic certification evaluation?
- **Answer:** A certification profile contains at most 1,000 requirements, one evaluation cut admits at most 10,000 evidence records, one action pack contains at most 1,000 tasks, and canonical JSON input is at most 8 MiB with depth at most 64. Evidence selection and aggregation must run in `O(E + R log R)` time and `O(E + R)` memory; a per-requirement full evidence scan is forbidden. Tests include a deterministic 1,000-requirement/10,000-evidence stress fixture. Limit overflow emits an explicit `incomplete` or contract diagnostic without truncation. Timing benchmarks remain advisory rather than flaky CI gates.

### K-0041: Split canonicalization, Diagnostic ownership, and certification contracts

```knowledge-entry
id: K-0041
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement after semantic audit, execution boundaries for less capable agents
- **Question:** Should RFC-0849 continue to combine canonical JSON, Diagnostic ownership, and all certification schemas/identities?
- **Answer:** No. RFC-0849 owns only bounded canonical JSON; RFC-0852 owns the forward-only engine Diagnostic cutover; RFC-0853 owns strict certification schemas and explicit identity builders. RFC-0850 and RFC-0851 depend on RFC-0853, and RFC-0848 remains the final integration boundary.

### K-0042: Canonical identity uses an engine-created immutable snapshot

```knowledge-entry
id: K-0042
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, hostile JavaScript input boundary
- **Question:** What exact value may the canonical byte/hash functions accept when arbitrary objects and Proxy traps cannot be proven stable?
- **Answer:** Only an opaque `CanonicalJsonValueV1` produced by an engine-owned snapshot builder. The builder traverses once, copies permitted data into detached structures, deep-freezes it, and registers an internal non-exported brand. External/file/network values first pass a strict schema and snapshot creation. Proxy trap failures become typed failures; the contract does not claim that JavaScript can identify every Proxy.

### K-0043: Reject lone UTF-16 surrogates before canonicalization

```knowledge-entry
id: K-0043
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, Unicode collision safety
- **Question:** How should canonical JSON handle unpaired UTF-16 surrogate code units?
- **Answer:** Reject them in every string and object key with `CERT-CANONICAL-UNICODE-01`. Valid Unicode is preserved without NFC/NFKC normalization. Collision and boundary fixtures prove distinct JavaScript strings cannot silently collapse through UTF-8 replacement behavior.

### K-0044: Persisted diagnostics are canonical and redacted by construction

```knowledge-entry
id: K-0044
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, Diagnostic identity and privacy boundary
- **Question:** Which Diagnostic fields participate in evidence identity, and how can every valid Diagnostic also be safely persisted and hashed?
- **Answer:** The complete strict Diagnostic participates in evidence identity. Remove legacy `id`, `blockId`, and `suggestion`; replace arbitrary `data` with bounded `CanonicalJsonObjectV1`; bound all strings, collections, and total encoded size; require safe relative paths and pre-redacted URLs/snippets/messages/fix hints/data; reject credentials, absolute paths, and unresolved secret/PII exposure.

### K-0045: Separate recoverable snapshot failures from total byte/hash operations

```knowledge-entry
id: K-0045
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, throw-versus-return contract
- **Question:** Where do canonicalization failures occur, and may canonical byte/hash entrypoints throw?
- **Answer:** `snapshotCanonicalJsonV1(unknown)` returns a discriminated typed result for domain, Unicode, traversal, and limit failures. `canonicalJsonBytesV1` and `canonicalJsonHashV1` are total and non-throwing over a valid branded snapshot. Explicit Zod `.parse()` may throw by its ordinary contract; recoverable public boundaries use `safeParse` or typed results.

### K-0046: Bound canonical JSON traversal as well as encoded output

```knowledge-entry
id: K-0046
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, canonicalization denial-of-service limits
- **Question:** Which structural limits supplement the existing 8 MiB/depth-64 output contract?
- **Answer:** Limit one document to 250,000 nodes, 10,000 keys per object, 100,000 items per array, 1 MiB UTF-8 bytes per string, 1 KiB UTF-8 bytes per key, depth 64, and 8 MiB canonical bytes. Enforce limits during snapshot traversal, never truncate, return `CERT-CANONICAL-LIMIT-01`, and account for byte, node, sorted-key, and depth memory explicitly.

### K-0047: Canonical identities require a closed snapshot boundary

```knowledge-entry
id: K-0047
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement grilling meta-analysis
- **Question:** Should the repeated canonicalization decisions be promoted to a reusable active L2 principle?
- **Answer:** Yes. Permanent identities must canonicalize only detached, bounded, immutable, branded snapshots; ambiguous Unicode, unstable traversal, and limit overflow are rejected before hashing, and byte/hash operations over accepted snapshots are deterministic and total.

### K-0048: Canonical JSON exposes only an object-root authority API

```knowledge-entry
id: K-0048
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement after the bounded canonical JSON audit
- **Question:** Should canonical-json@1 support scalar and array roots through an opaque wrapper, or expose only the object-root shape used by certification identities and Diagnostic data?
- **Answer:** Expose only an engine-created, runtime-branded `CanonicalJsonObjectV1` root. Nested values may use the complete accepted JSON subset, including scalars and arrays. Do not add a wrapper/unwrapping API for root shapes with no current authority consumer.

### K-0049: Canonical JSON uses a strict RFC 8785 profile

```knowledge-entry
id: K-0049
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement after the bounded canonical JSON audit
- **Question:** Should canonical-json@1 invent and freeze its own number/string/key algorithm or use RFC 8785 JCS as its normative byte foundation?
- **Answer:** Use RFC 8785 JCS as the normative byte foundation and freeze its official number vectors. Add stricter Werkstatt domain constraints: an object-only root, negative-zero and unsafe-integer rejection, hard resource limits, and detached runtime branding.

### K-0050: Canonical failure paths never expose object keys

```knowledge-entry
id: K-0050
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement after the bounded canonical JSON audit
- **Question:** How should canonical failures locate an invalid nested value without leaking a secret or personal value used as an object key?
- **Answer:** Never include raw object keys in a failure. Use array indices and deterministic object-key ordinals after JCS sorting, plus an explicit omitted-segment count for a bounded tail. Messages also omit rejected values and source keys.

### K-0051: Werkstatt targets Node 24 without a Node 22 compatibility matrix

```knowledge-entry
id: K-0051
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement, runtime reproducibility boundary
- **Question:** Should canonical vectors be verified on both Node 22 and Node 24 because the root package currently declares Node >=22?
- **Answer:** No. Move the ecosystem fully to Node 24 and retain no Node 22 compatibility contract. Canonical reproducibility is proved on the single supported Node 24 line against independent frozen RFC 8785 vectors; future runtime changes require explicit validation and migration.

### K-0052: Canonical JSON rejects unsafe integer values

```knowledge-entry
id: K-0052
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement after selecting RFC 8785 JCS
- **Question:** May canonical-json@1 accept integral IEEE-754 values outside JavaScript's safe integer range merely because JCS can serialize their resulting double deterministically?
- **Answer:** No. Reject every integral number for which `Number.isSafeInteger(value)` is false. Exact large integers, money, and decimal quantities use schema-declared strings; finite non-integral numbers remain allowed under RFC 8785 serialization.

### K-0053: Permanent formats profile standards instead of imitating them

```knowledge-entry
id: K-0053
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0849 enhancement grilling meta-analysis
- **Question:** Should the repeated decision to base permanent canonical bytes on a named external standard plus stricter local constraints become an active reusable L2 principle?
- **Answer:** Yes. Pin the exact standard and independent vectors, state local restrictions as an explicit narrower profile, and avoid maintaining an unnamed almost-equivalent permanent algorithm.

### K-0054: Agent-run Node 24 bootstrap before repository cutover

```knowledge-entry
id: K-0054
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement after the Node 24 ecosystem audit
- **Question:** May the implementing agent install and activate Node 24 on the Ubuntu host before changing repository engine enforcement, even though Werkstatt itself must not auto-download or fall back to another runtime?
- **Answer:** Yes. Runtime provisioning is an explicit step-zero environment bootstrap performed by the implementing agent before any repository mutation, not product fallback behavior. The agent re-verifies Node and pnpm under Node 24; if provisioning or verification fails, it stops without changing repository files.

### K-0055: Forge uses a real major boundary for the Node 24-only contract

```knowledge-entry
id: K-0055
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement after the Node 24 ecosystem audit
- **Question:** Which independent Forge version represents removal of Node 20/22 support, and how is it separated from publication?
- **Answer:** Bump `@warpgogol/forge` from `0.28.0` to `1.0.0`, set `forge.syncedVersion` to the same value, and require a standalone Node 24 tarball smoke test. Implementation records the version but does not publish; npm publication remains a separate explicit operator command.

### K-0056: Stage the single-site Node 24 republish through Alt

```knowledge-entry
id: K-0056
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement, current Sternsystem cutover
- **Question:** May the replaceable single site republish directly to Main, or must it prove the Node 24 build/deploy path through Alt first?
- **Answer:** Require `Alt deploy → Alt smoke pass → Main deploy → Main smoke pass`. Any non-pass stops the transition and blocks RFC completion; the single-site topology does not justify bypassing the available staging proof.
