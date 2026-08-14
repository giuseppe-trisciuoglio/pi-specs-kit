// @ts-check
/**
 * ESLint flat config.
 *
 * The project has no build step: pi loads the TypeScript source directly via
 * jiti. Type checking is owned by `tsc --noEmit` (`npm run typecheck`); ESLint
 * owns style and correctness linting at the AST level (no type information),
 * which keeps CI fast and decoupled from the TypeScript compiler.
 */
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Files ESLint must never touch.
  {
    ignores: [
      "node_modules/**",
      "tmp/**",
      ".pi/**",
      "docs/**",
      "skills/**",
      "e2e/fake-bin/**",
    ],
  },

  // Recommended TypeScript rules (AST-level, not type-checked).
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Underscore-prefixed identifiers are intentional "unused" markers.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Numeric separators and intentional non-null assertions are part of the
      // established style; keep the linter from fighting them.
      "no-unused-private-class-members": "off",
      // The async-closure forward-reference pattern
      // (`let x; const cb = async () => x…; x = new X({ cb })`) cannot be
      // expressed with `const` without awkward indirection; allow it.
      "prefer-const": "off",
    },
  },
);
