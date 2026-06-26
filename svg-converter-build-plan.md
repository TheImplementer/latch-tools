# Build plan: SVG conversion tools

## Context

Keyword research (Semrush, June 2026) confirms the SVG-rasterisation cluster as a
soft-SERP, on-pattern next batch. Both keywords clear our filter — and `svg to jpg`
is the standout: KD 36% "Possible" (our easiest tier, matching the AVIF wins), a
top-3 that ranks on **2–23 referring domains**, **commercial** intent, and a
**$1.49 CPC** (the highest we've scouted). `svg to png` has ~6× the volume but a
harder SERP (an entrenched exact-match #1). Both pages share one rasterise helper,
so the build cost is the same — svg-to-jpg justifies the batch on its own, with
svg-to-png as higher-volume upside.

| Tool          | US vol | Global | Difficulty    | Intent                   | CPC   | SERP softness                                                                                                                             |
| ------------- | ------ | ------ | ------------- | ------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/svg-to-jpg` | 5.4K   | 50.6K  | 36% Possible  | Informational+Commercial | $1.49 | Genuinely soft top-to-bottom: #1 cloudconvert = **23** ref domains, #2 = 8, #3 = 2; #4/#5 are a forum + Canva @1 ref. Top-3 is realistic. |
| `/svg-to-png` | 33.1K  | 275.9K | 56% Difficult | Informational            | $0.40 | #1 = 536 ref domains (exact-match), but #4–#7/#10 hold at 9–87; #3/#8/#9 are UGC/forum/store. Aim for positions 4–8.                      |

Geo skews US/DE/FR (healthier than our India-heavy keywords), and the audience is
developers/designers — low ad-RPM per visit, but highly **linkable** (note GitHub
ranks page 1), which compounds domain authority. A single converter page in this
SERP pulls 500+ long-tail keywords (svgtopng.com = 512, Canva = 555), so one good
page captures a wide variant set.

---

## Shared technical approach

Same client-side promise as every tool — **no file bytes leave the device**;
JSZip lazy-loaded only for multi-file downloads. But SVG rasterisation differs
from our raster→raster converters in three important ways:

### 1. Decode via `<img>` + object URL, NOT `createImageBitmap`

`createImageBitmap(svgFile)` is unreliable across browsers (Firefox/Safari quirks,
and it fails when the SVG has no intrinsic width/height). The robust, universally-
supported path is an `<img>` element:

```ts
const url = URL.createObjectURL(file);
const img = new Image();
img.onload = () => {
  /* draw to canvas, then */ URL.revokeObjectURL(url);
};
img.onerror = () => {
  /* show plain-language error */ URL.revokeObjectURL(url);
};
img.src = url;
```

Then `ctx.drawImage(img, 0, 0, outW, outH)` → `canvas.toBlob(...)`. This path is
also a **security sandbox**: a browser renders SVGs loaded via `<img>` with
scripts and external resource loading disabled, so a malicious SVG can't run JS or
phone home. (Never inject uploaded SVG via `innerHTML` — that would execute it.)

### 2. Output size control (the new UX vs our one-click converters)

SVGs are vector, so we must choose an output resolution. SVGs frequently omit
`width`/`height` (only a `viewBox`), in which case `img.naturalWidth/Height` is
unreliable. Approach:

- Parse the SVG text once for `width`/`height` attributes, falling back to the
  `viewBox` (3rd/4th numbers) to get intrinsic size + aspect ratio. Fallback to
  `512×512` if nothing is parseable.
- Show an **Output size** control in the selected state: a scale preset
  (`1×` / `2×` / `4×`) plus an optional custom width field (height auto from aspect
  ratio). Default to intrinsic size, or `1024px` wide when unknown.
- Live preview is a nice-to-have — reuse the preview infrastructure already in
  **`src/pages/resize-image.astro`** so users can see the rasterised result before
  downloading.

### 3. Output format / quality per tool

- `/svg-to-png` — PNG output, **lossless, no quality slider**, transparency
  preserved (SVG canvas is transparent by default). Clone
  **`src/pages/avif-to-png.astro`** for structure, swap the decode for the `<img>`
  path above, and add the size control.
- `/svg-to-jpg` — JPG output, **quality slider (default 92%)** + transparent-area
  **background-fill** colour picker (JPG has no alpha). Clone
  **`src/pages/avif-to-jpg.astro`** (it already has quality + bg-fill), swap the
  decode, add the size control.

Both pages share the SVG-rasterise-with-size-control logic — factor it into one
inline helper rather than duplicating.

### Input validation (`accept` + addFiles filter)

- `accept=".svg,image/svg+xml"`; valid if ext `svg` or type `image/svg+xml`.
- Error copy for a non-SVG: `Please drop an <code>.svg</code> file.`
- Decode-failure copy (malformed SVG): plain-language, e.g. _"We couldn't render
  that SVG — it may be malformed or missing a width/height or viewBox."_

### Output filename + zip name

- `/svg-to-png`: `name.replace(/\.svg$/i, '.png')`, zip `svg-to-png.zip`
- `/svg-to-jpg`: `name.replace(/\.svg$/i, '.jpg')`, zip `svg-to-jpg.zip`

---

## Per-page content (SEO — required by CLAUDE.md)

Each page needs unique `<title>`, `<meta description>`, `<h1>`, JSON-LD
(`SoftwareApplication` + `HowTo` + `FAQPage`), a How-to, supporting content, an
FAQ (`<details>`), and a Related-tools grid. Follow the structure of
`src/pages/avif-to-png.astro` / `avif-to-jpg.astro` (copy the bottom `<style>`
block verbatim).

### `/svg-to-png`

- **Title:** `Convert SVG to PNG — Free, Private, No Upload | Latch`
- **H1:** `SVG to PNG converter`
- **fmt-pill:** SVG → PNG
- **Angle:** rasterise scalable vector graphics to a fixed-resolution PNG with
  transparency preserved — at any size you choose. FAQ: what is SVG, why convert to
  PNG, what resolution should I pick, is transparency kept, is it uploaded, batch.
- **Related:** `/svg-to-jpg`, `/png-to-jpg`, `/webp-to-png`.

### `/svg-to-jpg`

- **Title:** `Convert SVG to JPG — Free, Private, No Upload | Latch`
- **H1:** `SVG to JPG converter`
- **fmt-pill:** SVG → JPG
- **Angle:** flatten an SVG to a shareable JPG at a chosen size; pick a background
  colour for the (otherwise transparent) canvas. FAQ: SVG→JPG vs PNG (transparency
  trade-off — cross-link to svg-to-png), quality setting, resolution, background
  colour, batch.
- **Related:** `/svg-to-png`, `/png-to-jpg`, `/avif-to-jpg`.

---

## Site-wide wiring (per new page)

1. **`src/pages/index.astro`** — add a `.tool-card` for each (chips `.svg → .png`,
   `.svg → .jpg`); bump the grid sub-heading count ("Nine focused image tools" → the
   new total).
2. **`src/components/Footer.astro`** — add "SVG to PNG" and "SVG to JPG" to the Tools
   column.
3. **Related-tools** — cross-link the two new pages to each other; sitemap is
   automatic via `@astrojs/sitemap`.

---

## Verification

1. `npx astro check` — 0 errors. `npm run build` — clean; confirm `dist/svg-to-png/`
   and `dist/svg-to-jpg/` exist.
2. `npm run preview`: for each page confirm rendering; **no** quality slider on
   svg-to-png, slider + bg-fill on svg-to-jpg; the size control changes output
   dimensions; FAQ expand/collapse; related links resolve; home card + footer link.
3. Functional (real-browser, e.g. Puppeteer against the preview server, as we did
   for the AVIF/JFIF batch): drop a real `.svg` — one with `width`/`height` and one
   with only a `viewBox` — and confirm:
   - correct output extension and that the PNG output has an alpha channel
     (transparency preserved), the JPG is flattened on the chosen background;
   - the chosen scale/size is honoured in the output pixel dimensions;
   - a malformed SVG hits the plain-language error state, not a crash.
4. View source: each page's JSON-LD has a `FAQPage` with its Q&As.

---

## Build order

Both keywords are validated; build the shared SVG-rasterise + size-control helper
once and ship both pages together.

1. `/svg-to-jpg` (the higher-confidence, higher-value win — KD 36% "Possible",
   commercial intent, $1.49 CPC, top-3 realistic). Establishes the shared helper.
2. `/svg-to-png` (near-free once the helper exists; ~6× the volume but a harder
   SERP — treat as upside, aim for positions 4–8).

## Future / not in this batch

- `/svg-to-pdf`, `/svg-to-webp` — same rasterise helper, check Semrush for demand.
- **Do not** build `png-to-svg` / `jpg-to-svg` — raster→vector tracing is a
  genuinely hard, lossy problem (potrace-class) and off-pattern for this batch.
