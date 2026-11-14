# Fleet measurement methodology

The README's "Forged in production" table is produced by `forge codebase.measure` (RFC-1581) — Forge's own measurement command — run over each repository's git-tracked files at develop tip on 2026-11-13.

## What is measured

- **Scope:** `git ls-files` — tracked files only.
- **Classification:** every tracked line lands in exactly one category — `code`, `tests`, `docs`, or `generated`. `Total` in the README table is their sum; generated, vendored and mirrored content is classified separately, never silently merged into `code`.
- **Lines:** per-language code / comment / blank counts.
- **Symbols:** a real AST pass — the TypeScript compiler is resolved lazily from the measured workspace, so class/function/method counts come from the compiler, not regexes. Where a workspace resolves a compiler the walker cannot use, the command reports `symbolsSkipped` instead of estimating.
- **Exclusions:** export mirrors and deployment caches are excluded to avoid double counting the same source.

## Reproduce

```sh
pnpm exec forge codebase.measure --json             # full structured result
pnpm exec forge codebase.measure --out <file.yaml>  # dated YAML snapshot
```

`--out` is the command's only write; without it the run is read-only.

## Worked example

`codebase.measure --json` over the werkstatt monorepo, 2026-11-14 (develop tip, trimmed to structure):

```json
{
  "command": "codebase.measure",
  "status": "ok",
  "repo": "werkstatt",
  "totals": {
    "code": { "files": 6612, "code": 812595 },
    "tests": { "files": 2710, "code": 353483 },
    "docs": { "files": 3836, "code": 234971 },
    "generated": { "files": 951, "code": 346409 }
  },
  "binaryFiles": 36,
  "measuredAt": "2026-11-14T05:40:44.176Z"
}
```

The full result also carries `languages`, `topDirs`, `symbolsSkipped`, `exclusions`, and `nextSteps`. Numbers drift between measurement days as the fleet changes — the README table states its own measurement date.

## Limitations

- **Self-measured.** The numbers come from Forge's own instrument over private repositories — an instrument reading, not an independent audit.
- **Lines are not outcomes.** Scale demonstrates that Forge operates on real systems; it does not by itself prove governance quality.
- **Revisions move.** Repositories evolve; rerun the command for current numbers.

## Observed outcome (one concrete example)

Scale aside, do the gates catch anything? `forge gate.probe` exists to answer exactly that — it seeds a declared violation at the real workspace path and proves the gate still fires (see [the scenario guide](../guides/verification-and-evidence.md#gate-probes--prove-the-gate-still-fires)). Inside the fleet, friction records document real catches — e.g. F-0208: a refused commit left `git add` residue staged in the index, which the next gate run surfaced instead of silently inheriting. The catch came from a validator refusing, not from an agent noticing.
