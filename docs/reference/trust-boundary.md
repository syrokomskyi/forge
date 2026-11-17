# The verification trust boundary

`correctness.gate` judges a session's diff against a frozen contour — but who stops the session from editing the gate inputs themselves? RFC-1615 froze the declared policy surface inside the repository; RFC-1616 adds the layer that answers the question honestly: **the boundary a self-interested agent cannot cross lives outside the agent's write access.**

```sh
pnpm exec forge policy.digest --write          # record the policy surface
pnpm exec forge policy.digest --verify       # re-check it
pnpm exec forge adversarial.run --list       # the seeded attack catalog
pnpm exec forge adversarial.run              # replay all 12 scenarios
pnpm exec forge flow.push --digest <id> --accept-verifier-trailers "<reason>"
```

## The three layers

1. **In-repo freeze (RFC-1615).** `correctness.gate` judges `forge.yaml` policy keys, `freezeFiles` globs, oracle files, manifest entries, and the `policy:` declaration itself against `--base`. Necessary — and sufficient only against a lazy adversary. An agent with repo write access could, in principle, edit the gate's own inputs and the evidence in one commit; the gate narrows that window to "everything the freeze covers" but cannot leave the repository.

2. **Attestation & provenance (RFC-1616, in-repo half).** `policy.digest --write` records a canonical SHA-256 bundle (`forge/policy-bundle@1`) over the declared policy surface; `policy.digest --verify` re-checks it, and `--verify --base <sha>` refuses when the surface advanced without a commit carrying `X-Policy-Digest`. `flow.push` scans the unpushed range for the verifier/audit trailers (`X-Expectation-Origin`, `X-Verifier-Report`, `X-Correctness-Weakening`, `X-Policy-Digest`) and refuses `FLOW-PUSH-08` until the operator passes `--accept-verifier-trailers "<reason>"` — verifier evidence must be seen by a human before it leaves the machine. `push.requireVerifierReview` defaults to `true`; a repository may opt out with `false` — itself a frozen key. `adversarial.run` replays the packaged catalog of 12 seeded attacks in a scratch clone against the real spawned gate and reports expected-vs-observed refusal rules.

3. **External enforcement (RFC-1616, platform half).** The scaffolded `.github/workflows/forge-policy.yml` re-judges the policy surface in CI (`correctness.gate --policy-only`, `pinned.validate --mode ci`, `policy.digest --verify`) on every push and pull request — a job the session's credentials do not control. `.github/CODEOWNERS` assigns `forge.yaml`, `.forge/`, `hooks/`, and `.github/workflows/` to `project.owner`, so a pull request that edits the policy surface — including the workflow that watches it — needs the owner's review.

## The two switches (GitHub)

The in-repo files are inert until the platform enforces them. On the repository's protected branch (`develop`, and `main` if released):

1. **Require review from Code Owners.** Settings → Branches → branch protection → "Require review from Code Owners". This makes `.github/CODEOWNERS` binding: a PR touching `forge.yaml`, `.forge/`, `hooks/`, or the workflows cannot merge without the owner.

2. **Require status checks.** Same page → "Require status checks to pass" → select the `forge-policy` job. This makes the CI re-judgment binding: the policy surface must verify outside the session's environment.

`forge init`/`forge upgrade` write both files when absent (`project.owner` renders the CODEOWNERS handle; absent it keeps the documented `@OWNER` placeholder) and never overwrite them afterwards — operator-tuned content is the adoption.

## What this does NOT guarantee

- The `.forge/policy.digest` file is an attestation artifact, not a trust root — a session could regenerate it in the same commit as the weakening. It holds because CODEOWNERS owns `.forge/` and the CI re-verifies it — the digest without the external layer is bookkeeping.
- Commit trailers are provenance hints, not proof of authorship — a session can type `X-Verifier-Report:` into any message (disclosed as gate observation O-16). They hold because `flow.push` forces them under operator review and CODEOWNERS owns the report paths.
- VERIFIED means the frozen contour judged the diff and the evidence held — under the controls above. It does not mean the code is correct, only that the declared surface was not silently weakened on the way to "done".
- Cryptographic commit signing (GPG/sigstore) is deferred — it would harden authorship claims, not replace the review boundary.
