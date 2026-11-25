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
