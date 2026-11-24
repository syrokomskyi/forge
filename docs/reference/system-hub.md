# System hub — superfolder governance (RFC-1639, RFC-1641)

A **superfolder** is a directory whose immediate children are forge-governed repositories — for example `~/projects/warpgogol/` holding `werkstatt`, `lagebild`, `dater`, and the rest. Folder-level governance (member health, folder-level frictions, the task queue) lives **inside one member repository** — the system hub — never in a `forge.yaml` at the superfolder root.

## Deploying a hub for a new business

Three commands onboard a business folder end to end — no hand-edited yaml:

```bash
# 1. Scaffold the hub inside the business folder
cd <business-folder> && forge create --in-place --profile system

# 2. Populate the member roster — scans the folder for forge siblings,
#    resolves each one's git origin, writes products.yaml + products.local.yaml
forge system.product.register --discover [--dry-run]

# 3. Verify the roster against disk reality
forge system.products.status
```

Explicit registration for members outside the folder or not yet cloned:

```bash
forge system.product.register --id <kebab> --remote <url> [--folder <path>] \
  [--offers <contract>]* [--frozen] [--update]
```

A fresh hub also generates a hub-native root `AGENTS.md` (`profiles/root-agents-system.md` via `rootAgentsMdTemplate`) — agents in the repo learn the member model, the sweep command, the folder-level friction path, and the task queue from their instruction layer.

## The hub model

- The hub is an ordinary git repository with `profile: system` in its `forge.yaml`. On this installation it is `warpgogol-verbund`.
- The canonical member roster is `system/products.yaml` (`forge/system-products@1`): `products[]` with `id`, `remote`, `offers`, and the additive `frozen` flag; a top-level `ignored[]` list names sibling directories (`{id, note?}`) that are deliberately outside the member model.
- The local checkout map is `system/products.local.yaml` (`forge/system-products-local@1`, gitignored): `folders:` maps each product id to an absolute or hub-relative folder.
- Because the hub is a normal repository, its friction registry is the standard `docs/frictions/` `F-NNNN` per-record store — folder-level records are versioned, gated, and journaled like everything else. There is no second id namespace: a folder-level record is an `F-NNNN` record in the hub's registry carrying `level: folder`.

## Commands

### `system.product.register`

The roster write surface (RFC-1641). Writes `system/products.yaml` and the gitignored `system/products.local.yaml` — the session commits.

- **Explicit:** `--id <kebab> --remote <url> [--folder <path>] [--offers <contract>]* [--frozen] [--update] [--dry-run]`. New ids require `--remote`; a duplicate id without `--update` refuses; a `--folder` already mapped to another product refuses; a `--folder` absent on disk warns but records.
- **Discover:** `--discover` scans the hub's parent directory and registers every sibling carrying `forge.yaml` that is not already registered — id from the directory name, remote from `git remote get-url origin`, folder as `../<name>`. Skips `ignored[]` names, `@`-worktrees, hidden dirs, the hub itself, non-kebab names, and siblings with no readable origin — each reported under `skipped[]` with a reason; warning-class skips never fail the run.
- Errors are `SYSTEM-PRODUCTS-03` (writes nothing); warnings are `SYSTEM-PRODUCTS-04`. Idempotent: an identical re-run reports `skipped: already-registered` rather than rewriting.

```bash
werkstatt run system.product.register --id billing --remote git@github.com:org/billing.git --folder ../billing --offers billing-api
werkstatt run system.product.register --discover --dry-run
```

### `system.products.status`

Read-only member health report for the hub. Run inside the system-profile repository it probes each product in `system/products.local.yaml`:

- `folder`, `profile`, `forgeVersion` — from the member's own `forge.yaml`
- `versionOk` — member `forge.syncedVersion` against the hub baseline
- `dirty`, `sessionWorktrees`, `aheadOfOrigin` — git probes that degrade to `null` + warning when the member is not a git checkout
- `frozen` — a frozen member is reported but exempt from error diagnostics: a missing or broken frozen product warns, never fails the command

It also scans the hub's **sibling directories** (the superfolder) and warns on:

- a sibling carrying `forge.yaml` that is not a registered product — an adoption gap (register it in `system/products.yaml` or name it `ignored`)
- a git-initialized sibling without `forge.yaml` — a pre-adoption signal

```bash
werkstatt run system.products.status [--json]
```

### `friction.migrate --from <external frictions.yaml>`

Ingests a legacy single-file `docs/frictions.yaml` registry from **outside** the workspace — the superfolder-level file lands inside the hub. Each record:

- mints the next `F-NNNN` id via the shared git-dir ledger (never dir-scan)
- carries `migratedFrom` (its old `F-NNNN` id), `origin` (the source folder's name, unwrapping a trailing `docs/`), and `level` (default `folder`, `--level repo` overrides)
- is skipped on re-run when a record with the same `origin` + `migratedFrom` already exists — a crash-interrupted run re-derives the same mapping

The source file is removed **last**, only when the run is clean. `--from` must point outside the workspace; the no-flag path owns the workspace's own `docs/frictions.yaml` as before.

```bash
werkstatt run friction.migrate --from ../docs/frictions.yaml [--dry-run] [--level folder] [--session <id>]
```

### `friction.add --level folder`

Marks a new record as concerning the superfolder rather than the repo holding the registry. `repo` is the default and is omitted from the written record; any other value refuses (FRICTION-03).

```bash
werkstatt run friction.add --category tooling --signature "…" --friction "…" \
  --measure "…" --level folder
```

## Bounded surfaces

- `forge create --in-place` refuses a directory whose immediate children already carry `forge.yaml` (CREATE-SUPERFOLDER-01): that folder is a superfolder, and its governance belongs in a system-profile hub repository, not in a folder-level `forge.yaml`. The guard bounds the command only — a hand-written `forge.yaml` is untouched.
- Everything else treats the hub as an ordinary workspace repository — frictions, sessions, journal, and queue flow through the existing commands.

## Record fields

| Field | Shape | Meaning |
| --- | --- | --- |
| `level` | `repo \| folder` (optional) | `folder` = the record concerns the superfolder, not this repo |
| `origin` | string (optional) | Source folder name an ingested record came from |
| `migratedFrom` | `F-NNNN` (optional) | The id the record carried in its previous registry |
