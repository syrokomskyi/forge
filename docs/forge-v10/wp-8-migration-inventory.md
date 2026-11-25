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
