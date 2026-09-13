# @warpgogol/forge

Українська | [English](README.md)

**ШІ може писати код. Forge тримає проєкт інженерним.**

Репозиторіо-нативний шар управління для розробки за допомогою ШІ. Рішення, правила, навички та перевірки залишаються з проєктом — незалежно від агента, який з ним працює.

[![npm version](https://img.shields.io/npm/v/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![npm downloads](https://img.shields.io/npm/dm/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![CI](https://github.com/syrokomskyi/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/syrokomskyi/forge/actions) [![Node](https://img.shields.io/badge/Node-24%2B-green.svg)](https://nodejs.org) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

---

## Швидкий старт

```sh
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript-turborepo
```

Потім відкрийте проєкт у вашому ШІ-IDE (Windsurf, Cursor, Claude Code, Codex CLI або будь-якому IDE з підтримкою ШІ-агентів) і скажіть агентові, що ви хочете створити.

Одна команда. Далі — робота через агента.

### Профілі стеку

Forge не залежить від типу проєкту. Профілі стеку — готові стартові точки.

| Профіль                          | Призначення                                 |
| -------------------------------- | ------------------------------------------- |
| `forge-shell`                    | Лише управління, бібліотеки, не-веб проєкти |
| `typescript-turborepo`           | TypeScript монорепозиторій з валідаторами   |
| `phaser-turborepo`               | Браузерні ігри, інтерактивні досвіди        |
| `godot-csharp`                   | Десктопні/мобільні ігри на Godot 4.x + C#   |
| `knowledge-typescript-turborepo` | Бази знань з підтримкою доказів             |

```sh
# Перелічити доступні профілі
pnpm exec forge profile.validate
```

---

## Архітектура

```
IDE / АГЕНТ / МОДЕЛЬ
       ↓
┌──────────────────────────────────┐
│             FORGE                 │
│                                   │
│ Контракт проєкту      forge.yaml  │
│ Рішення                RFC / ADR   │
│ Поведінка агента      Skills      │
│ Перевірка             Validators  │
│ Еволюція              Upgrade     │
└──────────────────────────────────┘
       ↓
ВАШ РЕПОЗИТОРІЙ
```

Агенти можуть змінюватися. Моделі можуть змінюватися. IDE можуть змінюватися. Інженерні правила залишаються з проєктом.

---

## Що контролює Forge

| Площина              | Що управляє                                         |
| -------------------- | --------------------------------------------------- |
| **Намір**            | RFC, архітектурна ДНК, критерії приймання           |
| **Рішення**          | ADR, журнали рішень, відстежуваність                |
| **Поведінка агента** | Локальні навички та робочі процеси                  |
| **Перевірка**        | Doctor, валідатори, контракти, детерміновані гейти  |
| **Еволюція**         | Профілі, вендоринг специфікацій, адитивні оновлення |

---

## Без Forge / З Forge

| Розробка з ШІ без Forge                | З Forge                                          |
| -------------------------------------- | ------------------------------------------------ |
| Правила живуть у промптах              | Правила живуть у репозиторії                     |
| Архітектура неявна                     | Рішення стають RFC та ADR                        |
| Поведінка агента залежить від сесії    | Локальні навички визначають відтворювані процеси |
| «Готово» означає, що агент так каже    | Валідатори дають детерміновані перевірки         |
| Новий агент починає з нуля             | Контракт проєкту подорожує з кодом               |
| Оновлення ризикує перезаписати рішення | Оновлення адитивне та ідемпотентне               |
| Конвенції специфічні для інструменту   | Агент- та IDE-незалежний шар проєкту             |

---

## Forge Є / Forge Не Є

**Forge Є**

- Репозиторіо-нативний шар управління
- Агент-незалежна інфраструктура проєкту
- Детерміноване доповнення до ймовірнісних ШІ-агентів
- Портативний контракт проєкту

**Forge Не Є**

- Ще однією ШІ-моделлю
- Ще одним агентом-кодером
- IDE
- Хостованою платформою
- Заміною Git
- Магічною обгорткою «vibe coding»

---

## Що ви отримуєте

- **37 навичок** — пайплайн ідея→RFC, grilling, preferences, авторинг навичок
- **RFC робочий процес** — створення, валідація, перелік, граф, архівування, acceptance probes
- **ADR робочий процес** — легкі записи архітектурних рішень
- **Вендоринг специфікацій** — вендоринг зовнішніх специфікацій як незмінних снапшотів
- **Конвенції найменування** — kebab-case linting
- **Linting робочих процесів** — валідація frontmatter `.agents/workflows/`
- **Скаффолдинг стеку** — pnpm + Turborepo монорепозиторій з профілю
- **Контракт прив'язок** — деконкретизація команд проєкту через `forge.yaml`
- **Doctor** — перевірка здоров'я проєкту
- **Upgrade** — адитивна, ідемпотентна синхронізація навичок та конфігурації

---

## Робота з вашим ШІ-агентом

Forge працює з будь-яким ШІ-агентом — Windsurf, Cursor, Claude Code, Codex CLI або будь-яким IDE, що підтримує навички агентів. Налаштування однакове; важлива лише розмова.

**Починайте з питань, а не з команд.** Перед тим, як просити агента писати код, запитайте його про кодову базу. Агент може читати файли, шукати в історії git та запускати CLI-команди Forge — дайте йому спочатку дослідити.

**Описуйте результат, а не кроки.** Скажіть агенту, що ви хочете, а не як це зробити. Для складних задач просіть агента спочатку спланувати.

**Дозвольте агенту перевіряти власну роботу.** Дайте критерії «готовно» і дозвольте агенту перевірити себе: «Запусти тести після завершення.» «Валідуй RFC перед комітом.» «Перевір здоров'я проєкту через `forge doctor`.»

**AGENTS.md — постійна пам'ять вашого проєкту.** Forge генерує файли `AGENTS.md`, які агент читає на початку кожної сесії. Кладіть туди команди збірки, стиль коду, архітектурні рішення та правила «роби X, а не Y».

---

## CLI

```sh
# Перевірити здоров'я проєкту
pnpm exec forge doctor

# Валідувати RFC
pnpm exec forge rfc.validate

# Перелічити доступні навички
pnpm exec forge skill.list

# Синхронізувати навички та конфігурацію
pnpm exec forge upgrade

# Перевірити консистентність публічної поверхні
pnpm exec forge public-surface.validate
```

Повний довідник CLI: [docs/reference/cli.md](docs/reference/cli.md)

---

## forge.yaml

Єдине джерело істини для конфігурації проєкту:

```yaml
schema: forge/config@1
project:
  name: my-project
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  skillsDir: .agents/skills
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: "forge rfc.validate {id} --json"
    typecheck: "pnpm run build:check"
    test: "pnpm test"
  paths:
    invariantsFile: docs/architecture-dna.md
  terminology:
    invariants: DNA
```

Повний довідник: [docs/reference/forge-yaml.md](docs/reference/forge-yaml.md)

---

## Програмний API

```ts
import {
  forgeCoreModule,
  forgeRfcModule,
  loadForgeConfig,
  resolveBinding,
  FORGE_SKILLS,
} from "@warpgogol/forge";

const config = loadForgeConfig(process.cwd());
const cmd = resolveBinding(config, "commands.validateRfc", { id: "RFC-0001" });

const registry = /* ваш ForgeModuleRegistry */;
await forgeCoreModule.register(registry);
await forgeRfcModule.register(registry);
```

Повний API: [docs/reference/programmatic-api.md](docs/reference/programmatic-api.md)

---

## Структура

| Директорія | Призначення |
| --- | --- |
| `src/` | Портативне ядро — типи, конфіг, реєстр навичок, валідатори, онбординг. Нуль `@warpgogol/*` імпортів. |
| `os/` | Реєстрації ForgeModule. `compass` та `werkstatt` — повністю автономні. |
| `bin/` | Точка входу CLI (команда `forge`). |
| `skills/` | 37 визначень навичок (29 fo + 5 спільних + 3 мета) з SKILL.md frontmatter. |
| `profiles/` | Профілі стеку для `scaffold`. |

---

## Оновлення

```sh
pnpm update @warpgogol/forge
pnpm exec forge upgrade
pnpm exec forge doctor
```

`forge upgrade` — адитивний: ніколи не перезаписує прив'язки, встановлені оператором, ніколи не видаляє файли, ідемпотентний. Використовуйте `--dry-run` для попереднього перегляду.

---

## Документація

- [Початок роботи](docs/getting-started.md)
- [Чому Forge?](docs/concepts/why-forge.md)
- [Контракт проєкту](docs/concepts/project-contract.md)
- [Модель управління](docs/concepts/governance-model.md)
- [Перенесення наявного проєкту](docs/guides/existing-project.md)
- [Оновлення](docs/guides/upgrading.md)
- [Навички](docs/guides/skills.md)
- [RFC та ADR робочі процеси](docs/guides/rfc-adr.md)
- [Довідник CLI](docs/reference/cli.md)
- [Довідник forge.yaml](docs/reference/forge-yaml.md)
- [Профілі](docs/reference/profiles.md)
- [Програмний API](docs/reference/programmatic-api.md)
- [Публікація](docs/maintainers/publishing.md)

---

## Ліцензія

Apache-2.0

## Відкрита інженерія

Цей пакет походить з виробничої інженерної роботи [Warpgogol](https://warpgogol.com), інженерної студії в Німеччині.

Ми публікуємо багаторазово використовувані частини нашої інфраструктури, коли вони можуть бути корисні поза нашими власними проєктами. Пакет публікується незалежно від будь-якого комерційного сервісу Warpgogol. Використання цього пакету не створює залежності від Warpgogol.

Створено для реальних систем. Поділяємо відкрито.
