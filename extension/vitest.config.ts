import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The real `vscode` module only exists inside the extension host. Tests
      // resolve it to a stub; `tsc` still checks against @types/vscode, so the
      // API surface stays honest.
      vscode: fileURLToPath(new URL("./test/vscode-stub.ts", import.meta.url)),
    },
  },
});
