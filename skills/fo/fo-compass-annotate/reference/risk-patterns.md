# Deterministic Risk Patterns

These patterns are scanned deterministically (no LLM) to flag files that handle sensitive operations. When a pattern matches, a `<!-- risk: <pattern> -->` comment is added inside the `MODULE_CONTRACT` block.

## Patterns

| Pattern    | Regex         | Risk level | Description   |
| ---------- | ------------- | ---------- | ------------- |
| `sign`     | `\b(sign      | signing    | signature)\b` | high      | Cryptographic signing operations |
| `crypto`   | `\b(crypto    | encrypt    | decrypt       | cipher    | aes                              | rsa                    | hmac)\b`                    | high                       | Cryptographic operations |
| `vault`    | `\b(vault     | secret     | password      | apiKey    | api_key                          | token)\b`              | high                        | Secret/credential handling |
| `migrate`  | `\b(migrate   | migration  | migrator)\b`  | medium    | Data migration logic             |
| `publish`  | `\b(publish   | deploy     | release)\b`   | medium    | Publishing/deployment operations |
| `delete`   | `\b(delete    | remove     | destroy       | purge)\b` | medium                           | Destructive operations |
| `network`  | `\b(fetch     | http       | request       | axios     | got)\b`                          | low                    | Network requests            |
| `fs-write` | `\b(writeFile | mkdir      | rm            | unlink    | rename)\b`                       | low                    | Filesystem write operations |

## Rules

- Patterns are case-insensitive.
- A file may have multiple risk flags.
- Risk flags are informational — they do not block validation.
- The `risk` comment is placed after `<non-goals>` and before `</MODULE_CONTRACT>`.
