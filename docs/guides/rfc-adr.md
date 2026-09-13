# RFC and ADR workflows

## RFCs (Request for Comments)

RFCs capture architectural decisions before implementation. Each RFC has a lifecycle: draft → accepted → implemented → archived.

### Creating an RFC

```sh
pnpm exec forge rfc.create --title "Add new validator" --kind architecture --satisfies DNA-49
```

For `command` and `policy` kind RFCs, `--satisfies` is not required. For `architecture` and `contract` kinds, it is required (RFC-0331).

### Validating RFCs

```sh
# Validate all RFCs
pnpm exec forge rfc.validate

# Validate and output JSON
pnpm exec forge rfc.validate --json
```

### RFC lifecycle

1. **draft** — author writes the RFC
2. **accepted** — human reviewer approves
3. **implemented** — code is written and stamped via `rfc.implement.stamp`
4. **archived** — moved to `docs/rfcs/archive/` via `docs.archive`

### Key commands

```sh
forge rfc.list              # List all RFCs
forge rfc.validate          # Validate all RFCs
forge rfc.create            # Create a new RFC
forge rfc.verification.emit # Emit acceptance evidence
forge rfc.implement.stamp   # Stamp an RFC as implemented
```

## ADRs (Architectural Decision Records)

ADRs are lightweight decision records for local technical decisions that don't need a full RFC.

```sh
forge adr.create             # Create a new ADR
forge adr.validate           # Validate all ADRs
forge adr.list               # List all ADRs
forge adr.archive            # Archive terminal ADRs
forge adr.implement.stamp    # Stamp an ADR as implemented
```

## When to use RFC vs ADR

- **RFC** — architectural decisions that affect multiple workspaces, require formal review, or establish new contracts
- **ADR** — local technical decisions within a single workspace that need traceability but not full governance

## Architecture DNA

Architecture DNA invariants (`docs/architecture-dna.md`) are foundational rules that RFCs can reference via `satisfies: [DNA-N]`. Use `fo-extract-dna` to discover and formalize implicit invariants.
