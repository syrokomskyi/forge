# WP-8 completion design — migration endgame mechanics

Status: accepted working design (2026-11-26). Governs all remaining WP-8 waves.

## 1. The core decision: reimplement vs mechanical-port

Waves 1–4b used **reimplementation**: read engine source, rewrite against SDK
ports, prove parity with fixtures. Correct for small commands (<300 lines)
where rewrite cost ≈ adaptation cost and rewriting forces understanding.

Wave-4c onward the cost profile inverts: closures are large (gc ≈ 780 lines of
helpers + 326 lines of command body; integrity ≈ 3.8k). Reimplementation cost
dominates and every retyped line is a parity risk. Therefore:

**Decision: mechanical-port is the default extraction mechanics for closures
above ~300 lines.** Concretely:

1. Copy the engine closure files byte-identically into the plugin `src/lib/`
   (done for wave-4c: protection/anomalies/release-index/gc = 776 lines).
2. Adapt only the **boundary layer**: imports and io-path resolution. Logic
   bodies stay untouched — parity by construction, not by fixture.
3. Let `tsc` enumerate the adaptation surface; the error list IS the work
   inventory. Never read a file fully when the type system can diff it.
4. Fixture proofs shrink to boundary proofs (ports wired correctly, paths
   resolve, lock semantics) — logic correctness is inherited.

Reimplementation remains correct for small commands and for commands whose
engine logic must change shape anyway (parser collisions, dead-in-practice
surfaces).

## 2. The io-boundary adaptation contract

Engine `WorkspaceIO` and SDK ports share verbs but differ in path semantics:

- engine: absolute paths everywhere, `resolveWorkshopPaths()` supplies roots
- SDK: scoped relative paths — `ctx.workspace` (worktree root),
  `ctx.primaryState` (primary checkout root)

Adaptation rule: any engine path expression `path.join(paths.X, rest)` where X
is a primary-root path becomes the relative `rest` against `ctx.primaryState`;
worktree-root paths become relative against `ctx.workspace`. Path absolutes in
output data are reconstructed with the roots the host passes in context
(`ctx.workspaceRoot`, `ctx.primaryRoot` — verify exact host-provided field
names in `packages/forge/src/sdk/types.ts` before writing).

Non-portable engine imports and their wave-4c resolutions:

| engine import | resolution |
| --- | --- |
| `@warpgogol/forge/os/flow` `worktreeList` | engine already passes `io` in — port the helper into plugin lib or call host git via declared spawn; decide once, reuse everywhere |
| `sternsystem/registry-io` `resolveCacheClonePath` | **blocked capability class** — cache clones live at `../systems-cache` outside every current grant. gc's system-state protection lane degrades to `degraded.push(...)` + doubt-keeps semantics when unreadable; full parity needs a `cacheClone` space port (forge minor) — decision recorded in §4 |
| kernel `acquireLock/releaseLock` | replicate in plugin lib (wave-4b already carries the ~60-line pattern) |
| `atomicWriteFile` | already ported in wave-4b lib |

## 3. Wave-4c execution plan (artifact.store.gc — last artifact-store command)

Resumable state: session `auto/session-261126-01-wave4-artifact-gc`, closure
already copied to `packages/werkstatt-studio/src/lib/hygiene/` (776 lines).

1. Extract §4.4 gc body (line 431–757 of engine artifact-store-commands.ts)
   into `src/commands/artifact-store-gc.ts`; only 4 coupling-primitive hits —
   body is orchestration, helpers carry the weight.
2. tsc-enumerate adaptation errors in the copied lib; fix boundary-only.
3. Lock: `hygiene-gc` primary lock for `--apply`; dry-run without lock.
4. Proofs: dry-run plan shape; protection newest-N; doubt-keeps on degraded;
   shared-CAS retention; lock refusal; whole-unit deletion. Reuse engine test
   `artifact-store-gc-retention.test.ts` fixture shapes.
5. Commit → integrate → artifact-store module COMPLETE (4/4).

## 4. Sequencing to WP-8 endgame

After artifact-store closes, scan ordering by smallest-closure-first within
workspace-scope, with these capability decisions teed up:

- **`cacheClone` space port** — needed by gc full parity, bordbuch, fleet.
  Same deferred-space mechanics as primaryState; root `../systems-cache/<id>`
  relative-to-workspace invariant. Recommend forge 10.6.0 minor when the first
  full-parity consumer is forced (gc ships degraded-mode first, per doubt-keeps
  doctrine this is safe: unreadable ⇒ protected ⇒ nothing deleted wrongly).
- integrity cluster is app-scope, NOT studio — verify scope per module before
  scheduling (the earlier scan mis-bucketed it).
- Re-verify the 156 workspace-scope command list against current engine before
  final ordering; modules shift.

Endgame definition (exit criteria for WP-8): every studio-ops workspace-scope
command answered by the plugin host; engine kernel host retained only for
commands genuinely requiring kernel internals; migration inventory all rows
closed; `werkstatt run` delegation table empty for migrated surfaces.

## 5. Self-host conversion — SEPARATE program, decision required

Operator surfaced (2026-11-26): the forge monorepo itself is not governed by
npm-forge — no hooks, plain git commits, `.forge-selfhost` is a validation
harness only. This is real and confirmed, but it is NOT WP-8 scope. Feasibility
confirmed: artifact 10.5.0 ships full flow machinery. Open design questions
(bootstrap ordering, gate-breakage recovery, develop-vs-main branch model)
deserve their own program document before any conversion step. Do not mix into
migration waves.

## 6. Zombie decisions pending operator

- `warpgogol/packages/forge` — stale v9.7.1 export repo sharing the v10 remote;
  superseded by direct-publish. Options: archive-tag + delete local, or keep
  frozen. No action taken.
- werkstatt forge registry — 36 zombie session entries (261108–261123) whose
  branches/worktrees are gone; machinery drops entries correctly for modern
  sessions. Registry-GC is a forge-side feature candidate; mass manual discard
  not sanctioned.

## Addendum (2026-11-26): port-surface widening precedes wave-4c

Measured interface delta (engine WorkspaceIO vs SDK WorkspaceIOPort): DirEntry
shape mismatch on readdir/list; appendFile/mkdir/copyFile/mkdtemp/realpath
missing plugin-side. Decision teed in WAVE4C-RESUME.md — lean SDK-first:
10.6.0 widens the port verbs, then the abs-path bridge adapter is thin and
shared. If adapter proves general it promotes into the SDK itself.
