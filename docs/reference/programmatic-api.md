# Programmatic API

## Importing

```ts
import {
  forgeCoreModule,
  forgeRfcModule,
  forgeAdrModule,
  forgeNamingModule,
  forgeCompassModule,
  forgeWorkflowModule,
  forgeSpecModule,
  forgeSessionModule,
  forgePluginModule,
  forgeProgramModule,
  loadForgeConfig,
  resolveBinding,
  FORGE_SKILLS,
} from "@warpgogol/forge";
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

## Registering modules

```ts
const registry = /* your ForgeModuleRegistry */;

await forgeCoreModule.register(registry);
await forgeRfcModule.register(registry);
await forgeAdrModule.register(registry);
await forgeNamingModule.register(registry);
await forgeCompassModule.register(registry);
```

Each module registers its commands with the registry. Modules are independent — register only what you need.

## Available modules

| Module | Commands |
| --- | --- |
| `forgeCoreModule` | `create`, `doctor`, `upgrade`, `scaffold`, `skill.validate`, `skill.list`, `profile.validate`, `agents.generate`, `docs.archive`, `public-surface.validate` |
| `forgeRfcModule` | `rfc.list`, `rfc.validate`, `rfc.create`, `rfc.verification.emit`, `rfc.implement.stamp` |
| `forgeAdrModule` | `adr.list`, `adr.create`, `adr.validate`, `adr.archive`, `adr.implement.stamp` |
| `forgeNamingModule` | `naming.convention.lint` |
| `forgeCompassModule` | `compass.inventory`, `compass.validate`, `compass.summary.trim` |
| `forgeWorkflowModule` | `workflow.lint`, `workflow.list`, `workflow.amend.list` |
| `forgeSpecModule` | `spec.validate`, `spec.status`, `spec.materialize`, `spec.live.merge` |
| `forgeSessionModule` | `session.save`, `session.archive`, `session.validate`, `session.list`, `metrics.aggregate` |
| `forgePluginModule` | `forge.plugin.validate`, `forge.plugin.discover` |
| `forgeProgramModule` | `program.packet.validate`, `program.packet.seal`, `program.packet.lease`, `program.packet.complete` |

## FORGE_SKILLS

The `FORGE_SKILLS` export contains the full skill registry — all 37 skill definitions with their frontmatter.

```ts
import { FORGE_SKILLS } from "@warpgogol/forge";

for (const skill of FORGE_SKILLS) {
  console.log(skill.name, skill.description);
}
```
