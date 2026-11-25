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
