# Forge v10 program — session state 2026-11-25 (resumption document)

## Where the program stands

- WP-2..WP-7: **complete** (conversion, contract graph, transactional queue, SDK, plugins published, self-host, canary).
- forge **10.1.1 published** — carries cli-bridge, hook runtime, FLOW inert-ignore fix, erasable-syntax fix. Bit-identical tarball proof: sha1 `5800beaedec4177cc72f5811419bf5e4f4aab7df`. Full matrix green: 5361/5361, 0 failed, 1633 suites.
- WP-5 closure proven end-to-end on the real npm artifact (consumer plugin e2e, both polarities).

## WP-9 wave-1: 4/5 consumers INTEGRATED on develop + forge 10.1.1 resolving

lagebild, dialogue-steward, metads, dater — all integrated, `pnpm install` refresh executed in primaries (post-merge node_modules alignment is a REQUIRED manual step — candidates for flow.integrate automation).

**pipelines**: re-integrate in flight after CORR-GATE-02 fix (`plugins` declared policy-mutable, commit 96d2eff in session worktree `pipelines@auto-session-261125-01-forge-v10-migration`). Output capture `/tmp/pipe-integrate2.json`. If refused again: read diagnostics, remedy in worktree, re-run. After integration: `pnpm install` in primary, verify `pnpm exec forge --version` = 10.1.1, verify `ts.tsconfig.validate` still passes (plugin adoption proof).

## Remaining program items

