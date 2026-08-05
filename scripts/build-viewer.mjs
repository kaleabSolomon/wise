/**
 * Build the viewer's browser assets:
 *   - bundle src/viewer/client/app.ts -> <out>/app.js (esbuild)
 *   - copy index.html + styles.css -> <out>   (prod only; sources for dev)
 *
 * Default output is dist/viewer/public (shipped with the binary). With --dev it
 * writes app.js next to the source html/css in src/viewer/public so the dev
 * server (which reads assets relative to its own module) can serve them.
 */
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dev = process.argv.includes("--dev");
const srcPublic = join(root, "src/viewer/public");
const outDir = dev ? srcPublic : join(root, "dist/viewer/public");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src/viewer/client/app.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: !dev,
  sourcemap: dev,
  outfile: join(outDir, "app.js"),
  logLevel: "warning",
});

if (!dev) {
  for (const file of ["index.html", "styles.css"]) {
    await copyFile(join(srcPublic, file), join(outDir, file));
  }
}

console.log(`viewer assets built -> ${outDir}`);
