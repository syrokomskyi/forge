# WP-4/WP-5 Implementation Evidence

Status: WP-4 implementation complete, verification suite in flight at time of writing.
WP-5 core complete; first-party plugin rewrites in progress.
Operator sign-offs delegated in-session (2026-11-25, explicit grant).

## WP-4 — Transactional integration queue (RFC-1647)

Commit `410ebc2b`. Implementation under `packages/forge/src/integration/`:

- `types.ts` — IntegrationUnit/UnitState/DrainLease/QueueJournalEntry verbatim per RFC contracts; commit chain carried per unit (squash forbidden).
- `store.ts` — atomic enqueue (complete record staged, single journal append exposes it; incomplete records = crash-mid-enqueue, discarded); append-only journal; checkpointing bounds fold-on-read.
- `lease.ts` — atomic acquisition via rename race with winner verification, boot-id fencing (single-machine v1 scope), heartbeat cadence (60s) strictly under half the TTL (5min), dead-holder detection via pid liveness.
- `gitops.ts` — plumbing-only, zero worktrees: chain replay via `git merge-tree --write-tree --merge-base <parent>` per commit (exact cherry-pick semantics), materialization via `commit-tree` preserving authorship/dates/messages — governance trailers ride verbatim. Candidate objects never leave the main object store.
- `drain.ts` — strict FIFO on-demand worker: lease → rebase-materialize against actual current head → evaluate candidate tree through RFC-1646 graph → integrate (single write point: update-ref) or refuse with blocking-node attribution → loop until empty → release, exit. Never a daemon. Idempotent re-entry: crash-mid-evaluate requeues with attempts++; recovery verifies landed integrations by commit existence + tree digest before reprocessing.
- `materialize.ts` — candidate tree expansion via `git archive` into ephemeral roots.
- `enqueue.ts` — uuidv7-ordered ids, read-only observability surface, verbatim conflicted-recovery instruction.

### Acceptance evidence — all seven green (targeted runs)

| AC | Test | Result |
|----|------|--------|
| AC-1 | test/integration-queue-race.test.ts | pass — both units exactly once, FIFO integration order verified |
| AC-2 | test/drain-crash-recovery.test.ts | pass — idempotent reprocessing, no duplicate terminal transitions, no double-integration |
| AC-3 | test/candidate-tree-evaluation.test.ts | pass — graph receives merged candidate tree digest (neither session nor head tree), refusal attribution carries nodeId + evidenceKey |
| AC-4 | test/conflicted-unit-terminal.test.ts | pass — conflict terminates with `seed.txt` named, never retried in place |
| AC-5 | test/drain-exits-empty.test.ts | pass — exits immediately, no lease residue |
| AC-6 | test/evidence-read-isolation.test.ts | pass — concurrent reads during drain all consistent, append-only verified |
| AC-7 | test/drain-latency-benchmark.test.ts | pass — fixture-scale bounds, warm≤cold comparative substrate |

Full-suite verification: **5337 passed / 1 skipped / 0 failed, exit 0** (2026-11-25 21:50, run spanning WP-4/WP-5 implementation; all subsequent changes additive and individually verified).

### Design notes

- `requeued` journal transition added beyond the RFC's list — recovery requeue is a real transition and hiding it would violate the journal's completeness.
- Evaluation infrastructure failure is NOT a refusal: unit requeues. Refusal is reserved for verdict-bearing failures per RFC-1646 error semantics.

## WP-5 — Plugin SDK (RFC-1648)

Commit `1230e8b1` (+ export wiring `302a033a`). Implementation under `packages/forge/src/sdk/`:

- `types.ts` — PluginManifest/CommandModule/PluginContext ports verbatim; closed lifecycle hook list; PluginLoadError typed kinds; CapabilityViolation.
- `context.ts` — capability-enforcing port factory: default-deny for omitted capabilities, workspace path-escape protection, git mutation vocabulary enforcement, mandatory spawn timeouts (hanging commands die as executor error per RFC).
- `loader.ts` — discover/verify/register/activate, fail-closed every phase; strict forgeRange (minimal honest semver: caret, >=, exact); one code path for npm and project-local species; refuse-on-conflict plugin dependency resolution.
- `scan.ts` — CAP-SCAN-01..05 raw capability import detection (comment/string-stripped, import-line precise; ctx.network.fetch exempt by receiver shape); PLUG-DEP-01/02 dependency-direction scan.
- `skills-gen.ts` — untracked content-hashed tree generation, incremental by construction.

