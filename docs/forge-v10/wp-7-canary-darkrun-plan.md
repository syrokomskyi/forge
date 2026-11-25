# WP-7 Canary Dark-Run Plan — warpgogol-verbund

Status: prepared 2026-11-25, execution starts when @warpgogol/forge@10.1.0 is npm-visible.

## Canary profile (recon 2026-11-25)

warpgogol-verbund consumes forge exclusively as a governance CLI:
- devDep `@warpgogol/forge ^9.7.1` — no kernel, no flow machinery, no stack plugins
- bindings: `rfc.validate`, `adr.validate`, `spec.validate`, `session.save`, implement stamps — all `pnpm exec forge <cmd>`
- governance corpus: docs/rfcs, docs/adrs, docs/plans, docs/specs

## Dark-run protocol

1. **Shadow install:** add `@warpgogol/forge@10.1.0` under an alias (`forge-v10: "npm:@warpgogol/forge@10.1.0"`) alongside the v9 pin — no cutover yet.
2. **Parity matrix:** for every binding command the canary uses, run v9 and v10 against the same corpus state:
   - `rfc.validate --id <each RFC in docs/rfcs>` — collect verdicts
   - `adr.validate` likewise; `spec.validate` likewise
   - blocking-verdict parity must be exact-match per AC-7; divergences triage as v10-regression vs v9-false-positive, recorded in the parity document.
3. **Parity document:** `docs/forge-v10-parity.md` in the canary repo — matrix + triage + verdict counts.
4. **Digest recording:** parity digest recorded back into werkstatt `docs/forge-v10/` per the program plan.
5. **Cutover (delegated sign-off this session):** devDep bump to `^10.1.0`, alias removed, `.agents/skills` regenerated untracked, full verification in the canary.
6. **Shadow-mode removal:** alias machinery deleted; sunset immediate for a CLI-only consumer (no drain shadow needed — the canary has no integration queue usage).

## Migration risks specific to this consumer

- v10 dropped `os/werkstatt`/`os/mission` exports — the canary never used them (CLI-only).
- Node engine range widened to `>=24` — canary environment must be Node 24+ (verify).
- Skills generation model changed: tracked `.agents/skills` twins become generated artifacts (the canary currently tracks them — untracking is part of cutover).
