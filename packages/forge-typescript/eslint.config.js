import tseslint from "typescript-eslint";

export default tseslint.config(
  // typescript-eslint recommended rules for .ts files
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
  })),
  // .ts files — repo conventions
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
