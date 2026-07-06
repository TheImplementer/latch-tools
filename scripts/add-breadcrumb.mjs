// One-time: add a BreadcrumbList node to each tool page's structuredData @graph,
// mirroring the visible breadcrumb (Tools / <page>). Name comes from the visible
// aria-current crumb; url from the page's SoftwareApplication.url. Idempotent.
//   node scripts/add-breadcrumb.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../src/pages", import.meta.url)) + "/";
const esc = (s) => s.replace(/"/g, '\\"');
let added = 0,
  skipped = 0,
  missed = 0;

for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".astro")) continue;
  const path = DIR + file;
  const src = readFileSync(path, "utf8");
  if (!/"@graph":\s*\[/.test(src)) continue; // page has no structured-data graph
  if (/"@type":\s*"BreadcrumbList"/.test(src)) {
    console.log("skip (already has crumb) " + file);
    skipped++;
    continue;
  }
  const nameM = src.match(/aria-current="page"[^>]*>\s*([^<]+?)\s*</);
  const urlM = src.match(/"url":\s*"(https:\/\/latchtools\.com\/[^"]+)"/);
  if (!nameM || !urlM) {
    console.log("MISS (no crumb name / url) " + file);
    missed++;
    continue;
  }
  const name = nameM[1].trim();
  const url = urlM[1];
  const lines = src.split("\n");
  const gi = lines.findIndex((l) => /"@graph":\s*\[\s*$/.test(l));
  if (gi === -1) {
    console.log("MISS (no @graph opener) " + file);
    missed++;
    continue;
  }
  const base = lines[gi].match(/^(\s*)/)[1] + "  "; // array-element indent
  const p = base + "  ";
  const block = [
    `${base}{`,
    `${p}"@type": "BreadcrumbList",`,
    `${p}"itemListElement": [`,
    `${p}  { "@type": "ListItem", "position": 1, "name": "Tools", "item": "https://latchtools.com/" },`,
    `${p}  { "@type": "ListItem", "position": 2, "name": "${esc(name)}", "item": "${url}" }`,
    `${p}]`,
    `${base}},`,
  ];
  lines.splice(gi + 1, 0, ...block);
  writeFileSync(path, lines.join("\n"));
  console.log(`ok ${file}  [Tools / ${name}]`);
  added++;
}
console.log(`\nAdded ${added}, skipped ${skipped}, missed ${missed}`);
