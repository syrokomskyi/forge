# Comment Style Mapping by File Extension

Compass headers are embedded in source file comments. The comment syntax varies by language.

## Mapping

| Extension | Comment syntax              | Example                                                |
| --------- | --------------------------- | ------------------------------------------------------ |
| `.ts`     | `/* ... */` block comment   | `/* <MODULE_CONTRACT> ... </MODULE_CONTRACT> */`       |
| `.tsx`    | `/* ... */` block comment   | `/* <MODULE_CONTRACT> ... </MODULE_CONTRACT> */`       |
| `.astro`  | `<!-- ... -->` HTML comment | `<!-- <MODULE_CONTRACT> ... </MODULE_CONTRACT> -->`    |
| `.js`     | `/* ... */` block comment   | `/* <MODULE_CONTRACT> ... </MODULE_CONTRACT> */`       |
| `.mjs`    | `/* ... */` block comment   | `/* <MODULE_CONTRACT> ... </MODULE_CONTRACT> */`       |
| `.css`    | `/* ... */` block comment   | `/* <MODULE_CONTRACT> ... </MODULE_CONTRACT> */`       |
| `.yaml`   | `# ` line comment           | `# <MODULE_CONTRACT>` (each line prefixed with `# `)   |
| `.yml`    | `# ` line comment           | `# <MODULE_CONTRACT>` (each line prefixed with `# `)   |
| `.json`   | Not supported               | JSON files cannot carry comments; skip Compass headers |
| `.md`     | `<!-- ... -->` HTML comment | `<!-- <MODULE_CONTRACT> ... </MODULE_CONTRACT> -->`    |

## Rules

- The XML-like tags (`<MODULE_CONTRACT>`, `<CHANGE_SUMMARY>`, `<item>`, etc.) are always preserved as-is inside the comment wrapper.
- For `.yaml`/`.yml`, each line of the block is prefixed with `# `.
- For `.json`, Compass headers are not applicable — skip these files.
- The block is placed at the top of the file, after any license header but before code/imports.
