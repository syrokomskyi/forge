# WP-8 Werkstatt Migration Inventory — iteration 0 (2026-11-25)

Scope per program plan: extract studio-operations into a private project-local plugin; retire `werkstatt-engine`/`werkstatt-shared` runtime roles; dissolve `werkstatt-site` (generic Astro knowledge → forge-astro). Completion: werkstatt runs on npm `@warpgogol/forge` v10, zero runtime-semantics dependency on retired packages.

## Engine subsystem classification (54 dirs in `packages/werkstatt-engine/src/`)

### Class S — studio operations (→ private project-local plugin `werkstatt-studio`)
mission, sternsystem, leitstand, bordbuch, bauakte, fleet, lagebild, nachweis, release, deploy, dns, customdomain, subdomain, network, media, sichtpass, werkstatt, workpiece, notausgang, intake, handoff, remediation, certification, capability-artifacts, evolution, behavior-snapshot, journal, hygiene, artifact-store, signing, evidence, integrity, observability

### Class G — generic platform (kernel-grade; largely transferred to v10 forge os/ already or superseded by contract/evidence graph)
kernel, contract, fingerprint, isolation, scope, runtime, schemas, types, component, component-runtime, plugin, agent, agent-gate, onboarding, migrators, testing, e2e, tests, tests-handoff

### Already represented in v10 forge monorepo `os/` (verification needed — same names, different provenance)
agent, plugin, flow, gate, gate-run, correctness, adversarial, codebase, conformance, system, queue

## Migration phases (executable decomposition)