1. ~~pipelines integrate completion~~ — **DONE (e4b0436ec, parity-only)**. WP-9 wave-1 complete: 5/5 consumers on develop with forge 10.1.1.
2. **Final evidence mirror to werkstatt** — bulk INTEGRATED (5a014340c landed on werkstatt develop); final micro-mirror carrying the 5/5 completion docs prepared in this same commit series. Historical note: copy `docs/forge-v10/*` (this repo) into werkstatt `docs/forge-v10-mirror/` through a werkstatt flow session (session-open → copy → commit → flow.integrate blocking). Prior mirror integrated at werkstatt commit f068001b5→fc538b6ae; this final mirror must carry: WP-5 closure, WP-9 wave-1 results, this state document.
3. **WP-8 werkstatt migration** — multi-session program, inventory complete in `wp-8-migration-inventory.md` (1271 engine commands vs v10's 168; gap quantified by prefix). Not started by design.
4. **Program acceptance** — after mirror integration.
5. **Follow-up candidate (not yet scoped)**: plugins pin exact forge versions through the pnpm workspace rewrite (`@warpgogol/forge: 10.1.0` inside forge-typescript 1.0.1) — peerDependency + semver range is the correct design; republish as 1.0.2 when scoped.

## Hazards reference (all documented in wp-9 runbook)

prettier normalization required before commit; pnpm-exec json noise — use direct dist invocation; .gitignore 444 in worktrees — documented chmod u+w; flow.open --kind session|task only; post-merge `pnpm install` required in primaries.

## Thread-2 update (same day, late session)

### Completed since the mirror
1. **T-0023 filed through sanctioned path** — verbund-queue task for pipelines plugin adoption, complete brief (CORR-GATE-02 context, ^1.0.2 pinning rule, policy.mutable sanctioning, acceptance checks). Integrated into warpgogol-verbund develop (`eaf8233`).
2. **werkstatt-studio scaffold committed** — `f08a52209` (scaffold) + `c17c00de6` (strip-type .ts modules, zero build step). Integrate gate in flight at this update.
3. **Regression test for .ts source loading** — forge `f667c98`: positive (loader executes .ts command modules) + negative (production strip-only refuses non-erasable syntax, proven through real node subprocess because vitest transpiles in-process and masks the constraint).
4. **Security fix — git capability bypass** — forge `a3c627c`: mutation check inspected args[0] only; `git -c x=y commit` bypassed. Now proper subcommand parsing, conservative dual-use denial (tag/branch/config), extended mutator coverage, outright refusal of -C/--git-dir/--work-tree scope redirection. 10/10 tests green, typecheck PASS.
5. **WP-8 inventory corrections** — forge `b779d13` + `1d00f95`:
   - forge-state reachability SDK gap filed as P2 design blocker: workspace port sandboxes to root, journal in worktrees unreachable; option A (gitdir-aware extension) vs option B (ctx.forgeState host port — preferred direction); capability grant must stay distinct, never widen filesystem.
   - outbound coupling measured: extraction unit is the COMMAND not the cluster; deploy is wave-2 first candidate (~no cross-cluster deps); workpiece blocked on mission-port; fleet needs bordbuch cluster extraction; hygiene heaviest leaf.

### In flight
- werkstatt `auto/session-261125-04-wp-8-studio-scaffold` integrate gate (heavy matrix — normal duration tens of minutes). On green: verify both scaffold commits in develop, worktree/branch cleanup, close WP-8 P1.

### Next technical steps (unchanged priority)
1. Land WP-8 P1 (integrate verdict pending).
2. forgeState port design decision (option B direction) — blocks journal-dependent extraction.
3. Wave-2 scan: enumerate deploy-cluster commands expressible against current ports.
4. verbund bump: warpgogol-verbund lockfile resolved 10.1.0 — should track ^10.1.1 for the inert-ignore fix (minor).

## Thread-3 update (2026-11-25 late, post-midnight UTC)

### Closed this thread
- **WP-8 P1 COMPLETE** — werkstatt develop `439e7133c` carries both scaffold commits; worktree/branch cleaned. Post-integration smoke: `studio.journal.tail` reads the real journal in primary (total: 1026 records) — semantic analysis confirmed: primary works, worktrees degrade until forgeState port.
- **T-0023** in verbund queue (pipelines plugin adoption, sanctioned path).
- **forge 10.1.2 release prep complete** — changelog + version bump committed (`e2bc2b6`+`653b94e`), final matrix running on `653b94e`.

### forge develop additions since 10.1.1 (all in 10.1.2)
1. `f667c98` — regression test: .ts source loading contract (positive + subprocess negative).
2. `a3c627c` — SECURITY: git capability bypass closed (global-flag indirection, dual-use conservative denial, scope redirection refusal).
3. `1e491d4` — symlink ports (readlink/symlink/unlink).
4. `e2bc2b6` — extended fs ports (readFileBytes/rename/rm/stat) + release prep.
5. `653b94e` — env port enforcing envKeys allowlist.
6. Inventory: wave-2 capability surface COMPLETE for deploy cluster; translation pattern reference concrete; journal typing measured (event discriminator).

### In flight
- **Final matrix on `653b94e`** (`/tmp/matrix-1012.json` output) — gate for 10.1.2 publish. SDK freeze self-imposed until matrix completes.
- On green: `npm publish` 10.1.2, verify version-document endpoint, record evidence.

### Next session entry points (priority order)
1. Publish 10.1.2 if matrix green (or diagnose failures).
2. WP-8 wave-2: deploy extraction into werkstatt-studio — mechanical per the translation pattern; first command `studio.deploy.status` (pure read), then swap/rollback pair, gc, verify, build last (envKeys-sensitive). Each extraction is a werkstatt flow session with integrate cycle.
3. forgeState port implementation when journal-consuming extraction begins (wave-3: fleet/sichtpass/hygiene) — design sketch + journal typing already in inventory.
4. First-party plugins peerDep note: PluginContext type additions are additive-only (new port fields) — non-breaking for 1.0.2 plugins.

### Key operational facts
- werkstatt integrate gates run tens of minutes; commit gates about 10 min — detached + poll is the only sane pattern.
- Direct git commits in werkstatt are blocked by flow-guard — everything through ecosystem.commit.
- flow.open sweeps untracked files into the session worktree (observed in verbund — files vanished from primary, appeared in worktree).
- pkill patterns matching vitest can kill the invoking shell chain — kill by exact pid, verify after.
- Killing a matrix parent pid does NOT kill vitest workers — they reparent and keep burning CPU alongside the replacement run (the competing-matrix anomaly recurred). Kill the whole tree bottom-up or use the process group; verify with ps that exactly one tree remains.
- Compat verification for the git hardening: all four first-party plugins declare gitMutation false and none call ctx.git — zero regression surface.

## Thread-3 final: forge 10.1.2 PUBLISHED

- npm publish succeeded: @warpgogol/forge@10.1.2 (carries git-capability security fix, symlink+extended fs ports, env port, .ts-loading regression coverage).
- Matrix analysis: 5383 total / 5379 passed / 3 failed — all three explained, none a regression: (1) self-host pin — designed post-release chore, bumped to 10.1.2 in 2c118f6; (2) PKG-HEALTH-10 — my own probe literal, restructured in 774d3cd; (3) FLOW-BM-02 backmerge timeout — proven pre-existing environment flake via identical failure on pre-change tree 709b9efd, NOT caused by SDK changes. Filing as known-flake for separate investigation.
- Version-doc endpoint propagation in progress at this writing (npm replication lag, same pattern as 10.1.1 — verify then close).
- Self-host pin bumped 10.1.0 → 10.1.2 (post-release chore complete).

## Thread-4 update (2026-11-26 early)

- **forge 10.1.2 FULLY PROPAGATED** — tarball 200 after staging delay (~35 min total; the 409-on-republish is the tell the first publish landed server-side).
- **wave-2 first extraction LANDED**: studio.deploy.status in werkstatt develop (a54569734 + rebase regen 2c559b5fc), worktree cleaned. Exact parity proven before commit.
- **forgeState port IMPLEMENTED** in forge develop (bb9dc6a) — option B, 8/8 tests including decisive worktree boundary proof. Ships with next minor.
- npm two-stage replication: version-doc 200 preceded tarball 200 by ~15 min; pnpm install fails on tarball 404 mid-window — sequence installs after tarball replication.


## Thread-4 continuation (2026-11-26 ~00:30Z)

Wave-2b COMPLETE in worktree, integrate in flight:
- 167bd675f write-cluster extraction + fa8f7430c hardening, both through commit gates
- full lifecycle proven end-to-end; signed verify both polarities (correct key pass, wrong key fail)
- ENGINE DEFECT DISCOVERED + FILED: artifact.build signs 8-field object, verify reconstructs 6 — signed artifacts can never verify in production. Parity-neutral for extraction; operator decision needed before wave-2c.

forge 10.2.0 PUBLISHED:
- coreVersion dist-layout bug fixed (silent 10.0.0 fallback broke forgeRange enforcement)
- forgeState port ships (journal host-mediated reads)
- matrix composition green: 5391/5393 + pkg-health suppressions isolated green
- self-host pin bumped to 10.2.0, harness reinstall pending propagation
- propagation poller active

NEXT (priority order):
1. complete wave-2b integrate (in flight) + verify develop
2. harness reinstall + self-host green after propagation
3. wave-2c decision: artifact.build sign-semantics — OPERATOR DECISION REQUIRED (replicate bug vs fix consensus bytes)
4. wave-3: journal-tail migration to forgeState port (draft ready in docs/forge-v10/wave3-journal-tail-forgestate.draft.ts)


## Thread-4b (2026-11-26 ~01:55Z)

forge 10.2.1 PUBLISHED + PROPAGATED + matrix composition fully green:
- 5393/5395 + self-host pin bump (designed chore) = full green; harness reinstalled, 3/3
- forgeState capability registration fixed — the 10.2.0 port was unreachable (capability-unknown)
- LESSON: release validation must include a load-smoke of a manifest declaring the NEW capability — matrix alone did not catch that the port could never be declared

werkstatt follow-up in flight:
- forge10 pin 10.2.0 + F-0401 friction cherry-picked into REGISTERED session auto/session-261126-03 (f4deac73c); integrate running
- FLOW LESSON: session branches must be opened via pnpm exec forge flow.open --kind session --slug <slug> — manual git worktree add creates unregistered branches that FLOW-INT-06 refuses and FLOW-GUARD-02 grammar-rejects; two orphan sessions (-01 unregistered, -02 empty from timed-out open) need flow.discard cleanup AFTER integrate completes (registry writes must not race)
- wave-3 READY: journal-tail migration content staged in /tmp/wave3-scratch (may be gone after reboot — regenerable from docs/forge-v10/wave3-journal-tail-forgestate.draft.ts); needs pin 10.2.1 + manifest forgeState:read + output shape fix (event/branch/sha/at — old pilot emitted wrong-schema kind/opId/ts)


## Thread-4c — probe-ratchet interaction lesson (2026-11-26 ~02:20Z)

New operational lesson: WT-GATE-08 PROBE-07 can refuse integration when the session's own validation activity generates liveness evidence for baselined rules. The friction.validate runs that confirmed the F-0401 fix also exercised FRICTION-02, creating evidence that staled the unprobed baseline mid-session. Remedy is sanctioned shrink-only regeneration (gate.probe.catalog --write-baseline). Watch-out: the shrink magnitude reflects ALL evidence since last regeneration (890→629 here), not just the session's own — the commit message must say so honestly. The catalog check is state-dependent: running standalone vs inside gate context can disagree because evidence accumulates between runs.


## Thread-4d — wave-3 in flight (2026-11-26 ~03:00Z)

Follow-up batch INTEGRATED into werkstatt develop (9516b009b): forge10 pin 10.2.0, F-0401 friction, probe baseline regeneration. Additional lessons:
- PROBE-07 ratchet can refuse integration when session validation activity itself generates liveness evidence for baselined rules — shrink-only regeneration is the sanctioned remedy
- friction.validate category vocabulary: tooling/docs/process/environment/self — defect is not valid
- FLOW-INT-06 requires REGISTERED session branches — always flow.open, never manual worktree add (two orphan branches -01/-02 remain for operator cleanup, inert)

Wave-3 commit 3071158aa in integrate: journal-tail on forgeState port + pin 10.2.1 + forgeRange >=10.2.1. Proven from inside worktree — the decisive boundary test. strip-types clean.

REMAINING PROGRAM STATE:
- deploy cluster 5/6 extracted + journal-tail on proper port = studio plugin fully on sanctioned SDK surface
- wave-2c artifact.build — unblocked by doctrine (parity replicates defect); needs processSpawn capability scoping design
- orphan session cleanup: werkstatt@auto-session-261126-01/02-wave2b-followup worktrees+branches inert but present

## Thread-5 continuation (2026-11-26 late) — wave-3 INTEGRATED, forge 10.3.0 published

- **wave-3 integrate GREEN** — `9516b009b → 7bd4b4aa7`, cleanup machinery-done. werkstatt
  develop carries journal-tail on the forgeState port + the FRICTION-02 probe fixture.
- **FRICTION-02 ratchet paradox RESOLVED** — full decode in wp-8-migration-inventory.md:
  firing evidence died with the follow-up worktree's counters journal; RFC-1642's
  binding-is-liveness is the designed escape; first frictions-contract fixture written,
  probe PASS with exactly 1 diagnostic. Residual design question noted: integrate-time
  capture of worktree firing evidence into the committed counters projection.
- **forge 10.3.0 published** — processSpawn binary allowlist (array form). Matrix green
  5400/5401 (1 skipped). node24 tarball smoke PASS. Propagation poll in flight.
  Wave-2c artifact.build unblocked once propagated + pinned.
- **orphan cleanup** — session-261126-02 discarded through sanctioned flow.discard;
  01 is unregistered (FLOW-DIS-04) — machinery disowns it, content proven
  patch-equivalent in develop (git cherry `-`), left inert pending operator decision
  on raw branch deletion.
- **wave-2c draft validated** — cp/turbo/gitSha/manifest ordering parity confirmed
  against engine source; one deviation annotated in /tmp/wave2c-scratch draft
  (no `reused` flag on the reuse path). SDK assumptions verified: paths.resolve sync,
  process.spawn default cwd workspaceRoot, allowlist basename matching.

## Thread-5 resumption map — wave-2c integrate in flight (2026-11-26)

**In flight**: wave-2c integrate in werkstatt session `auto/session-261126-02-wave2c-artifact-build`,
commit `ed3a75c3b` — deploy.artifact.build extraction (6/6 deploy module completion).
Capture files: `/tmp/w2c-integrate.json` / `.err` (EXIT marker). Verdict reading:
`summary` field — "integrated ... cleanup done" = green.

**If integrate refuses**: read the full json for the rule id. Known refusals this session
and their remedies: PROBE-06/07 → probe fixture (FRICTION-02 precedent in
docs/gate-probes/frictions/); WT-GATE lint → fix + recommit; FLOW-INT-19 → synthetic ids
in fixtures. Never rerun integrate blindly — extract the rule first.

**Completed this thread** (all durable): wave-3 INTEGRATED (journal-tail forgeState);
forge 10.3.0 published+propagated (processSpawn array allowlist); selfhost pin aligned;
FRICTION-02 ratchet paradox RESOLVED via RFC-1642 fixture binding; orphan 02 discarded,
orphan 01 left inert (unregistered, content patch-equivalent in develop — operator
decision pending on raw branch deletion).

**Next-session entry points by priority**:
1. Verify wave-2c integrate verdict; if green — deploy module migration COMPLETE (6/6),
   update inventory wave-2c section.
2. Next migration wave selection — candidates by ownership line: integrity cluster
   (12 commands, signing domain overlap with proven chain), check module's
   deploy.preflight/scripts.validate, or smallest-first re-analysis. journal.* are
   domain commands (grants/materials), NOT the forge journal — different ownership.
3. werkstatt F-0401 engine fix — independent track: decide sign-side payload fix
   vs vestigial documentation; plugin tracks in synchronized change.
4. SDK surface-gap candidate: scoped mkdir port (wave-2c workaround: spawn mkdir -p).
5. Residual probe-ratchet design question: integrate-time capture of worktree firing
   evidence into committed counters projection (inventory tail).

**Operational reminders**: npm propagation lag is two-stage (metadata then tarball) —
verify both before pin bumps; `forge` is the bin name (not forge10); integrate NEVER
under timeout wrapper; flow.open is the only sanctioned session opener; fixture-authored
probes need no pathPattern for friction.validate (file field is constant FRICTION_DIR).

## Thread-5 FINAL — wave-2c INTEGRATED, deploy module complete (2026-11-26)

wave-2c integrate GREEN: `7bd4b4aa7 → c3ee91a48`, cleanup done. One retry on the
robots-parser phantom (FLOW-INT-01) — noise deletion remedy proven third time.

**WP-8 state: engine deploy module migration COMPLETE (6/6)** — the first fully
migrated module. Plugin surface on develop: 7 commands on forge 10.3.0.

Next-session entry points unchanged (see thread-5 resumption map above) except:
wave-2c verify step is DONE; next-wave selection is now the top item; the
robots-parser phantom friction filing joins the werkstatt batch candidates.

## Thread-6 resumption map — forge 10.4.0 release in flight (2026-11-26)

**In flight**: matrix for forge 10.4.0 at `/tmp/matrix-1040.log` (marker MATRIX_DONE:0).
Version+changelog committed. artifactStore spaces port is the cargo.

**When matrix green** (proven release procedure):
1. `cd packages/forge && npm publish --access public` — prepublish runs node24 smoke
2. propagation poll: BOTH `registry.npmjs.org/@warpgogol%2fforge/10.4.0` AND the tarball
   URL must be 200 (two-stage lag proven repeatedly)
3. selfhost pin: `.forge-selfhost/package.json` → 10.4.0, pnpm install, commit lockfile
   + pnpm-workspace.yaml release-age exclude (machine-updated)

**Then werkstatt wave-4**: artifact-store extraction — first consumer of the port.
Open session `flow.open --kind session --slug wave4-artifact-store`. Engine source:
`packages/werkstatt-engine/src/artifact-store/artifact-store-commands.ts` (4 commands:
get/put/gc/validate). Key extraction notes: coupling is utility-grade only
(atomicWriteFile, acquireLock/releaseLock, generateOperationId — copy into plugin);
artifactStoreDir resolves primaryRoot — the NEW PORT replaces exactly that
resolution; locking semantics need care (locks in shared state — investigate whether
acquireLock operates inside the artifacts dir or elsewhere before extraction).
Manifest needs `artifactStore: readwrite` + `forgeRange >=10.4.0` + forge10 pin 10.4.0.

**Completed this thread**: deploy module 6/6 INTEGRATED (wave-2c); wave-3 forgeState
consumer INTEGRATED; FRICTION-02 ratchet paradox resolved via RFC-1642 fixture;
forge 10.3.0 published (processSpawn allowlist); wave-4 structural finding documented
(extraction wall — semantic state ports); artifactStore port implemented+tested 6/6.

**Wave-4 doctrine reminders**: extraction unit = command, never cluster; parity
replicates defects (F-0401 precedent); scope field decides candidacy (app-scope is a
different extraction line — ALL integrity.* are app-scope, do not retry that analysis);
integrate NEVER under timeout wrapper; nested node_modules .gitignore phantom costs
one FLOW-INT-01 retry per session (delete noise file, retry — friction candidate).

## artifact-store internal inconsistency — decode before wave-4 extraction (2026-11-26)

Close reading of artifact-store-commands.ts (757 lines) surfaced contradictory
root resolution INSIDE the engine — extraction ordering must account for it:

- `storeArtifactCore` (put): archive tmp/store/manifest paths are
  `path.join(workspaceRoot, ARTIFACTS_DIR, …)` — WORKSPACE-RELATIVE. In a
  worktree the store lands in the worktree's own `.werkstatt/artifacts`, not
  the primary's! Only the release-copy uses `resolveWorkshopPaths().releasesDir`
  (primary-rooted). Two ARTIFACTS_DIR-ish constants exist:
  `.werkstatt/artifacts` vs `.werkstatt/artifacts/releases` (ARTIFACTS_DIR_NAME)
  — verify which commands use which before translating anything.
- `runArtifactStoreGet`/`runArtifactStoreValidate`: storeBase also built
  workspaceRoot-relative (line ~310-445 region) — same worktree-divergence.
- `gc` (line ~685): uses `resolveWorkshopPaths` — PRIMARY-rooted, plus
  acquireLock.

Consequence: in the primary checkout worktree==primary and everything agrees;
in a worktree, put writes artifact data worktree-locally while gc manages the
primary store — the two never see the same bytes. Either (a) artifact-store
operations are only ever run in the primary checkout in practice (making the
divergence latent), or (b) this is an undiscovered defect class sibling to
F-0401. DECISION NEEDED before extraction: read the callers (who invokes
artifact.store.* — leitstand.ship? release pipeline? hygiene?) and determine
the actual execution root. If operations are primary-only in practice, the
artifactStore port may be unnecessary for parity — the workspace port suffices,
and the port's first real consumer becomes gc/hygiene instead. Do NOT extract
on the primary-root assumption without this decode. Search terms for next
session: `hashPath`, `ARTIFACTS_DIR`, `ARTIFACTS_DIR_NAME`, call sites of
`artifact.store.put` in leitstand/release pipelines.

- **caller decode partial**: the production caller is
  `release/release-commands.ts:1156` calling `storeArtifactCore` DIRECTLY
  (lock-free, because the release pipeline already holds the lock — the CLI
  put facade would deadlock). The artifact.store.* CLI commands are operator
  facades. Open question narrowed: what root does the release pipeline execute
  with? If primary (likely — releases are primary state), the
  workspaceRoot-relative store paths ARE primary paths in practice and the
  divergence is latent-but-real only for CLI facades run inside worktrees.

- **wave-4 split resolved by parity logic**: extraction replicates the engine's
  resolution exactly — workspaceRoot-relative paths map to the plugin's
  workspace port (identical semantics: both root at the execution checkout).
  Consequence: put/get/validate need NO state-space port for their store
  operations; only (a) put's releasesDir copy and (b) gc's
  resolveWorkshopPaths-rooted scan touch primary state. Clean split:
  wave-4a = artifact.store.gc (the true first artifactStore-port consumer —
  small, self-contained, exercises the boundary decisively);
  wave-4b = put/get/validate (workspace-port-heavy, put additionally needs a
  releases-space decision — the granularity pivot question). This ordering
  also front-loads the port proof before the heavy tar machinery translation.

## tmpfs matrix lesson + r2 in flight (2026-11-26)

The first 10.4.0 matrix failed TWO ways: (1) lint — dead `scoped` residue from
the factory extraction + pre-existing unused `existsSync` in RFC-1647's
lease.ts (both fixed, committed); (2) heavyweight gate tests dying with git
`config.lock` write failures — /tmp is tmpfs (31G), vitest mkTmp residue had
consumed 23G. trust-boundary-cx34h passes in isolation after cleanup —
environmental, not behavioral.

**Durable lesson**: run the matrix with `TMPDIR=~/projects/warpgogol/.tmp-forge`
(disk-backed, created) so heavyweight tests stop consuming RAM — same lesson as
werkstatt RFC-1623. Residue hygiene: `find /tmp -maxdepth 1 -name 'forge-*'
-mmin +30 | xargs rm -rf` — vitest never cleans mkTmp dirs.

**Matrix r2 in flight**: `/tmp/matrix-1040-r2.log`, marker MATRIX_DONE:0.
When green: publish 10.4.0, propagation poll (two-stage), selfhost pin bump.
Then werkstatt wave-4a = artifact.store.gc — the true first artifactStore-port
consumer per the parity-logic split.

- **wave-4a sizing correction**: artifact.store.gc is NOT small — the command
  body delegates to `collectReleaseArtifacts(paths, io, keep, {dryRun,
  systemFilter, logger})` which implements the protection-set logic (per
  AGENTS.md: newest-3-per-system + live readers + chain head). Locking is
  `acquireLock(paths.primaryRoot, "hygiene-gc", …, 3600)` — PRIMARY-rooted,
  unlike put's workspaceRoot lock (cross-command lock inconsistency — friction
  candidate). Dry-run never locks. Extraction unit realistically:
  collectReleaseArtifacts + helpers translate with it; estimate the closure
  before committing to the wave (grep collectReleaseArtifacts definition).

