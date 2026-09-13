# Why Forge?

## The problem

AI-assisted development is powerful but chaotic. Rules live in prompts that vanish between sessions. Architecture decisions stay implicit. "Done" means the agent says so. When you switch agents or start a new session, the project context is gone.

## The solution

Forge keeps AI-assisted development under engineering control. Project rules, architectural decisions, RFCs, reusable agent skills, and deterministic checks live with the repository — not in an AI chat session.

## The core idea

**Agents can change. Models can change. IDEs can change. Engineering rules stay with the project.**

Forge is not another AI model or coding agent. It is the project control layer that sits between any AI agent and your repository, ensuring that development follows engineering discipline regardless of which tool you use.

## How it works

```
IDE / AGENT / MODEL
       ↓
┌──────────────────────────────────┐
│             FORGE                 │
│                                   │
│ Project contract      forge.yaml  │
│ Decisions             RFC / ADR   │
│ Agent workflows       Skills      │
│ Verification          Validators  │
│ Evolution             Upgrade     │
└──────────────────────────────────┘
       ↓
YOUR REPOSITORY
```

- **Project contract** — `forge.yaml` defines bindings, paths, and terminology. The agent reads it to understand project-specific commands.
- **Decisions** — RFCs and ADRs capture architectural decisions with traceability.
- **Agent workflows** — Repository-local skills define repeatable workflows that survive between sessions.
- **Verification** — Validators and `forge doctor` provide deterministic checks, not "the agent says it's done."
- **Evolution** — Upgrades are additive and idempotent. New Forge versions sync skills without overwriting your decisions.

## Forge is for you if

- You use AI agents for development and want engineering control
- You want project rules to survive between sessions and across agents
- You want deterministic verification, not agent self-assessment
- You want a portable project contract that works with any IDE or agent