1. **P0 — inventory validation**: verify per subsystem whether v10 forge covers the semantics (many Class-G subsystems transferred during WP-2 conversion; verify nothing kernel-grade is missing by running werkstatt's critical commands against v10 equivalents).
2. **P1 — studio plugin scaffold**: create `packages/werkstatt-studio` in the werkstatt repo as a project-local v10 plugin (forge.plugin.yaml, SDK-based commands); wire into werkstatt `forge.yaml plugins[]`.
3. **P2 — subsystem migration waves** (smallest-first): move studio command implementations behind plugin commands; each wave is one integrate-cycle in werkstatt governance.
4. **P3 — generic Astro knowledge → forge-astro**: content collections, config validation, site-composition checks.
5. **P4 — retirement**: engine/shared runtime roles retired (packages deleted or archived); werkstatt pins npm `@warpgogol/forge` v10.
6. **P5 — Compass sync + AGENTS.md retirement** per program plan.

## Known risks (from RFC + recon)

- Engine is deeply interconnected — subsystem extraction order must respect the dependency direction; measure before sequencing P2.
- `werkstatt-site` dissolution touches every deployed sternsystem's build pipeline — dark-run needed per system class.
- werkstatt-shared's 752 consuming files (RFC-1648 line 54) — the scopeless-bag unwind is the bulk mechanical work.

## Open questions for iteration 1

- Which engine subsystems does the mission-critical path (mission.open → leitstand.ship) actually touch at runtime? (trace before sequencing)
- Does forge v10 need additional SDK surface (e.g. pipeline steps as plugin contributions) before studio extraction is expressible?

## Command-surface gap analysis (quantitative, 2026-11-25)

- werkstatt manifest: **1271 commands**; v10 forge CLI: **168 commands**
- covered by v10 today: **143**; missing: **1128**

### Missing by prefix (migration ownership classification)

| prefix | count | migration owner |
| --- | --- | --- |
| content | 45 | werkstatt-site dissolution (→ forge-astro/generic) |
| surface | 40 | werkstatt-site dissolution (→ forge-astro/generic) |
| agent | 35 | triage required |
| forge | 28 | v10 surface completion review |
| mission | 26 | studio-ops plugin |
| leitstand | 25 | studio-ops plugin |
| projektarchiv | 25 | product-line packages (separate migration line) |
| check | 21 | triage required |
| journal | 21 | studio-ops plugin |
| nachweis | 20 | studio-ops plugin |
| fleet | 17 | studio-ops plugin |
| onboarding | 15 | triage required |
| sternsystem | 15 | studio-ops plugin |
| dist | 12 | werkstatt-site dissolution (→ forge-astro/generic) |
| test | 12 | triage required |
| biome | 11 | triage required |
| page | 11 | triage required |
| section | 11 | triage required |
| observability | 10 | triage required |
| portal | 10 | product-line packages (separate migration line) |
| public | 10 | triage required |
| site | 10 | triage required |
| werkstatt | 10 | triage required |
| deploy | 9 | studio-ops plugin |
| evolution | 9 | triage required |
| generated | 9 | triage required |
| semantic | 9 | triage required |
| command | 8 | triage required |
| integrity | 8 | studio-ops plugin |
| jsonld | 8 | triage required |
| material | 8 | triage required |
| pipeline | 8 | triage required |
| project | 8 | triage required |
| runtime | 8 | triage required |
| seo | 8 | werkstatt-site dissolution (→ forge-astro/generic) |
| bordbuch | 7 | studio-ops plugin |
| cloudflare | 7 | triage required |
| funnel | 7 | triage required |
| kernel | 7 | triage required |
| maintenance | 7 | triage required |
| naming | 7 | triage required |
| participant | 7 | triage required |
| service | 7 | triage required |
| text | 7 | triage required |
| translation | 7 | triage required |
| visual | 7 | triage required |
| dht | 6 | triage required |
| feature | 6 | triage required |
| growth | 6 | triage required |
| isolation | 6 | triage required |
| referral | 6 | triage required |
| release | 6 | studio-ops plugin |
| shared | 6 | triage required |
| source | 6 | triage required |
| tokens | 6 | triage required |
| ts | 6 | triage required |
| video | 6 | triage required |
| behavior | 5 | triage required |
| billing | 5 | product-line packages (separate migration line) |
| cosmic | 5 | triage required |
| csp | 5 | triage required |
| demand | 5 | triage required |
| dns | 5 | studio-ops plugin |
| image | 5 | triage required |
| labels | 5 | triage required |
| lagebild | 5 | studio-ops plugin |
| matomo | 5 | triage required |
| print | 5 | triage required |
| ratgeber | 5 | triage required |
| swim | 5 | triage required |
| template | 5 | triage required |
| workpiece | 5 | triage required |
| a11y | 4 | triage required |
| ai | 4 | triage required |
| app | 4 | triage required |
| artifact | 4 | studio-ops plugin |
| asset | 4 | triage required |
| autonomy | 4 | triage required |
| bauakte | 4 | studio-ops plugin |
| composition | 4 | triage required |
| env | 4 | triage required |
| identity | 4 | triage required |
| indexnow | 4 | triage required |
| passport | 4 | triage required |
| pbp | 4 | triage required |
| pseo | 4 | triage required |
| remediation | 4 | triage required |
| sitemap | 4 | werkstatt-site dissolution (→ forge-astro/generic) |
| visibility | 4 | triage required |
| analytics | 3 | triage required |
| archetype | 3 | triage required |
| changelog | 3 | triage required |
| config | 3 | triage required |
| contract | 3 | triage required |
| css | 3 | triage required |
| diagnostic | 3 | triage required |
| ecosystem | 3 | triage required |
| editorial | 3 | triage required |
| effect | 3 | triage required |
| escalation | 3 | triage required |
| family | 3 | triage required |
| fingerprint | 3 | triage required |
| fonts | 3 | triage required |
| gitmesh | 3 | triage required |
| handoff | 3 | triage required |
| headers | 3 | triage required |
| i18n | 3 | triage required |
| icons | 3 | triage required |
| integration | 3 | triage required |
| legal | 3 | triage required |
| mirror | 3 | triage required |
| ownership | 3 | triage required |
| redirect | 3 | triage required |
| robots | 3 | triage required |
| route | 3 | triage required |
| scope | 3 | triage required |
| scripts | 3 | triage required |
| services | 3 | triage required |
| sites-check | 3 | triage required |
| subdomain | 3 | triage required |
| team | 3 | triage required |
| typography | 3 | triage required |
| ui | 3 | triage required |
| workspace | 3 | triage required |
| api | 2 | triage required |
| astro | 2 | triage required |
| audit | 2 | triage required |
| canonical | 2 | triage required |
| capability | 2 | triage required |
| catalog | 2 | triage required |
| chat | 2 | triage required |
| check-warpgogol | 2 | triage required |
| chrome | 2 | triage required |
| client | 2 | triage required |
| cms | 2 | triage required |
| component | 2 | triage required |
| constellation | 2 | triage required |
| coverage | 2 | triage required |
| did | 2 | triage required |
| docs | 2 | triage required |
| effects | 2 | triage required |
| entitlements | 2 | triage required |
| evidence | 2 | studio-ops plugin |
| faq | 2 | triage required |
| feed | 2 | triage required |
| gate | 2 | triage required |
| geo | 2 | triage required |
| gitattributes | 2 | triage required |
| heading | 2 | triage required |
| humans | 2 | triage required |
| hygiene | 2 | studio-ops plugin |
| layout | 2 | triage required |
| lighthouse | 2 | triage required |
| live | 2 | triage required |
| llms | 2 | triage required |
| manifest | 2 | triage required |
| nlweb | 2 | triage required |
| not-found | 2 | triage required |
| notausgang | 2 | triage required |
| offer | 2 | triage required |
| open-source | 2 | triage required |
| package | 2 | triage required |
| playwright | 2 | triage required |
| preview | 2 | triage required |
| props | 2 | triage required |
| resource | 2 | triage required |
| search | 2 | werkstatt-site dissolution (→ forge-astro/generic) |
| security | 2 | triage required |
| site-search | 2 | triage required |
| uni | 2 | triage required |
| validation | 2 | triage required |
| validator | 2 | triage required |
| warpgogol | 2 | triage required |
| yaml | 2 | triage required |
| access | 1 | product-line packages (separate migration line) |
| article | 1 | triage required |
| assets | 1 | triage required |
| authority | 1 | triage required |
| axiom | 1 | triage required |
| b2b | 1 | triage required |
| barrel | 1 | triage required |
| block | 1 | triage required |
| blog | 1 | triage required |
| blueprint | 1 | triage required |
| bodenstation | 1 | triage required |
| booking | 1 | triage required |
| breadcrumb | 1 | triage required |
| bundle | 1 | triage required |
| change | 1 | triage required |
| checks | 1 | triage required |
| ci | 1 | triage required |
| commit | 1 | triage required |
| comparative | 1 | triage required |
| consent | 1 | triage required |
| content-types | 1 | triage required |
| copy-values | 1 | triage required |
| craft | 1 | triage required |
| currency-pricing | 1 | triage required |
| customdomain | 1 | triage required |
| date | 1 | triage required |
| dedup | 1 | triage required |
| demands | 1 | triage required |
| deployment | 1 | triage required |
| deps | 1 | triage required |
| derived-prices | 1 | triage required |
| dispatcher | 1 | triage required |
| dna | 1 | triage required |
| e2e | 1 | triage required |
| enrich | 1 | triage required |
| entitlement | 1 | triage required |
| exec | 1 | triage required |
| first-party-data | 1 | triage required |
| footer | 1 | triage required |
| form | 1 | triage required |
| fs | 1 | triage required |
| generator | 1 | triage required |
| github | 1 | triage required |
| hdri | 1 | triage required |
| host | 1 | triage required |
| icon | 1 | triage required |
| import | 1 | triage required |
| infra | 1 | triage required |
| list | 1 | triage required |
| locale | 1 | triage required |
| materialanfrage | 1 | triage required |
| materialize | 1 | triage required |
| methodologies | 1 | triage required |
| migrator | 1 | triage required |
| mirroring | 1 | triage required |
| mobile | 1 | triage required |
| navigation | 1 | triage required |
| nebula | 1 | triage required |
| need | 1 | triage required |
| ops | 1 | triage required |
| outcome | 1 | triage required |
| overlay | 1 | triage required |
| packages-check | 1 | triage required |
| packages | 1 | triage required |
| pbt | 1 | triage required |
| person | 1 | triage required |
| planet | 1 | triage required |
| platform | 1 | triage required |
| pnpm | 1 | triage required |
| price | 1 | triage required |
| publication | 1 | triage required |
| pulsar | 1 | triage required |
| qa | 1 | triage required |
| rate-snapshot | 1 | triage required |
| root | 1 | triage required |
| routes | 1 | triage required |
| schema | 1 | triage required |
| shared-ui | 1 | triage required |
| sichtpass | 1 | triage required |
| signing | 1 | studio-ops plugin |
| sla | 1 | triage required |
| star-map | 1 | triage required |
| structure | 1 | triage required |
| styles | 1 | triage required |
| suppressions | 1 | triage required |
| system-md | 1 | triage required |
| system | 1 | triage required |
| thin-copy | 1 | triage required |
| trailing | 1 | triage required |
| trust | 1 | triage required |
| tsconfig | 1 | triage required |
| utility | 1 | triage required |
| validate | 1 | triage required |
| vite | 1 | triage required |
| warning | 1 | triage required |
| werk | 1 | triage required |
| wikidata | 1 | triage required |

## SDK gaps blocking studio extraction (found 2026-11-25, iteration 1)

1. ~~Lifecycle-hook runtime absent~~ — **CLOSED 2026-11-25**: hook modules self-describe and load fail-closed; `beforeIntegrate` vetoes in the drain, `afterIntegrate` notifies (commit 0db0f482). Design: module-path entries in `registers.hooks`, self-describing exports, duplicate refusal.
2. **Pipeline-step contributions** — werkstatt pipelines (build.post, validate.postbuild) compose steps; v10 has no plugin-contributed pipeline-step surface. Triage whether studio extraction needs it or whether pipelines become plugin commands outright.
3. **`init` does not sync plugin skills** (upgrade does) — marginal edge case (plugins rarely precede init); documented, not a blocker.

## Iteration 1 — P1 scaffold landed + P2 sequencing measured (2026-11-25)

**P1 complete in werkstatt session worktree**: `packages/werkstatt-studio` project-local v10 plugin scaffold — forge.plugin.yaml, SDK-port-only pilot command `studio.journal.tail`, wired into werkstatt forge.yaml plugins as v10 string entry. Proof points:
- v10 CLI (forge10 alias, npm 10.1.1) loads the project-local plugin through the standard SDK path and executes the pilot — zero engine/kernel/shared imports.
- **Coexistence proven**: v9 machinery (rfc.validate RFC-1645 pass) unaffected by the mixed plugins section — v10 bridge filters non-string entries (`cli-bridge.ts:31`), v9 ignores string entries.
- npm-shadowing hazard: pnpm workspace links shadow the same-name npm dep even at unsatisfiable versions — types resolved via tsconfig `paths` to the `forge10` alias (documented workaround; proper fix is vendored-forge retirement in P4).

**P2 extraction sequencing (measured cluster-internal dependency direction)**:

leaf-first (needed-by-count 0 — first waves): fleet, deploy, bauakte, sichtpass, workpiece, hygiene
middle: nachweis(2), evidence(2), leitstand(4), integrity(4), release(6)
foundation (extract last): journal(21, but already a shim — real logic in werkstatt-shared), mission(24), sternsystem(47), bordbuch(61)

**Design tensions filed for SDK iteration**:
1. ~~project-local plugins require pre-built dist~~ — **DISSOLVED (verified 2026-11-25)**: the SDK loader imports whatever path the manifest declares, and Node 24 strip-types handles `.ts` directly — project-local plugins can declare `src/commands/x.ts` with zero build step. Constraint: erasable-syntax-only (no enums/parameter properties — same as the forge CLI itself); type-only imports are erased so no runtime SDK resolution is needed. npm-published plugins stay compiled (portability).
2. `.git/forge/` state access through workspace-scoped fs port works but is conventionally invisible — studio ops need a declared forge-state SDK port (evidence access port exists; journal/state surface review needed).

## SDK gap discovered in P1: forge-state reachability (P2 design blocker)

The workspace port sandboxes every path to the workspace root (`scoped()` in `sdk/context.ts` denies escape). Consequence for studio extraction:

- **Primary checkout**: `.git` is a real directory inside root → `.git/forge/journal.jsonl` reachable through `filesystem: read`.
- **Session worktree**: `.git` is a 124-byte pointer file (`gitdir: <common>/.git/worktrees/<name>`); the journal lives in the COMMON git dir — outside the worktree root — and is **unreachable through current SDK ports**. The pilot's `pass/total:0` in the worktree is this boundary, not broken semantics.

Design decision needed before journal-dependent extraction (journal is needed-by-21, bordbuch/flow evidence share the space):

1. **Option A — gitdir-aware workspace extension**: the workspace port resolves `.git/...` through git-common-dir indirection (parse the pointer file). Small surface, but plugins learn git layout.
2. **Option B — `ctx.forgeState` host port** (preferred direction): the host exposes journal/evidence/flow-state reads as named port methods; plugins never know `.git` layout at all. Matches the port-and-capability philosophy — the sandbox boundary stays absolute while forge's own state space becomes a first-class capability.

Either way the capability model needs a distinct grant (`forgeState: read`?) rather than widening `filesystem` — the sandbox escape denial is a load-bearing security invariant and must not weaken.

## P2 sequencing correction: outbound coupling measured (P1 validation pass)

The leaf-first heuristic (zero inbound cluster deps) is necessary but not sufficient — extraction order is governed by OUTBOUND coupling, because a plugin command may only use what SDK ports provide. Measured cross-cluster imports of the six leaf candidates:

| candidate | real cross-cluster deps | extraction implication |
|---|---|---|
| deploy | ~none (fingerprint/integrity primitives, self-contained) | **wave-2 first candidate** — expressible against current ports |
| workpiece | mission (1, heaviest cluster) | blocked on mission-port design |
| bauakte | dns, leitstand, sternsystem | needs sternsystem/leitstand ports |
| sichtpass | bordbuch, nachweis | needs bordbuch/nachweis ports |
| fleet | bordbuch, journal, kernel, ownership, sternsystem | cluster-extract with bordbuch, not before |
| hygiene | evidence, kernel, mission, sternsystem, werkstatt | heaviest leaf — late wave |

Sharper framing: the extraction unit is the COMMAND, not the cluster. Wave-2 scan enumerates commands inside deploy/fleet/hygiene whose implementation touches only filesystem/git-read/process — those extract against current SDK ports immediately; commands needing journal/bordbuch/mission semantics wait for the forgeState port decision (P2 design blocker above).

## Wave-2 port-gap analysis: deploy cluster (concrete)

`deploy.status`/`artifact-verify`/`artifact-gc` semantics mapped against current SDK ports:

| need | current SDK | gap |
|---|---|---|
| read files inside workspace | `workspace.readFile` | none |
| symlink target resolution (`readlink`) | — | **missing port** — deploy is atomic symlink swaps; `readFile` follows links, cannot read the link itself |
| symlink creation for atomic swap | — | **missing port** — belongs behind `filesystem: readwrite` |
| byteHash tree hashing | — | pure function, copy into plugin (no port needed) |
| ed25519 signature verify (artifact-verify) | — | decision: copy verification primitive into plugin vs `ctx.crypto` port — verification is pure/readonly, copying defensible |
| directory listing | `workspace.list` | shallow only — recursive walk needed for gc; implement in-plugin over `list` |

Pattern note: kernel `WorkspaceIO` → SDK port translation is mostly mechanical for filesystem; the result-shape translation (`KernelCommandResult` → plugin verdict) is the actual rewrite work per command.

## forgeState port design sketch (option B — now evidence-backed)

The decisive argument for option B already exists inside the SDK: `evidence.consult` is host-implemented (`host.hooks.evidenceConsult`) and crosses the sandbox boundary cleanly — the plugin never knows where evidence lives. The journal/flow-state space is the same shape. Sketch:

```typescript
// capability: forgeState: "none" | "read" | "readwrite" — distinct dimension,
// never a widening of filesystem
ctx.forgeState = {
  journal: {
    tail(count): Promise<JournalRecord[]>   // read grant
    // append behind readwrite — write side deferred until a mutating consumer exists
  },
  // flow.state, evidence mirror reads — same pattern as they extract
}
```

Host implementation resolves the git common dir (rev-parse or pointer-file parse) once at context construction — plugins never observe paths. Open questions for the P2 decision record: journal record typing (generic jsonl rows vs typed kinds), whether tail is line-count or time-windowed, consistency semantics when the journal rotates.

## P1 closure evidence (2026-11-25 late)

**WP-8 P1 COMPLETE.** werkstatt develop `439e7133c` carries `f08a52209` (scaffold) + `c17c00de6` (strip-type .ts zero-build modules); session worktree/branch cleaned by the flow machinery. Post-integration smoke in primary: `studio.journal.tail` executes through the v10 CLI bridge and reads the real journal — `total: 1026, count: 5` — confirming the semantic analysis: primary checkout works (`.git` is a real directory inside the sandbox), worktrees degrade (`total: 0`) until the forgeState port decision lands. Observation for journal-record typing: records render `kind: unknown` — the journal schema's discriminator field differs from the pilot's assumption; correct typing belongs to the forgeState port design.

### Journal record typing — measured against the real journal

The live journal (`.git/forge/journal.jsonl`, 1026 records in werkstatt) is the flow machinery's audit log: `{at, event, branch, sha, detail, rule?, toleratedDirt?, toleratedState?}` — discriminator `event` (values observed: `open`, `integrate-refusal`, …), not the pilot's assumed `kind`. The forgeState port types records as `{at: string; event: string; branch?: string; sha?: string; detail?: string; [k: string]: unknown}` — open-ended by design since the machinery evolves the schema.

## Wave-2 capability surface — COMPLETE (forge 10.1.2, pending matrix+publish)

Per-command extraction table for the deploy cluster against the completed SDK:

| command | ports needed | status |
|---|---|---|
| deploy.status | readFile, exists, readlink, stat | **extractable now** — pure read |
| atomic.swap | + symlink, unlink, rename, processSpawn | extractable — write-backed |
| atomic.rollback | same as swap | extractable — write-backed |
| artifact.gc | + rm recursive, list walk | extractable — write-backed |
| artifact.verify | + envKeys (signing pubkey), verify primitive copied | extractable — env allowlist |
| artifact.build | + envKeys (signing secret), processSpawn heavy | extractable — the secrets-sensitive one; envKeys allowlist is exactly the transparency boundary |

SDK additions in 10.1.2 closing the surface: symlink triple (readlink/symlink/unlink), extended fs (readFileBytes/rename/rm/stat), env port enforcing the envKeys allowlist, git capability hardening. Remaining per-command work is mechanical translation (kernel result shape → plugin verdict shape) plus copying two pure primitives (byteHash, ed25519 verify) — no further SDK design needed for the deploy wave.

## Translation pattern (wave-2 reference — deploy.status concrete)

Kernel shape → plugin shape is a three-part mechanical translation:

```typescript
// BEFORE (kernel handler): runDeployStatus(input, context)
//   context.io.readFile/exists — ambient workspace io
//   readSymlinkBasename(currentSymlinkPath(root), io) — helper over io
//   return { data, exitCode: 0, summary, nextSteps }

// AFTER (plugin command module):
export default {
  id: "studio.deploy.status",
  scope: "repo",
  description: "Report current platform deployment status",
  async run(ctx) {
    const cur = await readlinkOrNull(ctx, ".werkstatt/artifacts/platform/current");
    const prev = await readlinkOrNull(ctx, ".werkstatt/artifacts/platform/previous");
    let gitSha = null, builtAt = null;
    if (cur && await ctx.workspace.exists(artifactManifest(cur))) {
      try { const m = JSON.parse(await ctx.workspace.readFile(artifactManifest(cur))); gitSha = m.gitSha ?? null; builtAt = m.builtAt ?? null; } catch {}
    }
    return { status: "pass", data: { currentHash: cur, previousHash: prev, currentGitSha: gitSha, deployedAt: builtAt } };
  },
}
```

Translation rules: (1) `context.io.X` → `ctx.workspace.X` one-to-one except `readSymlinkBasename` which becomes direct `readlink`; (2) `exitCode: 0/1` → `status: pass/fail` with violations carried in `data` when the kernel shape embedded them; (3) `nextSteps` drop — plugin results are machine-consumed by the CLI bridge, operator guidance lives in `message`; (4) absolute-path helpers (`currentSymlinkPath(root)`) become root-relative literals because the SDK sandbox re-roots anyway. Estimated per-command effort: small — the largest deploy file is 138 lines.

## Wave-2 first extraction — PARITY PROVEN (2026-11-26)

studio.deploy.status extracted and verified in the wave-2 session worktree:

- **semantic proof**: readlink resolution through the 10.1.2 host — fixture symlink current→abcdef1234567890 resolved, manifest gitSha deadbeefcafe parsed, previous link read
- **parity EXACT**: engine deploy.status and studio.deploy.status produce identical verdicts on the same fixture (current/sha/previous byte-equal) — the WP-9 dark-run quality bar holds for extraction
- translation effort confirmed mechanical: 83-line kernel handler → ~60-line plugin module in one pass, no design decisions needed beyond the documented pattern
- host-version sensitivity discovered: the plugin needs host 10.1.2 at RUNTIME (readlink port) — plugin type-only imports mean version coupling is a host-runtime concern, not a compile-time one; the forgeRange manifest field is the enforcement surface
- npm two-stage replication reconfirmed: version-doc 200 preceded tarball 200 by ~15 minutes; publish pipeline staging showed 409-on-retry as the tell that the first publish landed server-side

### Operational hazard confirmed: werkstatt v9 machinery carries the inert-ignore phantom

The wave-2 integrate refused on node_modules/.pnpm/robots-parser .gitignore phantom dirt — the CX-142 inverse problem. The fix shipped in forge 10.1.1 but werkstatt flow.integrate runs on the VENDORED v9 machinery which will never receive it. Every werkstatt integrate is one npm-shipped-.gitignore away from refusal until the v10 self-host migration completes (the WP-8 endgame itself). Interim: preemptive cleanup per runbook. This is additional evidence for prioritizing the migration over perfectionism in extraction ordering.

## forgeState port — DECISION RESOLVED, implemented (forge develop bb9dc6a)

Option B implemented as designed: resolveGitCommonDir parses the worktree pointer file without spawning git (primary layout and worktree layout both covered), journal.tail/size behind the distinct forgeState manifest grant. 8/8 tests green including the decisive boundary proof: worktree journal readable through the port while ctx.workspace correctly cannot see it. Ships with the next minor (10.2.0 — additive minor surface, not patch). Wave-3 journal-consuming extraction is unblocked at the SDK level; the werkstatt-studio pilot journal-tail migrates to the port when 10.2.0 publishes.

### Wave-2b open decision: signature-verification primitives sourcing

artifact.verify/swap need ed25519 verification over canonical-json — consensus-critical byte-compat. Three sourcing options:

1. **Copy canonical-json + use @noble/ed25519 as plugin dep** — copies of consensus-critical canonicalization are a divergence hazard: a plugin/engine drift fails signatures falsely.
2. **Depend on @warpgogol/werkstatt-shared/signing** — werkstatt-shared is npm-published; the signing subpath is pure primitives. Cost: reintroduces a limited shared dependency the extraction is escaping — but scoped to one subpath, arguably legitimate as a versioned library dependency rather than the scopeless bag.
3. **Host crypto port** (`ctx.crypto.verifyEd25519`) — moves verification behind the SDK boundary; the host owns canonicalization. Cost: crypto is pure computation, no host privilege needed — port-ifying it contradicts the inventory's own copy-pure-primitives guidance, but consensus-critical code is arguably different from byteHash.

Recommendation direction: option 2 as the pragmatic middle — one versioned subpath dep, zero copied consensus code. Decision belongs to the wave-2b session with artifact.verify in hand. Hash-only verification (unsigned artifacts) needs NO crypto at all and can proceed in any case.

## Wave-2b write-cluster extraction — lifecycle proven (2026-11-26)

Four commands extracted in the wave-2b session, full lifecycle chain verified end-to-end on fixtures through the 10.1.2 host:

- verify: pass for valid artifact, fail for corrupted dist (both polarities)
- swap: REFUSES unverified artifacts (verify-composition proof — surfaced accidentally when a fixture rebuild added a trailing newline; the refusal is exactly correct behavior), successful swap shifts current into previous correctly
- rollback: engine parity confirmed including the subtle detail — only current is re-pointed, so current==previous after rollback
- gc: dry-run candidate identification exact, real run deletes unreferenced beyond retention, referents protected

Design notes confirmed in practice: atomicSwap via SDK ports eliminates the ln(1) process spawn entirely (symlink+rename same atomicity); signature sourcing resolved as workspace dep on werkstatt-shared/signing (option 2); tree-hash algorithm copied with exact parity (simple deterministic scheme, not consensus-critical canonicalization). A first rollback implementation bug (extra previous-shift) was caught against engine source — reading the exact engine tail semantics matters even for small commands.

## Wave-2b hardening discoveries (2026-11-26)

Signed-path verification (proven end-to-end after fixes, both polarities):

1. **werkstatt-shared strip-types incompatibility** — kernel/journal.ts TornLineError and kernel/workspace-io.ts KernelMetaError used constructor parameter properties; Node strip-types rejects them, breaking the whole signing import chain at runtime. Same defect class as the forge 10.1.1 regression. Fixed as explicit field assignments. Lesson: every package consumed through source-.ts imports needs a strip-only smoke test in CI — typecheck does not catch this.

2. **coreVersion dist-layout bug (forge SDK)** — the compiled loader sits one level deeper than source; the ../../package.json probe missed, silently fell back to "10.0.0", and any plugin declaring forgeRange >=10.0.1 was rejected at load. Fixed by probing both layouts with package-name validation; regression test simulates dist depth. Ships in 10.2.0.

3. **env resolution parity** — engine requireEnv semantics decoded exactly: .env fills only keys absent from process env (process wins), quote-strip then backslash-n expansion applies to ALL values. Initial extraction had both backwards.

4. **PRE-EXISTING ENGINE DEFECT (filed for decision, not fixed):** deploy.artifact.build signs the eight-field manifest object (including signature:"" and signatureAlgorithm) while deploy.artifact.verify reconstructs a six-field payload — canonical bytes can never match, so no engine-signed artifact can ever pass verification. Masked in production because signing failure degrades to unsigned artifacts which pass hash-only. The extraction replicates the verify side exactly; the defect is parity-neutral (both implementations behave identically) but must be deliberately repaired or documented before artifact.build extraction — a fix changes consensus-critical signed bytes.

5. **toPem/publicKeyPemToBytes asymmetry in werkstatt-shared** — toPem armors raw key bytes while publicKeyPemToBytes expects real DER SPKI via createPublicKey; the pair does not roundtrip. Production keys come from node crypto generateKeyPairSync — fixtures must replicate that path.

## Wave-2c artifact.build extraction analysis (2026-11-26)

The final deploy command is the hardest by design — needs assessment:

- turbo run build orchestration: io.exec pnpm with 5-minute timeout — requires processSpawn: true in the manifest (the capability exists precisely for this differentiation; the write-cluster correctly stays false)
- cp -r directory copies via spawn — either per-file SDK copy loop (slow for large trees) or a copyDir port candidate
- git rev-parse HEAD — read-only git, covered
- dirent-aware readdir — per-entry stat pattern already proven in gc
- SIGNING DECISION POINT: extraction collides with the filed engine defect — replicating eight-field sign input preserves byte-parity with engine-built artifacts (and their never-verifying signatures), fixing it changes consensus bytes. This is an operator-level decision, not an implementer one — must be resolved before wave-2c starts
- WORKSHOP_ID env with hostname fallback — covered by env port

Sequencing recommendation: resolve the sign-semantics decision first; consider whether build orchestration belongs in a plugin at all vs remaining a host-level operation the plugin composes.

## Wave-2b INTEGRATED into werkstatt develop (2026-11-26)

Commits landed: 167bd675f (extraction) + fa8f7430c (hardening) + abbeb3f7c (manifest regen). All six plugin commands present in primary tree. Deploy cluster extraction status: 5/6 commands migrated (status, artifact.gc, artifact.verify, atomic.swap, atomic.rollback) — only artifact.build remains (wave-2c, blocked on the sign-semantics operator decision).

IMPORTANT SEQUENCING NOTE: the plugin manifest requires forge >=10.1.2, but published 10.1.2 carries the coreVersion bug (reports 10.0.0) and REJECTS the plugin at load. The werkstatt forge10 pin must bump to 10.2.0 (published, propagating) before the plugin family loads in production use. Until then the extractions are dormant-but-integrated.

## Wave-2c doctrine resolution (2026-11-26)

The sign-semantics question resolves by doctrine, not operator decision: dark-run parity means extraction replicates engine behavior EXACTLY — including the eight-field sign input. The defect is orthogonal: filed as werkstatt F-0401, fixed (or documented-as-vestigial) through the engine's own governance, and the plugin then tracks the fix in a synchronized change. Extraction never repairs behavior, even broken behavior. wave-2c is unblocked on that axis; remaining complexity is processSpawn capability scoping and copyDir port economics.

## Wave-3 journal-tail forgeState migration — proven (2026-11-26)

The first consumer of the forgeState host port is migrated and proven end-to-end: studio.journal.tail no longer touches .git/forge/journal.jsonl through the workspace filesystem port. Decisive proof shape: the command was run from INSIDE a linked worktree — the port resolved the gitdir pointer host-side and returned real journal records (total 1040) with correct schema fields, where the workspace-port version was structurally blind.

Chain validated in the same stroke: forge 10.2.1's capability registration fix works (manifest declares forgeState: read, plugin loads), and the output schema correction is documented — the pilot emitted kind/opId/ts fields that never existed in real journal records; the migration emits the measured event/branch/sha/at shape.

Design note for future journal consumers: forgeState.journal returns oldest-first tails; size() is the cheap existence probe. The draft at docs/forge-v10/wave3-journal-tail-forgestate.draft.ts matches the shipped implementation.

## SDK design question — processSpawn capability unsoundness (2026-11-26)

Discovered during wave-2c design analysis: processSpawn as a boolean is a meta-capability that trivially subsumes every other grant. A plugin with processSpawn:true and gitMutation:false can simply spawn git push directly — the capability model is unsound wherever spawn is granted. The current implementation is honest about timeouts and uses execFile (no shell injection), but binary-level scoping is absent.

Options for wave-2c-era hardening:

1. Binary allowlist — processSpawn becomes string[] naming exact binaries (manifest-transparent, auditable); documentation must honestly state that spawning a side-effecting binary is equivalent to trusting the plugin with those effects
2. Deep integration — spawn of git re-applies the gitMutation subcommand analysis at spawn level; principled but complex and fragile (arg parsing duplicated)
3. Document-only — declare processSpawn a fully-trusted grant, keep boolean; cheapest but the manifest surface stops being informative

Recommendation: option 1 — it preserves the manifest as an honest audit surface without pretending to containment that spawn cannot provide. artifact.build needs exactly [pnpm, cp, git] which reads well in a manifest. This is a forge SDK change requiring its own release cycle — sequenced before wave-2c extraction starts, since artifact.build is the first spawn-needing consumer.

## Probe-ratchet state-dependence observation (2026-11-26) — RESOLVED

The FRICTION-02 whipsaw is fully decoded; it was never flaky — every refusal was
correct given the evidence visible at that moment.

**Liveness mechanics (werkstatt v9, liveness.ts + gate-probe-catalog.ts):**
liveness is `fixture` (bound fixture whose last probe run passed), `fired`
(counters journal / committed counters artifact / shared flow-journal refusal
ids carry an emission), else `none`. Evidence joins on `<contract>/<ruleId>`.
The counters journal is **worktree-local**; only the committed artifact
(`docs/metrics/check-counters.generated.yaml`, diagnostic > 0) and the shared
flow journal (`<commonGitDir>/forge/journal.jsonl`) transfer across checkouts.

**The trap chain:** (1) in the wave2b-followup worktree, friction.validate ran
while F-0401 still carried the invalid category `defect` — FRICTION-02 FIRED,
and the emission landed in that worktree's counters journal; (2) the ratchet
therefore saw FRICTION-02 as stale-baseline (PROBE-07) and the sanctioned
shrink-only regeneration REMOVED it (890→629); (3) the follow-up worktree was
then discarded — the counters journal, the only evidence, died with it; the
committed counters artifact still shows `frictions/FRICTION-02 diagnostic: 0`
because the firing never reached the committed projection; (4) in the wave-3
worktree the rule therefore has liveness `none` AND no baseline cover —
structurally unintegrable: PROBE-06 in every integrate, while a passing
friction.validate run (clean tree) can never regenerate firing evidence.

**RFC-1642 is the designed escape hatch and it works:** `noneRules` filters
`!bound.has(ruleId)` — a declared fixture binding IS liveness for ratchet
purposes, independent of ephemeral run journals. Resolution implemented:
`docs/gate-probes/frictions/FRICTION-02/fixture.yaml` — a schema-valid friction
record seeded with `category: defect` (the exact value that fired the rule
originally) at the real scan path `docs/frictions/F-9999.yaml`, transiently
injected + restored by gate.probe. Probe result: PASS, exactly 1 FRICTION-02
diagnostic, no collateral rule firings (tight seed — everything except the
category is valid). `gate.probe.catalog --check` then: newUnprobed [], stale [],
exit 0.

**Fixture-authoring notes for future probes:** friction.validate emits
Diagnostic-shaped `errors`/`warnings` with `file` pinned to the constant
FRICTION_DIR, so `expect.pathPattern` can never match — omit it; the probe is
still tight because the tree is otherwise clean. FLOW-INT-19's dup scan is
path-scoped to docs/rfcs|adrs|frictions for files and its rule-literal scan
covers only V-*/RFC-IMP-*/FLOW-*-* families — an `id: F-9999` literal inside
docs/gate-probes/ is invisible to it.

**Residual design question (for werkstatt, not WP-8):** firing evidence that
exists only in a doomed worktree's counters journal should probably be
captured into the committed counters projection at integrate time — as-is,
the ratchet punishes exactly the sessions that productively exercised a rule.

## Wave-3 INTEGRATED (2026-11-26)

`flow.integrate` verdict: `auto/session-261126-03-wave3-forgestate integrated
(9516b009b → 7bd4b4aa7), cleanup done` — exit 0, machinery-discarded worktree.

Landed on werkstatt develop:
- `3071158aa` journal-tail migrated to the forgeState host port (reads across the
  worktree pointer boundary; correct event/opId/ts schema; pin 10.2.1, forgeRange >=10.2.1)
- `7bd4b4aa7` FRICTION-02 probe fixture — the ratchet paradox resolution (first
  frictions-contract fixture; PASS with exactly 1 diagnostic on the seeded
  `category: defect` violation)

The integrate gate's probe-ratchet step passed with the fixture binding in the
branch — confirming RFC-1642's "bound fixture is liveness" semantics end-to-end
in production conditions.

## Wave-2c artifact.build — implementation proof complete (2026-11-26)

First spawn-needing extraction. Runtime proofs in the wave2c session worktree,
npm-hosted forge 10.3.0 host (production-real chain):

- unsigned build: pass — correct `<pkg>/dist/` nesting layout, tree hash, gitSha
  resolution, 8-field manifest exactly as engine
- composition: wave-2b verify passes on the wave-2c artifact (hash parity end-to-end)
- reuse path: identical-content second build takes the exists-branch (output shape
  parity — indistinguishable, as in the engine)
- signed build: signature written (128 hex chars, ed25519)
- **F-0401 doctrine proof**: signed artifact verifies sig:false + verdict false —
  the extraction replicates the sign(8-field)/verify(6-field) roundtrip defect
  exactly; the engine fix tracks independently through werkstatt F-0401

Extraction findings fed back:
- WorkspaceIOPort has no mkdir — writeFile creates parents implicitly, but empty
  staging dirs need creation before cp. Resolved by spawning `mkdir -p` through the
  processSpawn allowlist (semantically exact io.mkdir equivalent). Surface-gap
  candidate for a future SDK minor: a scoped mkdir port.
- allowlist consumer syntax proven: `processSpawn: [pnpm, cp, git, mkdir]` in the
  manifest yaml maps to the array form directly; basename matching covers bare
  binary names.
- envKeys honest expansion: SIGNING_PRIVATE_KEY + WORKSHOP_ID + HOSTNAME declared —
  the env port gates every read, .env file fallback needs no declaration
  (filesystem channel).

## Deploy module boundary correction (2026-11-26)

The engine `deploy` module is exactly 6 commands (status, artifact.build/gc/verify,
atomic.swap/rollback) — wave-2c completes it 6/6. The remaining deploy.*-named
commands belong to other modules: deploy.preflight + deploy.scripts.validate are
module `check`, deploy.smoke.run is module `testing` — they migrate with those
ownership lines, not the deploy cluster.

## Wave-2c INTEGRATED — engine deploy module migration COMPLETE 6/6 (2026-11-26)

`flow.integrate` verdict: `auto/session-261126-02-wave2c-artifact-build integrated
(7bd4b4aa7 → c3ee91a48), cleanup done`. werkstatt develop now carries the full
deploy module extraction on npm-published forge 10.3.0:

- studio.deploy.artifact.build — the first spawn-needing extraction, first
  processSpawn array-allowlist consumer `[pnpm, cp, git, mkdir]`
- pin forge10 10.3.0 in root + studio package.json; forgeRange >=10.3.0;
  envKeys honestly expanded (SIGNING_PRIVATE_KEY, WORKSHOP_ID, HOSTNAME)

One integrate retry needed: FLOW-INT-01 on the robots-parser nested-.gitignore
phantom (the ls-files-descends-vs-check-ignore git-semantics corner, RFC-1616
territory) — noise deleted, retry green. This phantom has now cost retries in
three consecutive sessions; a friction record for systematic treatment belongs
in the next werkstatt batch (candidate: extend DISPOSABLE_PATH_RULES by RFC-1531
amendment so --auto-clean covers it).

WP-8 deploy cluster is the first FULLY migrated engine module — the extraction
methodology is now proven across the full difficulty spectrum: read-only paths
(status), write-backed lifecycle (gc/verify/swap/rollback), host-state boundary
(journal-tail via forgeState), and spawn-needing builds (artifact.build).
