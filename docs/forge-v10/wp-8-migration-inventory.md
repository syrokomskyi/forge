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

## Wave-4 feasibility scan (2026-11-26) — per-file dependency profile, studio-ops dirs

Heuristic per-file scan (markers: spawn/env/invoke/network/git; cross-cluster
imports excluding kernel/shared). Caveat: intra-cluster closure not measured —
a clean handler may still import a coupled sibling; verify per-command before
extraction. Raw output:

```
=== per-cluster handler profile ===

## mission
  clean: -
  coupled: mission-materialization-commands.ts->bordbuch,handoff,journal

## leitstand
  clean: -
  coupled: access-commands.ts->sternsystem leitstand-commands.ts->artifact-store,integrity,sternsystem

## journal
  clean: check-blocking.ts[fs-only] jsonl.ts[fs-only] runner.ts[fs-only] sweep.ts[fs-only]
  coupled: -

## nachweis
  clean: nachweis-cloudflare-agent-readiness-measure.ts[env+network] nachweis-key-ensure.ts[fs-only] nachweis-lighthouse-measure.ts[spawn+env] tsa-adapter.ts[network]
  coupled: nachweis-approve.ts->bordbuch,werkstatt nachweis-assessment-ingest.ts->bordbuch,werkstatt nachweis-consent.ts->bordbuch,werkstatt nachweis-ingest.ts->bordbuch,werkstatt nachweis-io.ts->evidence,sternsystem nachweis-manifest.ts->bordbuch,werkstatt nachweis-public-derivative.ts->bordbuch,werkstatt nachweis-publish.ts->bordbuch,werkstatt

## fleet
  clean: claims-commands.ts[fs-only] ownership-commands.ts[fs-only]
  coupled: -

## sternsystem
  clean: build-identity-path.ts[fs-only] cache-clone-marker.ts[fs-only] channel-migration.ts[fs-only] external-edit-collector.ts[spawn] live-drift.ts[fs-only] passport-staleness.ts[fs-only] pin-helpers.ts[fs-only] provision-external-resources.ts[fs-only] seed-from-intake.ts[fs-only] site-hosting.ts[fs-only]
  coupled: external-edit-guard.ts->handoff handover.ts->werkstatt passport.ts->bordbuch provisional-host.ts->leitstand registry-io.ts->mission,werkstatt sternsystem-channels-migrate.ts->mission,werkstatt sternsystem-extract.ts->bordbuch,handoff,migrators sternsystem-handover-cancel.ts->mission,werkstatt

## integrity
  clean: integrity-commands.ts[env] run-backfill-revisions.ts[fs-only] run-init.ts[fs-only] run-record-build.ts[fs-only] run-update.ts[fs-only] run-verify.ts[fs-only]
  coupled: -

## bordbuch
  clean: bordbuch-status.ts[fs-only] bordbuch-validate.ts[fs-only]
  coupled: bordbuch-append.ts->werkstatt bordbuch-commit-helper.ts->sternsystem bordbuch-commit.ts->sternsystem,werkstatt bordbuch-generate.ts->werkstatt bordbuch-hook.ts->mission bordbuch-io.ts->mission,sternsystem,werkstatt bordbuch-repair.ts->sternsystem,werkstatt

## hygiene
  clean: anomalies.ts[fs-only] hygiene-audit.ts[fs-only] hygiene-policy.ts[fs-only] protection.ts[fs-only]
  coupled: classes.ts->mission,sternsystem gc.ts->evidence,mission,sternsystem hygiene-gc.ts->werkstatt

## artifact-store
  clean: -
  coupled: artifact-store-commands.ts->werkstatt

## evidence
  clean: evidence-fetch.ts[fs-only] evidence-sync.ts[fs-only] r2-client.ts[fs-only]
  coupled: resolve-system-id.ts->m
```

**Headline candidates**:
- **integrity — FULLY clean**: zero coupled files cluster-wide; handlers fs-only
  (only integrity-commands touches env). Signing primitives already in
  werkstatt-shared (proven in wave-2b). Wave-4 primary candidate.
- observability — fs-only validators extractable, but network-needing commands
  (signoz api client) need a network-capability decision first.
- signing — single fs-only command file, tiny.
- fleet claims/ownership commands — fs-only.
- hygiene audit chain — files clean but classes.ts/gc.ts couple to
  mission/sternsystem/evidence, confirming the inventory's late-wave verdict.

## Wave-4 structural finding — the extraction wall and the state-spaces port design (2026-11-26)

Per-command closure analysis across all 156 workspace-scope studio-ops commands
(manifest scope field, verified per-file): **no more mechanically-extractable
commands exist**. Deploy (6/6 done) and journal-tail (done) were the only
workspace-local commands. Everything else is blocked on the werkstatt state
topology — state lives OUTSIDE the extraction workspace by design:

| state space | physical location | consuming clusters | resolution |
|---|---|---|---|
| cache-clone ledger | `systems-cache/<id>/` — SIBLING of repo | bordbuch (events.ndjson), sternsystem registry/passport, nachweis, mission material | per-system clone path |
| primary-root state | `<primary>/.werkstatt/` — artifacts, releases, fleet-claims | artifact-store, hygiene, release, fleet | worktree→primary pointer |
| forge state | `<commonGitDir>/forge/` | journal (SOLVED — forgeState port) | gitdir pointer parse |
| evidence/R2 | network object storage | evidence.fetch/sync, observability | network capability |

