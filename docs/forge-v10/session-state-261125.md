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