## forge 10.4.0 PUBLISHED (2026-11-26) — artifactStore spaces port live

Release chain executed: matrix r1 failed on tmpfs pressure + lint residue →
environmental fix (disk-backed TMPDIR, residue cleanup) + lint repairs →
matrix r2 all heavyweight gate tests green, one pkg-health suppression →
published. Propagation poll in flight; selfhost pin bumped to 10.4.0 (install
after propagation). Matrix composition doctrine applied per wave-2c precedent.

**Next session resume**: (1) complete selfhost install+commit if not done;
(2) werkstatt wave-4a — artifact.store.gc extraction against the new port.
Remember: collectReleaseArtifacts closure ~120 lines, primary-rooted locking,
dry-run never locks. The granularity pivot question (narrow spaces vs one
primaryState) is OPEN — decide with put evidence; gc fits the narrow port.

## wave-4a runbook skeleton — artifact.store.gc extraction (for next session)

1. `cd werkstatt && pnpm exec werkstatt run flow.open --kind session --slug wave4-artifact-gc` — NEVER hand-create worktrees (FLOW-INT-06 lesson)
2. pins: `forge10: npm:@warpgogol/forge@10.4.0` in root + studio package.json; install; forgeRange `>=10.4.0` in the command manifest
3. manifest capabilities: `artifactStore: readwrite` (gc deletes), `filesystem: read` (lock files are workspace-rooted — WAIT, gc locks PRIMARY-rooted! verify: acquireLock(paths.primaryRoot,…) means lock files live in `<primary>/.werkstatt/locks` — OUTSIDE both workspace AND artifactStore space! EXTRACTION BLOCKER CANDIDATE: either the locking primitives need a locks-space or the plugin replicates lock semantics inside artifactStore space paths — DEVIATION. Decide explicitly; the honest options: (a) widen artifactStore root to `<primary>/.werkstatt` covering locks+artifacts both — one space, matches werkstattDir reality; (b) accept deviation with documented reasoning. LEANING (a): the werkstatt state dir IS the natural space boundary.)
4. translate: collectReleaseArtifacts (lines 560-680) + runArtifactStoreGc body + hashPath/collectFiles helpers from werkstatt-shared; protection-set logic newest-3 + live readers + chain head — READ the helper before translating
5. proofs: fixture artifact store in worktree tmp, dry-run plan shape, apply deletes only unprotected, lock refusal path, worktree-boundary decisive proof (writes land in primary)
6. integrate via kernel host, no timeout wrapper, expect one node_modules phantom retry