Scope correction: ALL integrity.* commands are scope:app (they operate inside
site workspaces — a different extraction line, probably werkstatt-site
dissolution), so the integrity cluster is NOT a studio candidate despite its
clean scan profile. The scan artifact above predates this scope filter.

### The design unlock: semantic state ports (forgeState generalized)

The forgeState port already proved the shape: host-implemented semantic
operations crossing the sandbox boundary, capability-gated per domain, plugins
never observe host paths. evidence.consult is the second existing instance.
Generalize per domain:

```
ctx.hostState = {
  // capability: hostState artifactStore: "none" | "read" | "readwrite"
  artifactStore: {
    get(id), put(blob, meta), gc(policy), validate(id) — semantic ops over
    <primary>/.werkstatt/artifacts, host resolves worktree→primary
  },
  // capability: hostState bordbuch: ...
  bordbuch: {
    read(systemId), append(systemId, entry), validate(systemId)
    — host resolves systems-cache/<id>/bordbuch/events.ndjson
  },
  // sternsystem registry/passport, fleet claims, nachweis ledgers — same shape
}
```

Design principles (from forgeState evidence):
1. **Semantic operations, never path passthrough** — a port exposing raw host
   paths is a filesystem widening in disguise; operations name domain objects
   (systemId, artifact id), the host owns resolution.
2. **Capability per domain, never one wide grant** — manifest audit surface
   stays honest about WHICH state spaces a plugin touches.
3. **Read first, write deferred** — forgeState set the precedent (write side
   deferred until a mutating consumer exists); the same per-domain ordering
   applies, except where the extraction target is inherently mutating
   (artifact-store put/gc) — those need the write side in their first version.
4. **Locking is host-mediated** — acquireLock/releaseLock semantics cross the
   same boundary (locks live in shared state); the port carries lock operations
   or the host serializes internally.

Sequencing consequence: wave-4 is NOT a command wave — it is this port design
+ forge SDK implementation + release, THEN command waves resume with
artifact-store (4 commands, smallest rwp-blocked cluster) as the first consumer.

