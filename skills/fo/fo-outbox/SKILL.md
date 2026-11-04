---
name: fo-outbox
description: Write a dependency-contract request entry in docs/outbox/ so the system can match the need to an offering product. Use when a product needs a contract without naming the provider.
invocation: user
category: fo
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["request a contract", "add an outbox entry", "I need something another product provides"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-outbox skill — author a forge outbox entry in docs/outbox/&lt;id&gt;.yaml that records what this product needs from a contract without naming who serves it.</purpose>
<non-goals>
  <item>Do not decide which product serves the contract — the system matches needs to offers.</item>
</non-goals>
</MODULE_CONTRACT>
-->

# fo-outbox

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Use this skill inside a **product repository** when the work needs a contract another product may offer — a shared schema, a data feed, a capability — and the product must not name the provider.

An outbox entry is an ordinary tracked file, reviewed and committed with the rest of the product's work.

## The rule

An entry names **a contract and nothing else**:

- never the system the product belongs to;
- never the product that might serve it;
- never a repository, checkout path or remote URL.

If the need truly has no candidate contract, say so in `why` — do not invent a contract id.

## Steps

### 1. Pick the next free id

List `docs/outbox/` (create the directory when absent) and take the lowest unused `OB-NNNN` number. The filename stem IS the entry id — `docs/outbox/OB-0003.yaml` must declare `id: OB-0003`.

### 2. Write the entry

```yaml
schema: forge/outbox@1
id: OB-0003
contract: <contract-id>
need: <one line: what you need from the contract>
why: <one line: why the product needs it>
state: open
```

- `contract` — the contract id exactly as published (check the project's contract registry or catalog if one exists).
- `need` — the concrete ask: e.g. "consume events in format X" or "a versioned read surface for Y".
- `why` — the business reason; the system copies it into the proposed task's history.
- `state` — `open` while the need stands; a product session later flips it to `served` or `withdrawn`.

### 3. Validate

Run the project's outbox validator (e.g. `forge outbox.validate` where registered, or `werkstatt run outbox.validate`). It must exit 0 — fix OUTBOX-01/02 diagnostics before committing.

### 4. Commit with the product work

The entry is tracked like any source file — include it in the change that needs it, on the product's governed branch. The system's next scan reads only what reached `develop`; uncommitted or unintegrated entries stay invisible by design.

## After the scan

A matched entry becomes a **proposed task** for the offering product. The operator fills the dispatch brief and moves it to `ready` — nothing dispatches automatically. When your own task report carries `outbox:` entries pointing at needs you served, the collection path records them.
