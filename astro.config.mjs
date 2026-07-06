// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Build a { "/pathname/": "<ISO git date>" } map from each page's last commit so
// the sitemap can emit accurate per-URL <lastmod>. Bing weights lastmod for crawl
// prioritisation, and per-file git dates stay honest (they only move when a page
// actually changes — unlike a build-time "everything changed now" stamp). Runs at
// config load; local builds have git available (we deploy via direct-upload).
const pagesDir = fileURLToPath(new URL("./src/pages", import.meta.url));
let headDate;
try {
  headDate = execSync("git log -1 --format=%cI", { encoding: "utf8" }).trim();
} catch {
  headDate = new Date().toISOString();
}
/** @type {Record<string, string>} */
const lastmodByPath = {};
for (const file of readdirSync(pagesDir)) {
  if (!file.endsWith(".astro")) continue;
  const pathname =
    file === "index.astro" ? "/" : `/${file.replace(/\.astro$/, "")}/`;
  let date = headDate;
  try {
    const out = execSync(`git log -1 --format=%cI -- "src/pages/${file}"`, {
      encoding: "utf8",
    }).trim();
    if (out) date = out;
  } catch {
    /* keep HEAD-date fallback */
  }
  lastmodByPath[pathname] = date;
}

export default defineConfig({
  output: "static",
  site: "https://latchtools.com",
  // Canonical URLs, the sitemap, and Cloudflare Pages all serve the
  // directory-index (trailing-slash) form — enforce it so internal links and
  // the dev server match production.
  trailingSlash: "always",
  integrations: [
    sitemap({
      serialize(item) {
        const lastmod = lastmodByPath[new URL(item.url).pathname];
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
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
