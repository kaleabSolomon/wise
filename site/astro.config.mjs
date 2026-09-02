// @ts-check
import { defineConfig } from "astro/config";

// Static output, served from the root of whatever host it lands on. If it ends
// up under a sub-path (e.g. GitHub Pages at /wise/), set `base` here.
export default defineConfig({
  output: "static",
});
