// One-time: insert ogImage="/og/<slug>.png" into each page's <Layout> call
// (right after its description attr). Idempotent — skips pages already wired.
//   node scripts/wire-og.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../src/pages", import.meta.url)) + "/";
let wired = 0,
  skipped = 0;
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".astro")) continue;
  const slug = file.replace(/\.astro$/, "");
  const out = slug === "index" ? "home" : slug;
  const path = DIR + file;
  const src = readFileSync(path, "utf8");
  if (/\bogImage=/.test(src)) {
    console.log("skip (already wired) " + file);
    skipped++;
    continue;
  }
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => /^\s*description="/.test(l)); // the <Layout> description attr
  if (idx === -1) {
    console.log("MISS (no description= attr) " + file);
    continue;
  }
  const indent = (lines[idx].match(/^(\s*)/) || ["", ""])[1];
  lines.splice(idx + 1, 0, `${indent}ogImage="/og/${out}.png"`);
  writeFileSync(path, lines.join("\n"));
  console.log("ok " + file);
  wired++;
}
console.log(`\nWired ${wired}, skipped ${skipped}`);
