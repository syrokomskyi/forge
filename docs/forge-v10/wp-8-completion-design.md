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

## 7. E1 delegation architecture — design seed (2026-11-26)

The exit criterion's delegation mechanism does not exist yet. Three candidate
directions, analysed against the program's proven constraints:

**Direction A — kernel routes to plugin host in-proc.** `werkstatt run` loads
the project plugin and forwards migrated ids. REJECTED-leaning: reverses the
dependency arrow the entire migration was built on (kernel→plugin knowledge),
re-introduces the strip-only loading problem inside the kernel runtime, and
makes kernel correctness depend on project-local plugin state — the failure
surface WP-8 exists to shrink.

**Direction B — caller migration + hard error.** `werkstatt run <migrated>`
errors with a redirect hint (`use forge <cmd>`); callers migrate; engine copies
retire module-by-module. No new machinery — decommission sequencing only. The
friction cost lands on operator muscle memory and every script/skill/hook that
invokes `werkstatt run` for migrated surfaces — measurable via grep across the
workshop before committing.

**Direction C — shell-out shim.** kernel command becomes a thin shim exec'ing
`forge <cmd>` with forwarded argv, propagating exit code and stdout/stderr.
`werkstatt run` UX preserved byte-identically during transition; implementation
is per-command trivial and uniformly testable; subprocess cost ~100ms per call
which operator-facing commands absorb trivially but pipeline-internal hot
paths never pay (they are kernel-retained anyway). The delegation TABLE is
then literally the list of shimmed commands — and the exit criterion's
"table empty for migrated surfaces" reads naturally as: shims removed once
callers have migrated, engine copies deleted.

C-then-B is the coherent sequence: shim first (zero caller friction day one),
measure shim invocation frequency through the journal, retire shims whose
caller migration completes, end with the table empty. Design question for the
E1 program session: whether the shim lives in the engine command registry
(explicit per-command shim declarations) or in a generic argv-time fallback
(any registered-plugin id intercepted before unknown-command error). The
explicit form is auditable per RFC-1648 doctrine; the implicit form risks
routing ambiguity during partial migrations.

## 8. WP-8 extraction-phase completion assessment (2026-11-26)

Assessment against §4 exit criteria, measurement-based:

**Criterion 1 — every studio-ops workspace-scope command answered by plugin
host: MET.** 58 commands across 12 modules migrated byte-faithful (waves
4a-20). Per-module residue analysis: every remaining command is classified
KERNEL-RETAIN with measured evidence (kernel-runtime coupling, execution-
position invocation, enforcement semantics, or registrar-total economics).
No unclassified rows remain.

**Criterion 2 — kernel retained only for genuine kernel-internal requirements:
MET with one economic exception.** handoff is kernel-retained on economics
(~13k-line registrar-total closure), not on architectural necessity — with
E1 delegation it becomes a delegation candidate. All other retentions are
architectural (coupling/invocation/enforcement).

**Criterion 3 — migration inventory all rows closed: MET.** Terminal
classification committed to wp-8-migration-inventory.md.

**Criterion 4 — `werkstatt run` delegation table empty for migrated surfaces:
STRUCTURALLY UNMET — requires E1.** Migration is dark-run: kernel copies
still serve `werkstatt run`; no delegation mechanism exists. Worse, the
inverse dependency is live TODAY: kernel-retained modules invoke plugin-
resident commands through the registry at exactly 3 edges (bordbuch.repair
from mission-open, bordbuch.validate from nachweis-publish, evidence.sync
from leitstand-deploy + mission — deploy-critical, structured-result
consuming), plus 1 reverse edge (nachweis.publish → kernel manifest.generate).

**Verdict: the WP-8 extraction phase is COMPLETE; the WP-8 program is NOT —
it reduces to the E1 delegation program (4 edges, bounded) followed by E3
(kernel-copy retirement).** The extraction machinery is proven: 17 waves,
closures 79→5100 lines, seam-extraction strategy, zero integrate regressions.
