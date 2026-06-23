# Build plan: AVIF & JFIF conversion tools

## Context

Keyword research (Semrush, June 2026) surfaced three high-value, low-competition
conversion keywords with **commercial** intent and soft SERPs (top results rank
with very few referring domains). All three reuse decode/encode patterns already
in the codebase, so build cost is low. Priority order reflects rankability ×
volume × commercial value.

| Tool           | US vol | Global | Difficulty   | Intent     | CPC   | #1 ref domains | Notes                                                      |
| -------------- | ------ | ------ | ------------ | ---------- | ----- | -------------- | ---------------------------------------------------------- |
| `/avif-to-jpg` | 33.1K  | 335.7K | 35% Possible | Commercial | $0.60 | 42             | Lowest difficulty at highest volume. India = 135K.         |
| `/avif-to-png` | 27.1K  | 158.8K | 43% Possible | Commercial | $5.12 | 15             | 10× CPC — high monetisation value (image-CDN advertisers). |
| `/jfif-to-jpg` | 14.8K  | 169.2K | 46% Possible | Commercial | $0.51 | 24             | Trivial build (JFIF is JPEG).                              |

SERP softness (all three): multiple top-10 slots held by pages with 1–9 ref
domains, plus forum threads / YouTube videos — i.e. open space for a real tool.

---

## Shared technical approach

All three are "decode source format in-browser → re-encode via Canvas → download"
— the same client-side pattern as the existing converters. **No file bytes leave
the device** (core invariant). Heavy decoders are lazy-loaded only on first use.

- **AVIF pages** clone **`src/pages/webp-to-png.astro`**. Modern browsers
  (Chrome, Firefox, Safari 16+) decode AVIF natively, so `createImageBitmap(file)`
  → `canvas` works with no WASM decoder. The existing error state in webp-to-png
  already handles decode failure — extend the message so an old browser that
  can't decode AVIF gets a plain-language "your browser can't open AVIF, try
  updating" rather than a generic error.
- **`/jfif-to-jpg`** clones **`src/pages/png-to-jpg.astro`**. A `.jfif` file _is_
  JPEG data, so `createImageBitmap` decodes it natively in 100% of browsers;
  re-encode to `image/jpeg`. Keep the quality slider from png-to-jpg.

### Output format / quality per tool

- `/avif-to-jpg` — JPG output, **include quality slider** (default 92%), like png-to-jpg.
- `/avif-to-png` — PNG output, **no quality slider** (lossless), like webp-to-png.
- `/jfif-to-jpg` — JPG output, **include quality slider** (default 92%), like png-to-jpg.

### Input validation (`accept` + addFiles filter)

- AVIF pages: `accept=".avif,image/avif"`; validate ext `avif` or type `image/avif`.
- jfif page: `accept=".jfif,image/jpeg"`; validate ext `jfif` (also accept `jif`/`jpe`).

### Output filename + zip name

- `/avif-to-jpg`: `name.replace(/\.avif$/i, '.jpg')`, zip `avif-to-jpg.zip`
- `/avif-to-png`: `name.replace(/\.avif$/i, '.png')`, zip `avif-to-png.zip`
- `/jfif-to-jpg`: `name.replace(/\.(jfif|jif|jpe)$/i, '.jpg')`, zip `jfif-to-jpg.zip`

---

## Per-page content (SEO — required by CLAUDE.md)

Each page needs unique `<title>`, `<meta description>`, `<h1>`, JSON-LD
(`SoftwareApplication` + `HowTo` + `FAQPage`), a How-to section, a short
supporting-content section, an FAQ, and a Related-tools section. Follow the
structure of the recently-enriched `remove-exif.astro` / `heic-to-png.astro`.

### `/avif-to-jpg`

- **Title:** `Convert AVIF to JPG — Free, Private, No Upload | Latch`
- **H1:** `AVIF to JPG converter`
- **Angle:** "Downloaded an AVIF and need a JPG anything can open?" Smaller files,
  universal compatibility. FAQ: what is AVIF, why won't my software open it,
  quality, batch, is it uploaded.
- **fmt-pill:** AVIF → JPG

### `/avif-to-png`

- **Title:** `Convert AVIF to PNG — Free, Private, No Upload | Latch`
- **H1:** `AVIF to PNG converter`
- **Angle:** lossless output + transparency preserved (AVIF supports alpha). FAQ:
  transparency, PNG vs JPG, quality, batch, uploads. Cross-link to /avif-to-jpg
  for smaller files.
- **fmt-pill:** AVIF → PNG

### `/jfif-to-jpg`

- **Title:** `Convert JFIF to JPG — Free, Private, No Upload | Latch`
- **H1:** `JFIF to JPG converter`
- **Angle:** explain JFIF clearly — "JFIF is just a JPEG with a different
  extension; this renames/re-encodes it to the standard `.jpg` that every app
  expects." This informational nugget is the differentiator. FAQ: what is JFIF,
  why did I get one, is it the same as JPG, quality, batch.
- **fmt-pill:** JFIF → JPG

---

## Site-wide wiring (per new page)

1. **`src/pages/index.astro`** — add a tool card to the grid for each new page
   (clone an existing `.tool-card`; set icon, name, desc, `.chip` e.g.
   `.avif → .jpg`).
2. **`src/components/Footer.astro`** — add a link in the Tools column.
3. **Related-tools sections** — cross-link the new pages to each other and to
   relevant existing tools (e.g. avif pages link to each other + heic-to-jpg/png;
   jfif links to png-to-jpg + heic-to-jpg). Add a Related-tools block to each new
   page (reuse the `.tool-grid` pattern already in heic-to-png/remove-exif).
4. **Sitemap** — automatic via `@astrojs/sitemap`; no action needed.

---

## Verification

1. `npx astro check` — no TypeScript errors
2. `npm run build` — clean build
3. `npm run preview` — for each page confirm: renders, no quality slider on
   avif-to-png, slider present on the two JPG pages, FAQ expand/collapse, related
   links correct, tool card on home, footer link present.
4. Functional: drop a real `.avif` and a real `.jfif`; confirm correct download
   with the right extension; confirm multi-file zip name.
5. View source: each page's JSON-LD has a `FAQPage` with its Q&As.
6. Deploy: `npx wrangler pages deploy ./dist`, then purge Cloudflare cache for
   latchtools.com; request indexing for each new URL in Search Console.

---

## Build order

1. `/avif-to-jpg` (best rank×volume)
2. `/avif-to-png` (near-free alongside it — shared decode pipeline; high CPC)
3. `/jfif-to-jpg` (cheap clone of png-to-jpg)

## Future / not in this batch

- "compress image to [X] KB" cluster (file-size-target tool) — strong India
  volume, likely soft; check Semrush before building.
- Passport/visa photo cluster expansion (country-specific size pages) — 59%
  difficulty, medium-term play behind the government .gov results.
