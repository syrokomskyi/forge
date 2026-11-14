# Release evidence — @warpgogol/forge 9.6.2

What was verified, where the artifacts live, and what this evidence does and does not prove. All links point at public artifacts in [syrokomskyi/forge](https://github.com/syrokomskyi/forge) and the npm registry.

## Pipeline trail

| Stage | Artifact | What it proves |
| --- | --- | --- |
| Authoring | commits on `develop` in the upstream monorepo, squashed into the export commit | the change set exists and has authorship history |
| Commit gate | scoped lint / typecheck / tests run by `ecosystem.commit` per changed file | the touched files passed their package gates before integrating |
| Integration gate | `flow.integrate` run — heavyweight suite (build, tests, correctness, registry integrity) | the merge met the platform bar, not just the package bar |
| Release cut | `flow.cut` produced repo tag `v6.464.2` and package tag `forge@9.6.2` | version bump was machine-derived, not hand-edited |
| Push + extract | `flow.push` → export repo `syrokomskyi/forge` | the public tree is machine-generated, not hand-maintained |
| Public CI | [GitHub Actions run for the release commit](https://github.com/syrokomskyi/forge/actions) — `ci` job: install, build, lint, typecheck, vitest | the published code compiles, lints, types and tests green in a clean environment |
| Publish | [publish job](https://github.com/syrokomskyi/forge/actions) — `npm publish --provenance --access public` → `+ @warpgogol/forge@9.6.2` | the registry artifact was produced by CI from the tagged commit, not from a workstation |
| Provenance | Sigstore transparency log entry for the publish (linked from the job log) | third-party attestation binds the artifact to the workflow run |
| Registry | [`@warpgogol/forge` on npm](https://www.npmjs.com/package/@warpgogol/forge) — the `latest` dist-tag serves `9.6.2` | the artifact is publicly installable |

## What this proves — and what it does not

Proves: every transition (author → gate → integrate → release → extract → CI → publish) produced a verifiable artifact, and the npm tarball was built by CI from the tagged commit.

Does not prove: that a specific human or a specific AI agent authored any particular line. "Authored by an AI agent" is a process claim about the upstream session — the public evidence shows the gates and outputs, not the keystrokes.

## How to spot-check

```sh
npm view @warpgogol/forge@9.6.2 dist.tarball    # tarball URL + integrity hash
npm view @warpgogol/forge version              # should print 9.6.2
gh run list --repo syrokomskyi/forge --limit 5  # latest green CI + publish jobs
```
