// Bundles the extension to a single CommonJS file.
//
// CJS rather than ESM because the VS Code extension host loads `main` with
// require(); `vscode` is provided by the host at runtime and must never be
// bundled in.
import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
