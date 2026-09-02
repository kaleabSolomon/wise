import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "src/viewer/public/app.js",
      // The landing page (Astro) carries its own toolchain.
      "site/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Plain JS/MJS (this config, the viewer build script) live outside any
  // tsconfig; skip type-aware rules and declare the Node globals they use.
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  // Casting SQLite's `unknown` rows to typed shapes is the store's one sanctioned
  // boundary; keep the type-checked unsafe rules but allow the cast itself.
  {
    files: ["src/store/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  // eslint-config-prettier must come last: it disables rules that fight the formatter.
  prettier,
);
