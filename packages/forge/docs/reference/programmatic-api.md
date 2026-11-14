# Programmatic API

`@warpgogol/forge` exposes module factories, config helpers, the skill registry, and canonical types from its package root. Modules expose `commands` and `pipelines` arrays directly — read them; you do not need a registry object.

## A complete working example

This snippet compiles against the published API surface:

```ts
import {
  createForgeRfcModule,
  loadForgeConfig,
  FORGE_SKILLS,
  type ForgeLogger,
  type ForgeRuntimeContext,
} from "@warpgogol/forge";

const logger: ForgeLogger = {
  section: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
  success: console.log,
};

const context: ForgeRuntimeContext = {
  workspaceRoot: process.cwd(),
  logger,
  dryRun: false,
  outputFormat: "json",
};

const rfcModule = await createForgeRfcModule();
const rfcValidate = rfcModule.commands.find((c) => c.name === "rfc.validate");

const result = await rfcValidate?.execute({ argv: [], flags: {} }, context);
console.log(result?.exitCode); // 0 = pass, 1 = fail
```

## Loading config

```ts
const config = loadForgeConfig(process.cwd());
```

Returns a typed `ForgeConfig` object, or throws if `forge.yaml` is missing or invalid.

## Resolving bindings

```ts
const cmd = resolveBinding(config, "commands.validateRfc", { id: "RFC-0001" });
// → "forge rfc.validate RFC-0001 --json"
```

Placeholders in binding strings are substituted with the provided values.

## Invoking commands

Each `ForgeCommandDefinition` carries `name`, `flags`, `reads`/`writes` declarations, and `execute(input, context)`:

```ts
const result = await command.execute(
  { argv: ["--json"], flags: { json: true } },
  context,
);
```

`ForgeCommandResult` carries `exitCode` (0/1), `summary`, optional `data`, `nextSteps`, and `timing`. Handlers must degrade cleanly when optional context ports (`commandRegistry`, `io`, `invoke`) are absent — under the standalone CLI, `io` and `invoke` are not populated.

`ForgeModuleRegistry` (`registerCommand`/`registerPipeline`) is the collection interface the standalone `forge` CLI builds internally — consumers read `module.commands` / `module.pipelines` instead of implementing it.

## Exported modules

Factories return `Promise<ForgeModule>`; `forgeCompassModule`, `forgeWerkstattModule` and `forgePluginModule` are exported consts.

| Module | Command surface (canonical names; the CLI also resolves the unqualified spelling) |
| --- | --- |
| `createForgeCoreModule` | `forge.create`, `forge.init`, `forge.scaffold`, `forge.doctor`, `forge.upgrade`, `forge.validate`, `forge.dev`, `forge.build`, `forge.skill.*`, `forge.agents.generate`, `forge.profile.validate`, `forge.port.*`, `forge.public-surface.validate`, `forge.autonomy.validate`, `forge.package.health`, `forge.release.*`, `forge.determinism.check`, `forge.assets.*`, `docs.archive`, `memory.compact`, `pinned.*`, `file.size.lint` |
| `createForgeRfcModule` | `rfc.list`, `rfc.create`, `rfc.validate`, `rfc.next-id`, `rfc.check`, `rfc.archive`, `rfc.acceptance.run`, `rfc.verification.*`, `rfc.implement.stamp`, `rfc.evidence.sync`, `rfc.verify.workspace`, `rfc.supersede.propose`, `rfc.index.*`, `rfc.graph`, `rfc.decision-log.generate`, `rfc.dna.trace.*`, `rfc.pipeline.status`, `rfc.command-lifecycle.validate` |
| `createForgeAdrModule` | `adr.list`, `adr.create`, `adr.validate`, `adr.archive`, `adr.implement.stamp` |
| `createForgePlanModule` | `plan.archive` |
| `createForgeAuditModule` | `audit.archive` |
| `createForgeMissionModule` | `mission.archive` |
| `createForgeSpecModule` | `spec.validate`, `spec.status`, `spec.materialize`, `spec.live.list`, `spec.live.show`, `spec.live.validate`, `spec.live.merge`, `spec.live.rebuild` |
| `createForgeProgramModule` | `program.packet.validate`, `program.packet.seal`, `program.packet.lease`, `program.packet.complete` |
| `forgePluginModule` | `forge.plugin.validate`, `forge.plugin.discover` |
| `createForgeWorkflowModule` | `workflow.lint`, `workflow.list` |
| `createForgeNamingModule` | `naming.convention.lint` |
| `forgeCompassModule` | `compass.inventory`, `compass.validate`, `compass.summary.trim`, `compass.docs.scaffold`, `compass.docs.validate`, `compass.header.scaffold`, `compass.migrate`, `compass.invariants.generate`, `compass.audit.*` |
| `forgeWerkstattModule` | `werkstatt.lock.status`, `werkstatt.lock.recover`, `werkstatt.operation.validate` |
| `createForgeExplorationModule` | `exploration.list`, `exploration.show`, `exploration.archive` |
| `createForgeNotesModule` | `note.link.validate`, `note.frontmatter.validate`, `note.orphan.detect` |
| `createForgeFlowModule` | `flow.open`, `flow.check`, `flow.integrate`, `flow.discard`, `flow.fix`, `flow.digest`, `flow.push`, `flow.cut`, `flow.hold`, `flow.unhold`, `flow.backmerge`, `flow.install`, `flow.status`, `flow.peers`, `flow.version`, `flow.publication.retire` |
| `createForgeSystemModule` | `system.map.validate`, `system.outbox.scan`, `system.task.*`, `system.versionset.record`, `outbox.validate` |

Internal modules loaded by the standalone CLI (session, context, trajectory, gate, conformance, correctness, codebase, and others) are not part of the package's public export surface — drive them through the `forge` CLI rather than imports.

## FORGE_SKILLS

`FORGE_SKILLS` is the discovered skill registry — one `ForgeSkillEntry` (name + parsed frontmatter) per `SKILL.md` under `skills/` (`FORGE_SKILLS.length` tracks the shipped count, currently 41).

```ts
import { FORGE_SKILLS } from "@warpgogol/forge";

for (const skill of FORGE_SKILLS) {
  console.log(skill.name, skill.description);
}
```