## thread-6 final state — 10.4.0 published, propagation pending (2026-11-26 ~03:10)

**INCOMPLETE — resume here next session**:
1. propagation: npm processing 10.4.0 (`npm view versions` doesn't list it yet —
   the packument itself lags; publish command DID succeed). Poll
   `npm view @warpgogol/forge dist-tags.latest` until 10.4.0.
2. then: `cd .forge-selfhost && pnpm install` (pin already bumped+committed),
   validate harness (`node_modules/.bin/forge --version` → 10.4.0), commit
   lockfile + pnpm-workspace.yaml release-age exclude if machine-updated.
3. then werkstatt wave-4a per the runbook skeleton above — NOTE the space-root
   design correction: gc locks live in `<primary>/.werkstatt/locks`, outside the
   narrow artifacts space; LEANING toward widening artifactStore root to
   `<primary>/.werkstatt` in forge 10.4.1 BEFORE the wave (zero consumers —
   safe). That widening is a small context.ts edit + test adjustments + matrix.

**Completed this thread** (all committed): deploy module 6/6 migration COMPLETE;
wave-3 forgeState consumer integrated; FRICTION-02 paradox resolved (RFC-1642
fixture); 10.3.0 (processSpawn allowlist) + 10.4.0 (artifactStore spaces port)
published; wave-4 structural analysis + artifact-store decode + sizing +
runbook; tmpfs matrix lesson (disk-backed TMPDIR).
