# @warpgogol/werkstatt-typescript

Українська | [English](README.md)

Плагін Werkstatt для загальних TypeScript TurboRepo проєктів. Реалізує `werkstatt/plugin@1` з `profileId: "typescript-turborepo"`.

---

## Що робить цей пакет

Це **стек-плагін** для рушія [Werkstatt](https://github.com/syrokomskyi/werkstatt). Він надає шість валідаторів найкращих практик для TypeScript монорепозиторіїв, що використовують Turborepo та pnpm:

- **Валідація tsconfig** — строгий режим, консистентні moduleResolution та target між пакетами робочого простору
- **Контроль меж імпорту** — жодних порушень імпорту з packages у apps
- **Виявлення фантомних залежностей** — усі імпортовані пакети повинні бути оголошені в package.json
- **Валідація package exports** — записи exports у package.json вказують на існуючі файли
- **Угоди строгого режиму** — жодних неекранованих `any`, явні типи повернення для експортованих функцій, жодних необґрунтованих `@ts-ignore`
- **Безпека barrel-експортів** — barrel-файли не реекспортують Node-only модулі без subpath exports

Ви не використовуєте цей пакет самостійно — його завантажує рушій Werkstatt, коли ви створюєте проєкт з профілем `typescript-turborepo`.

---

## Встановлення

Цей пакет встановлюється як devDependency разом з рушієм Werkstatt:

```sh
pnpm add -D @warpgogol/werkstatt @warpgogol/werkstatt-typescript
```

> **Примітка для агентів:** Під час створення каркасу проєкту через `forge create --profile typescript-turborepo` завжди встановлюйте рушій та цей плагін після завершення скаффолдингу. Прив'язки у `forge.yaml` посилаються на команди з цих пакетів, і вони завершаться помилкою, якщо пакети не встановлені.

---

## Як це вписується в екосистему Werkstatt

| Пакет | Роль |
| --- | --- |
| `@warpgogol/forge` | Шар управління — навички, RFC/ADR робочі процеси, CLI, скаффолдинг проєктів |
| `@warpgogol/werkstatt` | Рушій виконання — місії, релізи, деплой, сертифікація, Bordbuch |
| `@warpgogol/werkstatt-shared` | Спільна інфраструктура — перевірки, інтеграція, онтологія, паспорт |
| `@warpgogol/werkstatt-typescript` | **Цей пакет** — стек-плагін TypeScript з валідаторами найкращих практик |

**Forge** створює проєкт і налаштовує управління. **Werkstatt** керує життєвим циклом (місії, релізи, деплой). **Цей плагін** надає TypeScript-специфічні валідатори, які рушій викликає під час check gate.

---

## Валідатори

Плагін реєструє 6 kernel-команд:

| Команда | Інваріант | Що перевіряє |
| --- | --- | --- |
| `ts.tsconfig.validate` | TS-001 | tsconfig.base.json існує з `strict: true` та консистентними `moduleResolution`/`target` між пакетами |
| `ts.import.boundaries.validate` | TS-002 | Жодних порушень меж імпорту з packages у apps |
| `ts.phantom.deps.validate` | TS-003 | Жодних фантомних залежностей — усі імпорти оголошені в package.json |
| `ts.package.exports.validate` | TS-004 | Записи exports у package.json вказують на існуючі файли |
| `ts.strict.mode.validate` | TS-005 | Невиробничий вихідний код слідує угодам строгого режиму (жодних неекранованих `any`, явні типи повернення, жодних необґрунтованих `@ts-ignore`) |
| `ts.barrel.validate` | TS-006 | Barrel-експорти не реекспортують Node-only модулі без subpath exports |

Валідатори — автономні kernel-команди, не інтегровані в пайплайн. Їх можна запускати індивідуально або як частину check gate.

---

## Профіль стеку

| Профіль | Тип проєкту | Перший робочий простір | Призначення |
| --- | --- | --- | --- |
| `typescript-turborepo` | Бібліотека TypeScript | — | Загальний TypeScript TurboRepo монорепозиторій з валідаторами найкращих практик |

Створіть новий TypeScript проєкт:

```sh
mkdir my-ts-project
cd my-ts-project
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript-turborepo
```

---

## Угоди шляхів

| Шлях | Значення |
| --- | --- |
| Директорія контенту | `src` |
| Директорія дистрибуції | `dist` |
| Точки входу | `src/index.ts` |

---

## Програмний API

```ts
import { werkstattTypescriptPlugin } from "@warpgogol/werkstatt-typescript";

// Реєстрація плагіна в рушії Werkstatt
engine.registerPlugin(werkstattTypescriptPlugin);
```

Плагін експортує єдиний об'єкт `WerkstattPlugin` з `profileId: "typescript-turborepo"`. Рушій виявляє його автоматично, коли пакет встановлено.

### Subpath exports

| Export | Що надає |
| --- | --- |
| `@warpgogol/werkstatt-typescript` | Точка входу плагіна (`werkstattTypescriptPlugin`) |
| `@warpgogol/werkstatt-typescript/paths` | Угоди шляхів TypeScript |
| `@warpgogol/werkstatt-typescript/invariants` | Оголошення інваріантів TS-001..006 |
| `@warpgogol/werkstatt-typescript/checks/module` | Kernel-модуль з реєстраціями валідаторів |

---

## Архітектура

```text
src/
  index.ts                          # Точка входу плагіна — werkstattTypescriptPlugin
  paths/
    typescript-paths.ts             # Угоди шляхів TypeScript
  invariants/
    typescript-invariants.ts        # Оголошення стек-інваріантів TS-001..006
  checks/
    module.ts                       # Реєстрація модуля typescript-checks
    diagnostic-helpers.ts           # Спільні діагностичні/summary хелпери для валідаторів
    tsconfig-validate.ts            # ts.tsconfig.validate (TS-001)
    import-boundaries-validate.ts   # ts.import.boundaries.validate (TS-002)
    phantom-deps-validate.ts        # ts.phantom.deps.validate (TS-003)
    package-exports-validate.ts     # ts.package.exports.validate (TS-004)
    strict-mode-validate.ts         # ts.strict.mode.validate (TS-005)
    barrel-validate.ts              # ts.barrel.validate (TS-006)
  __tests__/
    plugin-entry.test.ts            # Тести точки входу плагіна
    validators.test.ts              # Unit-тести валідаторів
```

## Архітектурні обмеження

- Жодних імпортів з `@warpgogol/werkstatt-site` або інших стек-плагінів.
- Жодних імпортів з пакета рушія, окрім типів контракту плагіна та kernel-типів.
- Жодних адаптерів деплою — деплой — це інфраструктура робочого простору.
- Жодних нових хуків рушія — список хуків закритий на п'яти.
- Використовуйте `execFile()`, а не `exec()` для виклику зовнішніх бінарників (DNA-89).
- Валідатори — автономні kernel-команди, не інтегровані в пайплайн.

---

## Публікація в npm

Цей пакет публікується в реєстр npm як `@warpgogol/werkstatt-typescript`. Публікація автоматизована через GitHub Actions CI.

### Як це працює

1. Вихідний код знаходиться в монорепозиторії [warpgogol/werkstatt](https://github.com/syrokomskyi/werkstatt) у `packages/werkstatt-typescript/`.
2. [`@warpgogol/repo-extract`](https://github.com/syrokomskyi/repo-extract) витягує пакет у автономний репозиторій [syrokomskyi/werkstatt-typescript](https://github.com/syrokomskyi/werkstatt-typescript), вирівнюючи його до кореня репозиторію та видаляючи залежності робочого простору.
3. Згенерований GitHub Actions CI workflow запускається при кожному push у `main`: lint → typecheck → build → test → `npm publish --provenance --access public`.
4. Секрет `NPM_TOKEN` повинен бути встановлений у [налаштуваннях репозиторію](https://github.com/syrokomskyi/werkstatt-typescript/settings/secrets/actions).

### Запуск нового релізу

З кореня монорепозиторію werkstatt:

```sh
# 1. Підніміть версію в packages/werkstatt-typescript/package.json
# 2. Запустіть екстракцію (витягує + комітить + пушить у github.com:syrokomskyi/werkstatt-typescript.git)
pnpm exec repo-extract --config packages/werkstatt-typescript/extract.config.yaml --verbose

# 3. CI підхопить push і опублікує в npm автоматично
```

Після завершення CI перевірте нову версію на [npmjs.com/package/@warpgogol/werkstatt-typescript](https://www.npmjs.com/package/@warpgogol/werkstatt-typescript).

---

## RFC

- **RFC-0889** — Додати плагін werkstatt-typescript (стек TypeScript TurboRepo з валідаторами найкращих практик).

---

## Ліцензія

Apache-2.0
