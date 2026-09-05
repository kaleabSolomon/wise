import { defineConfig } from "vitest/config";

/*
 * Scope the suite to `src`.
 *
 * Without this, vitest globs the whole repo and picks up the tests belonging
 * to the sibling packages (`extension/`, and anything `site/` grows later).
 * Those have their own configs — the extension's aliases `vscode` to a stub —
 * so running them from here fails on imports that only resolve in their own
 * package. Each package runs its own tests.
 *
 * Plain JS, like the repo's other build tooling: a root-level `.ts` config is
 * outside `tsconfig.json`'s `src` include, which the type-aware lint rejects.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
