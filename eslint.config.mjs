import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".cache/**",
      "dist/**",
      "tmp/**",
      "public/app/js/**",
      "public/js/**",
      "public/site/assets/*.js",
      "public/sw.js"
    ]
  },
  { files: ["**/*.{js,mjs,cjs,ts,tsx,jsx}"] },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["bench/index.ts", "test/entrypoints.test.ts", "test/index.ts", "types/**/*.d.ts"],
    rules: {
      // These files load or describe the package's intentional CommonJS entrypoints.
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: [
      "client/apps/**/pages/**/*.{ts,tsx}",
      "client/core/**/pages/**/*.{ts,tsx}",
      "client/components/**/*.{ts,tsx}",
      "client/**/*.store.ts"
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/repositories/**"],
              message: "Use services/types instead of repositories in UI and stores."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["tests/core/client/**/*.test.ts", "tests/apps/**/client/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/client/repositories/**"],
              message: "Test client behavior through services, not repositories."
            }
          ]
        }
      ]
    }
  },
  {
    rules: {
      // Enforce const for variables that are never reassigned
      "prefer-const": "error",
      // Allow explicit any
      "@typescript-eslint/no-explicit-any": "off",
      // Disallow unused vars except for `v`
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^v$"
        }
      ]
    }
  }
);
