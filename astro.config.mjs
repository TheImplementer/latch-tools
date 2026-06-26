// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  output: "static",
  site: "https://latchtools.com",
  // Canonical URLs, the sitemap, and Cloudflare Pages all serve the
  // directory-index (trailing-slash) form — enforce it so internal links and
  // the dev server match production.
  trailingSlash: "always",
  integrations: [sitemap()],
  vite: {
    // jSquash WASM codecs break Vite's dependency optimizer — exclude them so
    // they load correctly as lazy dynamic imports. (jSquash README workaround.)
    optimizeDeps: {
      exclude: ["@jsquash/avif", "@jsquash/jxl"],
    },
    // The AVIF encoder ships a multithreaded variant that bundles a Web Worker.
    // Rollup can't code-split the default `iife` worker format, so emit ES
    // workers. (We run single-threaded at runtime — no cross-origin isolation —
    // so this only matters for the build to bundle cleanly.)
    worker: {
      format: "es",
    },
  },
});
