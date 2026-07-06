// Generates 1200×630 Open Graph share images (one per page) into public/og/.
// satori renders our card to SVG (vectorising text to paths with the brand font),
// then resvg rasterises to PNG. Re-run by hand when page copy/titles change:
//   node scripts/gen-og.mjs
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // project root, trailing /
const font700 = readFileSync(ROOT + "scripts/assets/space-grotesk-700.woff");
const font500 = readFileSync(ROOT + "scripts/assets/space-grotesk-500.woff");
mkdirSync(ROOT + "public/og", { recursive: true });

// Brand padlock as a PNG data URI (reuse the favicon; sharp is already a dep).
const logoPng = await sharp(ROOT + "public/favicon.svg", { density: 400 })
  .resize(96, 96)
  .png()
  .toBuffer();
const logoUri = `data:image/png;base64,${logoPng.toString("base64")}`;
const arrowUri =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 24 24' fill='none' stroke='#4b8bff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 12h14M13 6l6 6-6 6'/></svg>`,
  );

// hyperscript for satori's React-element-like nodes (no JSX in a plain .mjs)
const h = (type, props = {}, ...children) => ({
  type,
  props: { ...props, children: children.length <= 1 ? children[0] : children },
});

const FMT = {
  webp: "WebP",
  png: "PNG",
  jpg: "JPG",
  jpeg: "JPEG",
  avif: "AVIF",
  heic: "HEIC",
  jxl: "JXL",
  svg: "SVG",
  jfif: "JFIF",
  base64: "Base64",
  image: "Image",
  pdf: "PDF",
};
const fmt = (t) => FMT[t] ?? t.toUpperCase();

const BG = "#0b1220";
const MUTED = "#9aa4b2";
const ACCENT = "#4b8bff";

function brandRow() {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 22 } },
    h("img", { src: logoUri, width: 96, height: 96 }),
    h(
      "div",
      { style: { fontSize: 46, fontWeight: 700, letterSpacing: "-0.02em" } },
      "Latch Tools",
    ),
  );
}

function card(middle, sub) {
  return h(
    "div",
    {
      style: {
        width: 1200,
        height: 630,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 76,
        background: BG,
        color: "#ffffff",
        fontFamily: "Space Grotesk",
      },
    },
    brandRow(),
    middle,
    h("div", { style: { fontSize: 32, fontWeight: 500, color: MUTED } }, sub),
  );
}

function converterMiddle(from, to) {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 40 } },
    h(
      "div",
      { style: { fontSize: 108, fontWeight: 700, letterSpacing: "-0.03em" } },
      from,
    ),
    h("img", { src: arrowUri, width: 96, height: 96 }),
    h(
      "div",
      {
        style: {
          fontSize: 108,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: ACCENT,
        },
      },
      to,
    ),
  );
}

function titleMiddle(text) {
  const size = text.length > 22 ? 64 : 82;
  return h(
    "div",
    {
      style: {
        display: "flex",
        fontSize: size,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        lineHeight: 1.08,
        maxWidth: 1000,
      },
    },
    text,
  );
}

function brandMiddle(tagline) {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 12 } },
    h(
      "div",
      { style: { fontSize: 112, fontWeight: 700, letterSpacing: "-0.03em" } },
      "Latch Tools",
    ),
    h(
      "div",
      { style: { fontSize: 40, fontWeight: 500, color: MUTED } },
      tagline,
    ),
  );
}

function readH1(file) {
  const src = readFileSync(ROOT + "src/pages/" + file, "utf8");
  const m = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : file.replace(/\.astro$/, "");
}

const SUB = "Runs in your browser — no uploads, no sign-up.";
const jobs = [];
for (const file of readdirSync(ROOT + "src/pages")) {
  if (!file.endsWith(".astro")) continue;
  const slug = file.replace(/\.astro$/, "");
  const out = slug === "index" ? "home" : slug;
  let middle,
    sub = SUB;
  if (slug === "index") {
    middle = brandMiddle("Private, in-browser file tools");
    sub = "No uploads · No sign-up · Files never leave your device";
  } else if (slug === "about" || slug === "privacy-policy") {
    middle = brandMiddle("Private, in-browser file tools");
  } else {
    const conv = slug.match(/^(.+)-to-(.+)$/);
    if (conv) middle = converterMiddle(fmt(conv[1]), fmt(conv[2]));
    else middle = titleMiddle(readH1(file)); // remove-exif, resize-image, webp-a-png (ES)
  }
  jobs.push({ out, element: card(middle, sub) });
}

let n = 0;
for (const job of jobs) {
  const svg = await satori(job.element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Space Grotesk", data: font700, weight: 700, style: "normal" },
      { name: "Space Grotesk", data: font500, weight: 500, style: "normal" },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
    .render()
    .asPng();
  writeFileSync(ROOT + "public/og/" + job.out + ".png", png);
  n++;
}
console.log(`Generated ${n} OG images → public/og/`);