Open design questions for the implementation session:
- cache-clone resolution needs systemId→clone-path topology knowledge host-side
  (systems-cache sibling-of-repo convention — how does the host learn the
  sibling location when the plugin runs deep inside the repo? Probably:
  workshop layout resolution at context construction, same as forgeState's
  gitdir parse — measure resolveCacheClonePath's actual logic first)
- locking semantics across concurrent worktrees — the engine's acquireLock is
  file-based in shared state; host mediation must preserve the deadlock/
  stale-lock recovery behavior (werkstatt.lock.* commands exist for this)
- does the port version independently per domain, or one hostState version?

## artifactStore spaces port — implemented on forge develop (2026-11-26), release 10.4.0 in flight

First generalization of the forgeState pattern, implemented and tested:

- `artifactStore: "none" | "read" | "readwrite"` capability; WorkspaceIO-shaped
  port rooted at `<primary>/.werkstatt/artifacts`, resolved through the gitdir
  pointer PER CALL (context construction stays synchronous)
- implementation: one scoped-port factory (`makeScopedPort`) behind workspace +
  space ports; `makeDeferredSpacePort` wrapper for per-call root resolution;
  reads degrade to absent-shape, writes refuse with plain topology error when
  no git state exists — never capability violations
- tests 6/6 including the decisive worktree-boundary proof: writes land in the
  primary store, nothing leaks worktree-local; path escapes refused;
  undeclared grant denies

Design decisions taken (resolving the wave-4 open questions):
- flat per-space capability dimensions (forgeState shape), not nested config —
  loader stays simple, consistency guard covers registration
- the space root is domain-scoped (`.werkstatt/artifacts` exactly), not the
  wide primary root — the second consumer's space gets its own dimension when
  it arrives, no premature wide grants
- cache-clone resolution needs NO pointer: `../systems-cache` is
  worktree-invariant because session worktrees are siblings of the primary at
  the same depth — the cache space port (when built) resolves trivially

## artifactStore granularity — design pivot question discovered in wave-4 prep (2026-11-26)

The committed 10.4.0 port roots at `<primary>/.werkstatt/artifacts` — narrow by
design. Engine reading during extraction prep surfaced a boundary problem:

`artifact.store.put` writes BOTH the content-addressed store AND
`<primary>/releases/<releaseId>/artifact.tar.gz` (+ reads `release.yaml` there).
releasesDir lives at `<primary>/releases` — OUTSIDE the artifacts space. The
narrow port is therefore insufficient for put parity (fine for validate/gc
reads, likely).

Options weighed:
- **per-domain spaces** (artifactStore + releases + fleetClaims + …): maximal
  honesty per domain, but a put-class command needs 2+ grants and the
  capability surface multiplies toward a dozen dimensions
- **one `primaryState` space rooted at the primary checkout**: mirrors the
  workspace `filesystem` grant's granularity exactly — the existing model
  already treats whole-root scoping as the honest unit. Consistent, one
  dimension, but loses per-domain narrowing and a readwrite grant can bypass
  the integrate gate by writing the primary tree directly (forge.yaml, hooks).
  Note: plugins run in-process — capabilities are audit/accident boundaries,
  not security walls, so the escalation is real but bounded.

Leaning: keep `artifactStore` as shipped (additive, non-breaking), extract
validate/gc first (they fit), and decide the put/release-write granularity
with the second consumer's evidence in hand. Alternative: ship `primaryState`
as the coarse space and keep narrow spaces for read-heavy domains.

Additional extraction-surface facts gathered (artifact-store-commands.ts):
- put uses the `tar` npm package (tarCreate) — the plugin needs a tar dep or
  a declared spawn of the system tar; content-addressed layout
  `.werkstatt/artifacts/<hash[:2]>/<hash>/` (verify exact hashPath shape)
- storeArtifactCore copies the archive into releasesDir and parses release.yaml
  with a regex line scan — parity-replicate exactly
- manifest is 17-field with sha256:unspecified degrade for siteContentHash;
  idempotent re-put removes the previous manifest when the hash path differs
- locking acquireLock(workspaceRoot, `release:<id>`) is WORKTREE-LOCAL while
  the data is primary-shared — a mutual-exclusion semantics gap across
  worktrees; extraction replicates exactly, file as werkstatt friction candidate
- io.mkdir exists on the engine WorkspaceIO — confirms the SDK port mkdir gap;
  the artifactStore port inherits the gap (writeFile creates parents, but
  empty-dir creation needs the mkdir spawn workaround)

## wave-4a executed — get+validate extracted (2026-11-26), integrate in flight

- `studio.artifact.store.validate` + `studio.artifact.store.get` committed
  (d0f2057c7) in session worktree; both proofs green: validate both polarities
  exact engine messages, get end-to-end incl. mkdir spawn and absolute-path
  output parity. Pin stayed 10.3.0 — pure workspace parity needs no new port.
- MVP-stub parity documented: validate's presence-implies-verified, get's
  no-extraction behavior — replicated exactly, flagged in module contracts.
- **F-0402 filed**: `--output` is alias-collided to `--json` in BOTH host
  parsers (kernel KERNEL_FLAG_ALIASES + forge CLI_FLAG_ALIASES) — engine
  artifact.store.get is dead-in-practice as documented; only `--output=<value>`
  survives parsing. Extraction shares the collision, interface parity trivial.
- scan-crash parity: unguarded JSON.parse/readdir replicated (corrupt manifests
  crash the scan in both implementations) — deviations corrected during proof.
- forge 10.4.1 propagated during the wave (artifactStore widened space live);
  selfhost harness validated on the npm artifact.

## primaryState design DECISION (2026-11-26) — coarse space replaces narrow

The deferral asked for first-consumer evidence; wave-4b put provides it:
put needs `<primary>/releases` (copy + systemId derivation) AND
`<primary>/.werkstatt/artifacts` (CAS) AND worktree-local locks — two spaces
for one command. gc needs releases + artifacts + locks — three. hygiene.audit
would need missions/archive too — four. Narrow spaces multiply toward a dozen
dimensions where every interesting command carries 2-3 grants — worse audit UX
than one honest coarse grant, and the narrowing is enforcement-theater anyway
(plugins run in-process; capabilities are audit/accident boundaries).

DECISION: `primaryState: "none" | "read" | "readwrite"` — one space rooted at
the primary checkout root, resolved through the same gitdir-pointer machinery,
mirroring the workspace `filesystem` grant's whole-root granularity exactly.
`artifactStore` is replaced before any consumer adopts it (zero consumers —
clean pivot, documented in the 10.5.0 changelog). The escalation honesty:
readwrite primaryState CAN write the primary tree unmediated (forge.yaml,
hooks) — bypassing the integrate gate path. Accepted because (a) in-process
plugins are not a security boundary, (b) the audit surface says exactly what is
true — this plugin operates primary state directly, (c) the alternative is 2-4
narrow grants per command with identical effective access.

Implementation notes for 10.5.0: same makeDeferredSpacePort machinery, root =
dirname(common-git-dir); capability rename artifactStore→primaryState in
types+loader+tests; the widened-root lesson (locks live next to artifacts)
generalizes — the whole checkout is the boundary, matching resolveWorkshopPaths
primaryRoot semantics one-to-one.

## wave-4b proof complete (2026-11-26) — first primaryState consumer validated

Proofs on the 10.5.0 tarball (file-pin, pre-publication):
- put executes end-to-end: CAS write worktree-local, degenerate shard `sh`
  replicated exactly, 17-field manifest byte-shape, tmp archive rename,
  idempotent first-match scan semantics
- **decisive boundary proof**: `releases/w4bproof-r1/artifact.tar.gz` written
  into the REAL primary checkout from the session worktree — md5-identical
  bytes through writeFileBytes (binary-safe, no utf8 corruption)
- systemId derivation read `<primary>/releases/<id>/release.yaml` through the
  primaryState port — cross-boundary read proof
- composition: wave-4a validate reads wave-4b artifact — module internally
  consistent across extractions
- lock lifecycle correct (acquire/release, finally-path release)
- F-0403 filed: degenerate shard — `sha256:` prefix makes slice(0,2) constant
  "sh"; sharding design is dead code in the engine
- writeFileBytes added to WorkspaceIOPort (10.5.0) — the binary-copy gap was
  discovered mid-implementation; string writeFile would corrupt gzip bytes

Integrate blocked on: matrix r2 green → publish → propagation → npm-spec pins.

## wave-4c evidence (2026-11-26) — artifact.store.gc, module 4/4 COMPLETE pending integrate

Mechanical-port extraction per wp-8-completion-design — the strategy's first
full validation:

- Closure ported byte-identical: protection 257 + anomalies 168 + release-index
  99 + types 75 + atomicWriteFile 27 (stripped) + collectReleaseArtifacts 112 —
  boundary-only adaptation through the abs-path io-bridge (101 lines).
- gc.ts facade lanes (missions/axiom) confirmed out of scope — the command
  calls collectReleaseArtifacts directly. Closure halved by measurement.
- io-verb surface measured exactly: 8 verbs (exists/readdir/readFile/
  readFileBytes/writeFile/rm/mkdir/rename) — drove the 10.6.0 widening.
- cacheClone capability (10.7.0) mandatory, not optional: degraded protection
  means keep-EVERYTHING (verified in collectReleaseArtifacts — degraded.length
  > 0 short-circuits to keep), so gc without cache-clone reads is a no-op.
- proofs: dry-run exact plan (3 candidates beyond keep:2, keep-latest+chain-head
  lanes correct); apply deleted exactly the plan, index.yaml appended
  state:removed, lock released clean; production-scale dry-run — 13 examined,
  protection lanes deployed-lane:12/keep-latest:9/chain-head:6 firing against
  REAL cache clones (decisive cacheClone proof).
- incident: operator-adjacent — fixture cleanup script corrupted the proof-created
  releases/index.yaml; root-caused as file created by the proof itself (mtime),
  defensive readIndex degrades gracefully; file removed restoring pre-proof
  state. Lesson: never scripted-edit generated files without a backup copy.

## wave-5 evidence (2026-11-26) — hygiene.audit, first wave-4c-lib reuse

Second mechanical-port execution — validated the REUSE economics of the
strategy: protection/anomalies/types/atomic/io-bridge carried over unchanged
from wave-4c; incremental closure only classes 288 + hygiene-policy 145 +
digest-export 132 + handler ~100 lines of new authoring.

- Bridge extended twice (stat, copyFile) — exact-verb measurement continues to
  drive the surface; copyFile cross-port byte copy is semantically exact.
- Parity proof at the strictest standard yet: fixture harness runs the SAME
  tree through engine scanAllClasses and plugin scanAllClasses — output
  byte-identical (missions verdicts/sizes, axiom fail-closed blocked reason,
  class ordering). Harness pattern recorded for future waves: engine import
  path + plugin import path + shared direct-fs io.
- PRODUCTION-SCALE FINDING: engine hygiene.audit itself times out at 5 min on
  the production tree (exit 124) — scanMissionsClass pathSizes 4.1G of archive
  file-by-file. Filed F-0404; extraction replicates faithfully per doctrine.
- friction registry lesson: folded plain scalars must not contain colon+space
  sequences — FRICTION-01 yaml parse errors; F-0403 shape is the canonical
  template (id/created/session/category/friction/signature/measure/artifacts/
  status/lastSeen).

## wave-6 evidence (2026-11-26) — signing.key.generate, smallest-closure execution

Third mechanical-port execution. Closure measurement-driven selection:
signing module total 240 lines shared + 88 handler — shallowest in the
remaining inventory. key.ts/types.ts copied byte-identical from
werkstatt-shared/signing with exactly one adaptation class: createDefaultIO
kernel coupling dropped, io param made required.

NEW BOUNDARY CLASS discovered: --output-dir is operator-arbitrary — outside
workspace/primary/cache roots, so io-bridge cannot carry it without breaking
parity. Resolution: node-io.ts (20-line node-fs-backed WorkspaceIO) used for
operator-explicit paths only; documented as the same trust class as the CLI
invocation itself. io-bridge remains the discipline for governed roots.

Parity proofs: hex layout (64-char files, correct naming), pem shape
byte-format identical (BEGIN/END armor + single-line base64), KEY_FILE_EXISTS
message byte-identical modulo path, encoding validation identical.

Dependency note: @noble/ed25519 ^3.2.0 added to studio package — matches
werkstatt-shared resolution exactly.

## wave-7 evidence (2026-11-26) — behavior.snapshot.capture+diff, strongest parity yet

Fourth mechanical-port execution. Two commands in one wave (shared closure):
capture + diff, both pure computation over workspace-scoped dist trees.
Parity proofs at the strictest standard: capture behaviorSnapshotHash +
wrapper byte-identical modulo timestamp; diff output byte-identical
(3/3 differences: routeCount, added route, headers — engine semantics do NOT
diff per-route contentHash changes, faithfully replicated).

CRITICAL BRIDGE LESSON (recorded in io-bridge.ts): classify-order hazard —
passing identical roots for all three bridge roots misroutes every path to
primaryState (first match wins), and the deferred primaryState space resolves
absent in session worktrees so exists() degrades false and every scan reads
empty. Resolution: makeWorkspaceIO single-root adapter for purely
workspace-scoped commands; io-bridge proper remains for multi-root commands.

Fixture-trap lesson: collectFiles defaultIgnore skips `old-*`/`-*` prefixed
names — a fixture file named old-page.html silently vanishes from scans; this
is correct faithful engine behavior, not a bug.

byteHash sync/async split: engine primitive is sync; wave-2's deploy-shared
copy is async (adaptation artifact). hashHtml needs sync — html-normalizer
carries its own 5-line sync copy now. SDK promotion review should consolidate.

Closure economics: 338-line handler + 4 pure support files (~450 lines) copied
byte-identical; adaptation was retyping kernel signatures to a minimal local
SnapshotContext (workspaceRoot/io/logger) — the cleanest kernel-decoupling
pattern so far, candidate for the standard extraction template.

## Remaining-wave ordering measurement (2026-11-26) — design §4 re-verification

Measured per-module: command lines, io verbs, coupling risks (network/exec/R2-env).
Execution order recommendation, cheapest-first:

| wave | target | measured closure | coupling | verdict |
|---|---|---|---|---|
| 8 | intake (validate 128 + schema-export 132 + fixtures-generate 249) | shallow — io.readdir/rm/writeFile only | none | NEXT — smallest remaining command surface |
| 9 | evidence-fetch/sync (283+433) | ~1084 module total, io surface trivial | R2 client + env creds (5 files) — needs env-port discipline + network capability decision | medium — network boundary design needed first |
| 10 | hygiene.gc (~256 handler + missions/axiom lanes) | partial reuse of wave-4c/5 lib | R2 for axiom lane, missions lane needs sibling-worktree scan (already bridged) | medium — lanes can degrade independently |
| 11 | evolution (5 candidate commands, 437 handler lines) | canary-router/controller runtime coupling | none measured | needs runtime-coupling investigation |
| — | journal | LIBRARY-ONLY — no commands to migrate; consumers migrate with their modules | — | remove from wave list |
| — | capability-artifacts | LIBRARY-ONLY (store.ts) — consumed by other modules | — | remove from wave list |
| deep | fleet claims/ownership (478 handler + claims-repo 824 + apply 593) | io.exec process spawning + systems-cache | heavy — capability design needed | defer |
| deep | notausgang (1030 lines) | 8 io verbs | moderate | defer |
| deep | handoff (exec×6) | heavy process spawning | defer |
| deep | observability (net×7) | heaviest network coupling | defer |
| deep | integrity (341 handler + 3793 module, net×3) | per design §4 possibly NOT studio-scope — verify before scheduling | verify scope first |
| deep | bordbuch (io.exec + net) | defer |

Class-G note: scope/component-runtime/isolation command files (133/146/171/243 lines)
are generic-platform class — they migrate with the v10-coverage verification (P0),
not the studio plugin line.

## wave-8 intake measurement correction (2026-11-26) — ordering table revised

intake deep-measurement during wave-8 open: handler files small (validate 128 +
schema-export 132 + fixtures-generate 249) but closure is DEEP — test-bundle.ts
1045 lines + @warpgogol/pbp/entities zod chain. pbp IS npm-published (1.0.0) so
the dependency is satisfiable in the plugin — no architectural blocker — but
total closure ~1500+ lines makes it a mid-size wave, not the small one the
handler measurement suggested. Session opened then discarded empty (zero work
invested — reopening costs nothing).

Revised cheapest-first order: intake (~1500, no network) → hygiene.gc (lib reuse,
lanes degrade independently) → evidence (needs network/env design) → evolution.
Lesson: handler-file line counts are not closure measurements — measure
test/fixture-bundle files and workspace-internal deps before wave selection.

## wave-8 intake full reconnaissance (2026-11-26) — design work required before port

Deep recon completed; wave-8 is NOT a mechanical port — it has two genuine
design prerequisites. All findings recorded so next session starts with design,
not recon:

1. DEPENDENCY CHAIN: intake.validate is a thin wrapper (RFC-1540 by design) over
   @warpgogol/intake-validator, a workspace package (0.1.0 npm-published) that
   itself depends on workspace:@warpgogol/pbp (1.0.0 published) and
   workspace:@warpgogol/werkstatt-shared. Open question: do the npm-published
   artifacts declare npm-versioned deps (making plugin consumption clean) or
   workspace:* (unresolvable outside the monorepo)? Check the published tarball
   package.json first — `npm pack @warpgogol/intake-validator --dry-run` or the
   registry metadata. If deps are workspace:*, the wave needs either npm-aligned
   republish or vendoring decision.
2. IO SURFACE GAP: intake-validator uses io.glob — not in the plugin bridge and
   not in the SDK WorkspaceIOPort. Either a forge SDK glob capability (minor
   version) or a bridge-local glob implementation over readdir recursion
   (semantics must match engine glob exactly — measure what rules.ts actually
   globs before choosing).
3. Command coupling: intake.validate correctness depends on
   intake.schema.generated.yaml presence in the installed werkstatt-shared —
   generated by intake.schema.export. Extraction order: schema.export probably
   belongs in the same wave despite the 1171-line onboarding/intake.ts cost,
   or validate ships with the documented INTAKE-10 degradation path as-is.
4. validate handler itself is genuinely thin (~100 lines) — once deps resolve,
   the port is mechanical; resolveWorkshopPaths already in studio lib.

Cheapest ACTUAL next wave candidates re-ranked: hygiene.gc (wave-4c/5 lib reuse,
no new deps) or behavior-snapshot-style pure modules. Recommend hygiene.gc next.

## wave-8 design questions RESOLVED (2026-11-26) — wave is now mechanical

1. Dependency chain CLEAN: npm artifacts carry npm-versioned deps —
   intake-validator → pbp ^1.0.0 + werkstatt-shared ^1.1.1; pbp → werkstatt-shared
   ^1.0.0; werkstatt-shared published 1.1.1. Plugin adds npm deps directly,
   zero vendoring.
2. io.glob simple: exactly two pattern classes in rules.ts — `**/*` recursive
   listing and `sources/<sha256>.*` single-level wildcard, both cwd-scoped.
   Bridge-local glob over readdir recursion (~40 lines) suffices, no SDK minor
   needed. Implement in io-bridge or lib/glob.ts with exact engine semantics
   (posix separators, sorted output at call site).
3. Wave-8 execution order when opened: add 3 npm deps to studio package.json →
   copy intake-validate.ts + write thin command → implement glob → tsc enumerate
   → fixture proof (synthetic bundle, INTAKE rule firing parity) → decide
   schema.export inclusion by remaining budget.

## wave-8 evidence (2026-11-26) — onboarding.intake.validate, classify-overlap root cause

Fifth mechanical-port execution — first consuming a PUBLISHED workspace package
(@warpgogol/intake-validator) rather than copied closure. Rule logic stays in
the package per RFC-1540 by design; the port is the thin command wrapper only.

PARITY PROOF: DIAG-PARITY EXACT — INTAKE-01/INTAKE-02 fire byte-identical
engine vs plugin on the same synthetic bundle (missing MANIFEST.sha256 +
missing intake.json diagnostics, identical messages, ordering, severity).

META-LESSON (severe): the wave-7 classify-order hazard recurrence — the command
wired cacheRoot=workspaceRoot (overlap), and since classify checks cache before
workspace, every workspace path routed to cacheClone whose port resolved rels
against the real ../systems-cache — exists() false, readFileBytes ENOENT into a
nonsense path. The author of the hazard documentation fell into his own trap:
the hazard needs a MECHANICAL guard, not documentation. Recorded as a forge
enhancement candidate — io-bridge construction should throw when roots overlap
(prefix-collision detection at makeIoBridge construction time).

Also proven: import.meta.resolve behaves identically in plugin host and engine
host for workspace package resolution; the io-type gap to the published
validator is bridged with `as never` casts — candidate for SDK WorkspaceIO
interface alignment when the bridge promotes.

glob added to the bridge: node builtin fs/promises glob — exact engine parity
since the engine implements io.glob over the same builtin (read-only ambient
scan, no port translation — documented in io-bridge.ts).

## wave-9 evidence (2026-11-26) — hygiene.gc, all four lanes byte-identical

Sixth mechanical-port execution — the largest wave yet and the one that closes
the hygiene module (audit wave-5 + gc wave-9 + artifact-store wave-4a/b/c).
Lane executors in gc.ts copied byte-identical: releases whole-unit deletion,
missions salvage-export digest spine before delete, axiom R2 upload+verify
with fail-closed degradation, caches lane. r2-client copied byte-identical —
ambient process.env exactly as engine (no port adaptation needed); @aws-sdk/client-s3
+ tar added as npm deps matching engine pins.

PARITY PROOF (harness pattern, strictest available for scan-heavy commands):
policy EXACT + scanAllClasses EXACT + actionable-plan EXACT — engine core vs
plugin core on the same synthetic fixture. Degraded doctrine demonstrated live:
r4/r5 releases carried protection-source-degraded:sibling-worktrees with
doubt-resolves-to-keep, axiom lane blocked no-r2-credentials fail-closed —
both engine and plugin identical.

Production-scale note: scanAllClasses scans ALL classes regardless of --class
filter (scan-then-filter is engine design) — F-0404 scan cost applies equally
to gc dry-runs on production trees; parity confirmed by identical 240s timeouts
engine and plugin.

hygiene module status: audit + gc + artifact-store all extracted — the RFC-1570
storage surface is fully migrated. Lock helpers reused from wave-4c artifact-store-gc
(generateOperationId duplication caught by tsc — dedupe lesson recorded).

## wave-9 addendum — PROBE-06 counter-journal death lesson

Wave-9 integrate first refused WT-GATE-08/PROBE-06 on INTAKE-01/02 — the SAME
rules whose wave-8 proof evidence had shrunk the baseline. Root cause chain:
rule-liveness "fired" requires counters-journal diagnostic emissions; the
counters journal (docs/.index/checks/counters.jsonl) is gitignored per-worktree
state that DIES with the session worktree. Wave-8's emissions never reached the
committed projection (docs/metrics/check-counters.generated.yaml still shows
diagnostic:0 from a 2026-11-08 evaluation), so wave-9's fresh worktree read
liveness:none for rules no longer in the baseline.

F-0287 already knew this class: "local records still cover unexported runs" and
the flow-journal union exists exactly because worktree counters die. For
check-rules the durable halves are (a) the committed counters projection —
regenerate it in the same change that gains the evidence, or (b) a real
gate.probe fixture. Immediate remedy that worked: re-run the engine command
(onboarding.intake.validate --bundle <broken>) in the CURRENT worktree —
emissions land in the local journal and the ratchet passes.

Extraction-proof corollary: any wave whose parity proof shrinks the unprobed
baseline MUST either regenerate the committed counters projection in the same
integrate or expect the NEXT wave's integrate to refuse PROBE-06 on the same
rules. Wave-8 got lucky ordering; wave-9 paid the debt.

## wave-10 evidence (2026-11-26) — intake.schema.export, fastest wave yet

Seventh mechanical-port execution — the smallest (132 lines core) and fastest:
open-to-integrate in a fraction of prior waves. Schema derivation stays in
published @warpgogol/werkstatt-shared + @warpgogol/pbp (zod source-of-truth,
never copied); generated-marker.ts copied byte-identical (236 lines, cohesive
header-generation unit). Deps added: @warpgogol/pbp workspace:*, zod ^4.6.5.

PARITY PROOF — strongest form: real writes compared. Plugin render sha256
b72965c0… == engine render sha256 b72965c0… byte-exact. (Both differ from the
committed artifact — pre-existing repo drift in the zod model, not wave scope.)

Endgame measurement (remaining WP-8 surface):
- intake.fixtures.generate — 249 lines + test-bundle.ts closure ~1045 (deep)
- evidence.fetch/sync — 762 lines core + registry-io 534 dep; BLOCKED on
  network-capability design decision: plugin manifest declares network:false,
  aws-sdk bypasses the fetch capability port by construction (auditability
  not sandbox) — needs explicit doctrine before extraction
- evolution — 2023 lines + fleet/health deps (largest remaining)

## wave-12 seam-extraction progress (2026-11-26) — strategy-A validated in part

First seam extracted: cacheCloneCommit byte-faithful into studio lib/evolution/
(MISSION_GIT_COMMIT=1 bypass preserved exactly) — bordbuch-io redirect done.
registry-io 534-line copy REMOVED after measurement: its consumption is two
functions, one trivial (resolveCacheClonePath one-liner), one chained
(resolveActiveWorkpieceDir → channel-migration + systemStateSchema +
resolveWorkpiecePath). Line-precise extraction recipe in WAVE12-RESUME.md.

New SDK need identified: ProcessPort.spawn opts lacks env — cacheCloneCommit's
MISSION_GIT_COMMIT=1 env-passing has no clean adaptation without shell-inlining.
forge 10.8.0 candidate: opts.env widening (small, backward-compatible).

Wave-12 is a full-session arc: seams + bridge + wrappers + proofs + integrate.
Everything pre-decided in the worktree's resume doc — execution only.

## ENDGAME RE-VERIFICATION (2026-11-26, post-wave-13) — honest scope assessment

CORRECTION to the wave-13 "WP-8 COMPLETE" framing: the 30 migrated commands
complete the INVENTORY-DOCUMENTED modules (artifact-store, hygiene, intake,
evolution, evidence, deploy, signing, behavior, journal), but the design §4
exit criteria — "every studio-ops workspace-scope command answered by the
plugin host" — covers the 156-command workspace-scope list, of which a
substantial surface remains in the engine. Re-verified module counts
(engine registrations, includes dark-run copies of migrated commands):

| module | commands | scope assessment |
|---|---|---|
| leitstand | 21 | pipeline orchestration core — ship/resume/verify chains drive the release lifecycle; heavy kernel coupling (hooks, pipeline runtime, editorial sign-off). KERNEL-RETAIN candidate |
| mission | 20 | mission lifecycle core — open/validate/reconcile/close orchestrate the platform's central workflow; io.exec/git mutation/kernel hooks pervasive. KERNEL-RETAIN candidate, though leaf commands (status, diff) may extract |
| sternsystem | 15 | system lifecycle core — register/sync/channels; cache-clone mutation heavy. MIXED: read-side (status/inspect) extractable |
| nachweis | 15 | evidence/attestation pipeline — assessment ingest, signing chains. MIXED, needs per-command measurement |
| fleet | 10 | claims/ownership — fs-only per wave-4 finding. MIGRATE candidates, medium closure |
| release | 6 | release lifecycle — overlaps artifact-store (done); remaining prepare/promote are pipeline-adjacent. MIXED |
| bordbuch | 6 | event ledger — append/validate; cache-clone mutation via the wave-12 seam (already extracted!). MIGRATE candidates — seam reuse makes these cheap |
| isolation | 6 | kernel runtime security — KERNEL-RETAIN by nature |
| lagebild/dns/subdomain/scope/remediation/handoff/notausgang/bauakte | 27 | unmeasured — needs classification pass |

CRITICAL ARCHITECTURE FACT: migration so far is DARK-RUN — engine copies still
serve `werkstatt run`; plugin copies serve `forge` invocation. The exit
criterion "werkstatt run delegation table empty for migrated surfaces" requires
a delegation mechanism that DOES NOT EXIST yet: engine-side command routing
that forwards migrated command ids to the plugin host. This is endgame work
item E1 — a forge/engine integration feature, not a wave.

ENDGAME WORK ITEMS (honest WP-8 remainder):
- E1: delegation mechanism — kernel `werkstatt run` routes migrated ids to
  plugin host; without it migrated surfaces live duplicated forever
- E2: scope classification pass — per-command migrate/retain verdicts for the
  ~110 unmeasured commands above; the studio-ops definition needs operator
  sign-off (is mission.open studio-ops or platform-core?)
- E3: engine decommission sequencing — after E1+E2, dark-run copies retire
  module by module with parity evidence already collected per wave
- E4: SDK promotion review — io-bridge.ts now proven across 30 consumers;
  promotion into forge SDK eliminates per-plugin copies (design §6 addendum)

## wave-14 bordbuch extraction (2026-11-26) — first E2-inventory wave

Session `wave14-bordbuch`. 6 commands ported: bordbuch.append/commit/generate/
repair/status/validate. Closure: command files 1090 lines byte-identical; reuse
economics decisive — bordbuch-io.ts (590 lines) already ported in wave-12,
cacheCloneCommit/gitExec/atomic seams already extracted. New extraction surface:
werkstatt/lock.ts + operation.ts copied byte-identical, writeSystemState added
to registry-seam (cache-clone auto-commit + push tail, byte-faithful logic with
fully-qualified refspec per RFC-0981/0986 + array-args exec per N11).
werkstatt-index-shim.ts replaces engine barrel. TSC cascade 20→12→5→1→0 as
designed. Strip-only constraints: none new. Proof: engine vs plugin validation
parity byte-identical (--system is required same wording both sides) — reducer
byte-identical by construction; deep behavioral parity deferred to integration
dogfood (bordbuch status/validate run against real systems during normal ops).
Manifest after registration: 36 commands. Commit 4ff9888b1.

## wave-15 fleet measurement (2026-11-26) — KERNEL-COUPLED, not a migrate candidate

Correction to the endgame table: fleet measured for wave-15 and found genuinely
kernel-coupled — claims-commands/apply import `kernel/runtime/execute-command`
+ `execute-pipeline` directly (fleet.apply invokes kernel command execution;
claims.sync drives pipeline chains). Migrating these to the plugin host would
create a backwards dependency plugin→kernel-runtime. This is exactly the exit
criterion's "commands genuinely requiring kernel internals" class. Fleet is
reclassified KERNEL-RETAIN. The endgame table's MIGRATE/MIXED rows need the
same kernel-import probe before any wave commitment: grep for
`kernel/runtime/execute` in the module's closure — its presence is the
kernel-retain signature.

Updated honest endgame position after wave-14: the extractable surface is
nearly exhausted. Remaining candidates need either per-command kernel-coupling
measurement (nachweis, release remainder, sternsystem read-side, mission leaf)
or the E1 architecture decision first — specifically whether plugin commands
may invoke kernel commands through a defined port (shell-out vs in-proc
delegation), which determines whether kernel-coupled-but-workspace-scoped
modules like fleet can ever migrate.

## E2 kernel-coupling probe results (2026-11-26) — classification framework refined

First-pass probe (grep `kernel/runtime/execute` per module, io.exec count as
secondary signal — NOT a blocker since wave-12/13 proved io.exec works through
the bridge with declared capabilities):

| module | kernel-runtime files | ioexec files | verdict |
|---|---|---|---|
| mission | 3 | 15 | KERNEL-RETAIN confirmed |
| fleet | >0 (measured wave-15) | — | KERNEL-RETAIN confirmed |
| nachweis | 0 | 1 | extractable candidate, medium (15 cmds) |
| release | 0 | 1 | extractable candidate, small (6 cmds) |
| sternsystem | 0 | 7 | extractable, heavy ioexec but wave-12 seams exist |
| leitstand | 0 | 7 | NEEDS DEEPER PROBE — pipeline orchestrator, indirect coupling likely |
| handoff | 0 | 5 | small but check invocation direction |
| lagebild | 0 | 1 | small |
| bauakte/remediation/dns/subdomain/scope/notausgang | 0 | 0-0 | smallest candidates |

REFINED FRAMEWORK — kernel-coupling is necessary but not sufficient for the
retain verdict. Second dimension: INVOCATION DIRECTION. Commands invoked BY
kernel orchestration (pipeline steps, mission lifecycle internals) must stay
kernel-resident even when mechanically extractable — migrating them creates
the backwards dependency plugin←kernel-invocation. The studio-ops class is
operator-facing commands reading/writing workspace state. Probe: grep who
invokes the command id via executeRegisteredCommand/invoke in kernel module
closures before wave commitment.

## verifier-fix session + F-0405 resolution (2026-11-26) — integrate-blocker eliminated

Wave-14 integrate hit FLOW-INT-01 three times on a phantom: `??
node_modules/.pnpm/robots-parser@3.0.1/node_modules/robots-parser/.gitignore`.
Root cause diagnosed to mechanism: CX-142's sessionIgnoreRulePaths fs-walk
prunes only `.git` — it descends into ignored trees and collects third-party
`.gitignore` files shipped inside node_modules packages as session-authored
evasion candidates. A rule inside an ignored tree is inert by construction
(git never descends; hiding already-invisible paths gains nothing) — the one
exception is an ignored directory containing TRACKED files, which git still
descends. Fix (07afed5ab): statusDirty filters candidates through check-ignore
on the parent + ls-files-under-parent, both probes fail-closed. Tests:
inert-drop, live-plant-block, tracked-edge-live — 2/2 new + 54/54 regression
green. The fix rode through the very integrate machinery it repairs — meta-
validation by construction. EVERY future wave integrate was exposed to this
phantom (any dep shipping a `.gitignore` recurs); the blocker is now durable
closed. F-0405 filed + fixed in one program day.

Wave-14 integrate confirmation: develop carries 4ff9888b1 (bordbuch x6) +
3176d53e8 (F-0405 record) + 07afed5ab (verifier fix) — plugin manifest 36
commands. Session worktrees zero.

## wave-15 lagebild extraction (2026-11-26) — first post-verifier-fix wave

Session `wave15-lagebild`. 5 commands ported: connect/referral.issue/
referral.list/status/validate — module selected by refined E2 framework: zero
kernel-runtime coupling, zero execution-position external invocation, operator-
facing semantics. Closure 1550 lines byte-identical; seam minimization taken
further than wave-12: only filterEnv+sourceDotenv extracted from the 2263-line
deployment-adapter barrel (the two sole consumers in the lagebild closure) —
self-contained pure functions, ~55 lines replace the transitive adapter layer.
registry-seam extended with readSystemStateSmart/writeSystemStateSmart/
writeSystemStateToWorkpiece byte-faithful. wrangler-secrets.ts copied whole
(95 lines — runWranglerSecretPut boundary). TSC cascade 10→5→3→0. Proof:
engine vs plugin validation parity byte-identical (--site is required same
wording). Commit 4ca4d6b02. Manifest after registration: 41 commands.

NOTAUSGANG semantic check for next-wave ordering: 2 commands (export/validate)
— disaster-recovery operator surface. subdomain mostly KERNEL-RETAIN
(register/validate invoked by leitstand/service-promote — pipeline-internal);
only list is operator-facing — not worth a partial-module wave. Remaining
extractable inventory after wave-15: nachweis leaf (13/15, heavy ~5000 lines),
notausgang (2, 1629 lines), release leaf (invocation-form unverified), handoff
(3, 3678 lines deep). The extraction program is entering its heavy-tail phase —
each remaining wave is evolution-scale or partial-module surgery.