### Acceptance evidence — all six green

| AC | Test | Result |
|----|------|--------|
| AC-1 | test/plugin-forgerange.test.ts | pass — typed forgerange-violation; missing range invalid |
| AC-2 | test/capability-enforcement.test.ts | pass — spawn/network/git-mutation/write refused at runtime; read-only git passes |
| AC-3 | test/dependency-direction.test.ts | pass — scopeless and werkstatt-internal deps blocking; SDK/plugin deps pass |
| AC-4 | test/skills-generation.test.ts | pass — untracked, content-derived, twin-free, incremental hash stability |
| AC-5 | test/plugin-locality-equivalence.test.ts | pass — npm and project-local species identical capability |
| AC-6 | test/capability-static-scan.test.ts | pass — raw imports/fetch blocking; ctx-mediated clean |

### First-party plugin rewrite state

`packages/forge-typescript` — STARTED (commit `6c9b3d66`): v10 manifest + ts.tsconfig.validate (TS-001) ported as pure rule over SDK ports. Remaining: dist build wiring, TS-002..006 ports, loader-execution test. `forge-astro`, `forge-repo-extract`, `forge-system` — scaffolds pending the same rewrite. The v9 implementations live in git history (provenance import) for rule porting.


## WP-5 completion — first-party plugin publication (2026-11-25)

All four first-party plugins published at 1.0.0:

| package | version | contents |
|---|---|---|
| @warpgogol/forge-typescript | 1.0.0 | TS-001..006 validators (tsconfig, import boundaries, phantom deps, package exports, strict mode, barrel subpaths) |
| @warpgogol/forge-astro | 1.0.0 | ASTRO-001/002 (config honesty, content-collection schemas) |
| @warpgogol/forge-system | 1.0.0 | SYS-001/002 (superfolder structure, product roster sweep) |
| @warpgogol/forge-repo-extract | 1.0.0 | EXTRACT-001/002 (plan surfaces, provenance completeness) |

All four load through the standard v10 loader with zero special-casing
(test/first-party-plugin-e2e.test.ts, 3/3 green). `@warpgogol/werkstatt-typescript`
deprecated on npm with a migration pointer per RFC-1648 rollout.
Consumer-install verification pending npm staging propagation (~10 min lag
observed on the 10.0.0 publish as well).

## WP-6 self-host state (2026-11-25)

- `.forge-selfhost/` harness pins npm-published `@warpgogol/forge` outside workspace resolution; pin-freshness and artifact-execution enforced by `test/self-host.test.ts` (3/3 green).
- **Discovered divergence requiring migration:** the monorepo's own `.agents/skills` is a TRACKED v9 twin — and already stale (canonical `skills/fo/fo-add-tests` carries `mocking.md`/`pbt-guide.md` absent in the twin). This is the exact drift class RFC-1648 eliminates. Canonical layout: `skills/fo/*` (34) + `skills/meta/*` + `skills/shared/*` + `skills/_shared` flatten to the generated root.
- **Remaining machinery rewrite (identified, not yet done):** v9 agents-generate/skill-agents-sync machinery assumes tracked twins — `src/tests/skill-agents-sync.test.ts`, `src/tests/agents-generate*.test.ts` and the `forge.agents.generate`/`forge.init`/`forge.upgrade` writers must be rewired to generated-untracked before the twin can be untracked here. Until then the tracked twin remains as legacy surface — documented, not silently dropped.

## Outstanding program items (continuation notes)

1. npm consumer-install verification of the four published plugins (staging propagation pending at writing; poller at /tmp/npm-propagation-status.txt).
2. WP-5 depth: skills-generation machinery rewiring (see WP-6 notes above).
3. Evidence mirroring into werkstatt `docs/forge-v10/` — wp-2/wp-4-5 evidence + completed protection-migration-map — requires a werkstatt flow session (heavy gates; schedule with fresh context).
4. WP-7 canary (warpgogol-verbund dark-run + cutover), WP-8 werkstatt migration, WP-9 consumers — operational waves in external repos.
5. forge 10.1.0 release carrying WP-4/5 features once the full matrix is green; self-host pin bump follows.
