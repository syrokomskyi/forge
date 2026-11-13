# Correctness audit reference

`correctness.audit` (RFC-1579) runs static cross-artifact auditors that need no product declaration. It finds defects that live **between** artifacts — TypeScript ↔ migration DDL, a declared state machine ↔ the code that performs its transitions, a schema ↔ the statements that read and write it — which single-file linters cannot see.

- **Contract:** `correctness` (shared with `correctness.manifest.validate`), rules `CORR-AUDIT-01..04`
- **Read-only** except `--write-ledger`

```sh
pnpm exec forge correctness.audit --base <ref> [--check <id>] [--json]
pnpm exec forge correctness.audit --base <ref> --staged [--json]
pnpm exec forge correctness.audit --write-ledger [--dry-run] [--json]
```

`--base` defaults to the merge-base with `develop` (`HEAD` with `--staged`); an unresolvable `--base` is a usage error (exit 2).

## Auditors

| Rule            | Check id                     | Kind                           |
| --------------- | ---------------------------- | ------------------------------ |
| `CORR-AUDIT-01` | `sql.schema.conform`         | code, differential             |
| `CORR-AUDIT-02` | `ledger.orphans`             | code, differential             |
| `CORR-AUDIT-03` | `state.transitions.coverage` | code, differential             |
| `CORR-AUDIT-04` | `bindings.verify.substance`  | configuration, always blocking |

### 1. `sql.schema.conform`

Each D1 binding of a `wrangler.json` / `wrangler.jsonc` (`d1_databases[]`, top level and `env.*`) yields one schema keyed by `database_name`: its `migrations_dir` (default `migrations/`, relative to the config) is applied in filename order to its own in-memory `node:sqlite` database. A `wrangler.toml` is reported `skipped: unsupported-config`.

String and template literals in non-test `*.ts` / `*.mts` / `*.tsx` files whose trimmed text starts with an **uppercase** keyword and SQL structure — `SELECT … FROM`, `INSERT INTO`, `UPDATE … SET`, `DELETE FROM`, `WITH … AS (`, `REPLACE INTO` — are prepared with `DatabaseSync.prepare()` against the schemas of the statement's package (the deepest wrangler config above the file), or against every schema when the file belongs to no such package. A statement is a finding only when it fails against every candidate with `no such column` / `table <t> has no column named <c>` (subject `<file>:<table>.<column>`, aliases resolved) or `no such table` (subject `<file>:<table>`).

Counted as **unverifiable** (severity info, never blocking): template literals with `${…}`, statements whose other `prepare()` errors come from D1-only syntax, statements in a package whose migrations failed, and statements touching a table that only an in-code `CREATE TABLE` literal of the same package creates (Durable Object storage is another database). A migration that fails to apply is itself an error with the migration file as subject — never a partial schema.

### 2. `ledger.orphans`

Every table a D1 schema declares needs a writer and a reader among the code statements (migration `INSERT`s count as writes): `read-never-written` and `written-never-read` are errors; `untouched` (declared, never read or written) is a warning so a migration-first change does not block. Subject = table name.

### 3. `state.transitions.coverage`

Only explicitly declared machines are audited. The marker sits on the comment line directly above the transition table:

```ts
// @state-machine[candidate] (writers: transition) (column: state)
export const EDGES = [
  { from: "approved", to: "send_ready" },
  { from: "send_ready", to: "queued" },
];
```

Grammar: `// @state-machine[<name>] (writers: <fn>[, <fn>]) [(column: <sql column>)]`. Table shapes: an array of object literals with string-literal `from`/`to`, or an object literal `Record<State, State[]>`. A marker without a parseable table is itself an error (`<machine>:unparseable-table`). A target `S` is covered when a non-test file calls a declared writer (free function or method call) with `S` as a string-literal argument, iterates a literal tuple containing `S` into that call (`for (const to of ["send_ready", "queued"] as const) { transition(db, id, to) }`), or holds a static SQL `UPDATE` (SET clause only) / `INSERT` literal setting the declared column to `'S'`. Every edge whose target is uncovered is a finding with subject `<machine>:<from>→<to>`. Without any marker the auditor reports `skipped: no-declared-machine`. `compass.validate` treats the marker as an ordinary comment.

### 4. `bindings.verify.substance`

Error when `bindings.commands.verify` is `null`, equals `bindings.commands.test` or `bindings.commands.typecheck`, or consists only of `test`, `typecheck`, `build:check`, `tsc`, or `vitest` invocations. Not differential: present means `introduced`. A repository declaring `correctness.mode: exempt` is skipped (`skipped: exempt`).

## Differential attribution

Auditors 1–3 run over the base revision (blobs read through one `git cat-file --batch` process, no checkout) and over the working tree or the staged index. Each finding has a key `sha256(check + "\0" + subject)` and an occurrence count:

- **introduced** — key new, or present at base with a lower count, a lower severity, or a different finding kind → blocks when the severity is `error`;
- **legacy** — present at base with an equal or higher count → reported, never blocking;
- **resolved** — present at base only → reported;
- **accepted** — matched by `correctness.audit.allow[]` → reported, never blocking.

Exit 1 only for introduced errors.

## Allow-list and survival ledger

```yaml
# forge.yaml
bindings:
  paths:
    correctnessLedger: docs/maintenance-debt/correctness.ledger.yaml # default
correctness:
  audit:
    allow:
      - check: ledger.orphans
        subject: events
        reason: "append-only audit trail read through the D1 console"
```

Allow entries are operator decisions (RFC-1580 freezes them at the base revision). `--write-ledger` writes one row per legacy or accepted code finding — `key`, `check`, `subject`, `firstSeen` / `lastSeen` (`{sha, date}`), `status: surviving | resolved`. Nothing gates on the ledger; `fo-session-retro` refreshes it after the wiring task seeds it.

## Gate line

Every Forge consumer's `hooks/integration-gate.sh` runs the audit from the **primary checkout's** forge install, so the session under judgment can neither edit the auditor nor pin it away:

```sh
"$FLOW_PRIMARY/node_modules/.bin/forge" correctness.audit --base "$FLOW_BASE_SHA"
```

The `typescript` stack profile emits this line for new projects; existing consumers receive it through verbund queue tasks that also fix their `verify` binding (CORR-AUDIT-04 blocks from day one). In werkstatt, `ecosystem.commit` runs `--staged` as an early gate (EC-34) that refuses introduced CORR-AUDIT-01..03 errors.
