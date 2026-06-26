# Build plan: Blur Image tool

## Context

Keyword research (Semrush, June 2026) makes `blur image` the strongest next target
we've scouted — the **lowest difficulty and softest SERP** of the batch, plus the
best fit for our privacy brand.

| Tool          | US vol | Global | Difficulty    | Intent        | CPC   | SERP softness                                                                                                                                                                                              |
| ------------- | ------ | ------ | ------------- | ------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/blur-image` | 9.9K   | 86.3K  | 50% Difficult | Informational | $0.49 | No 100+ ref-domain wall anywhere. Ceiling is blurimageonline.com at 62; **three page-1 slots rank on a single ref domain** (techsmith #3, pi7 #9, photoaid #10), and #6/#7 hold at 16–19. Highly winnable. |

**Why it fits us better than a generic effect tool:** the high-value use case for
"blur image" is **privacy** — blur a face, licence plate, address, or sensitive
text before sharing. That's the same job as `remove-exif` ("clean a photo before
you post it"), so it slots into our privacy cluster and lets us out-position
Canva/Pixlr, who frame blur as a purely aesthetic filter. It also finally delivers
the **face-blur** tool listed as deferred in `CLAUDE.md` / `mvp-requirements.md`.

Geo is India-heavy (40.5K IN vs 9.9K US) and CPC is middling, so per-visit ad value
is modest — but winnability and brand fit carry it.

---

## Shared technical approach

This is an **interactive editor**, not our one-click "decode → encode → download"
pattern. The closest existing base is **`src/pages/resize-image.astro`**, which
already has live-preview + canvas-manipulation + preset-control infrastructure —
study and reuse it rather than cloning a plain converter. Privacy invariant is
unchanged: all processing is client-side; **no bytes leave the device**.

Ship in two phases so we get a ranking page live fast and add the premium privacy
feature second.

### Phase 1 (MVP) — whole-image blur

- Decode with `createImageBitmap(file)` (standard raster path; works for JPG / PNG /
  WebP / AVIF / GIF first frame).
- **Blur slider** (radius 0–50px, default ~8) drives a live preview canvas scaled to
  fit the widget; export applies the same blur at **full resolution**:
  ```ts
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(bitmap, 0, 0); // then canvas.toBlob(...)
  ```
- **Edge caveat:** canvas `blur()` samples transparent pixels beyond the image edge,
  producing a faded/dark rim on whole-image blur. Mitigate by pre-filling an opaque
  background (for JPG/opaque sources) or drawing the source slightly oversized and
  cropping back. Document and handle.
- **Output format:** preserve the source where sensible — JPG in → JPG out (offer a
  quality slider, reuse the png-to-jpg pattern), PNG in → PNG out, others → PNG.

### Phase 2 — selective / region blur (the privacy feature)

- Overlay a selection layer on the preview; let the user drag one or more
  rectangles (store regions in **image-space** coords, accounting for preview
  scale). A brush mode is a later enhancement.
- Export composites blurred pixels only inside the selected regions:
  ```ts
  base.drawImage(bitmap, 0, 0); // sharp base
  blur.filter = `blur(${r}px)`;
  blur.drawImage(bitmap, 0, 0);
  for (const { x, y, w, h } of regions)
    base.drawImage(blurCanvas, x, y, w, h, x, y, w, h);
  ```
- Add a **mode toggle: Blur ↔ Pixelate** (mosaic via downscale→upscale with
  `imageSmoothingEnabled = false`). Pixelate/solid is the safer choice for sensitive
  text and is a common redaction expectation.
- **Intensity** control per the chosen mode.

### Privacy accuracy (do not overclaim — this is a privacy tool)

- The exported file has the affected pixels **replaced** by blurred/pixelated
  pixels — genuinely irreversible, unlike a CSS/overlay "blur" that ships the
  original underneath. This is a real selling point and a true FAQ answer.
- But be honest: a **light** Gaussian blur over small text/digits can sometimes be
  partially reconstructed. For truly sensitive info, recommend a **strong blur or
  the pixelate/solid mode**. Say so in the copy — it builds trust and is correct.

### Input validation

- `accept="image/*"` (or an explicit list: jpg/jpeg, png, webp, avif, gif); validate
  the file is a raster image `createImageBitmap` can decode. Reject SVG/unsupported
  with plain-language copy. Reuse `MAX_SIZE_MB = 50`.

### Output filename + zip name

- Suffix the stem: `name.replace(/\.(\w+)$/i, '') + '-blurred.' + ext` (e.g.
  `photo.jpg → photo-blurred.jpg`). Phase 1 may be single-image; if batch is added,
  zip `blurred-images.zip`.

---

## Per-page content (SEO — required by CLAUDE.md)

Unique `<title>`, `<meta description>`, `<h1>`, JSON-LD (`SoftwareApplication` +
`HowTo` + `FAQPage`), How-to, supporting content, `<details>` FAQ, Related-tools
grid. Lead every section with the **privacy** angle.

- **Title:** `Blur Image — Free, Private, No Upload | Latch`
- **H1:** `Blur image online`
- **Angle:** blur or pixelate faces, licence plates, addresses, and sensitive
  details before you share — entirely in your browser, nothing uploaded.
- **FAQ:** How do I blur part of an image? · Is the blur permanent / can it be
  reversed? (irreversible on export; recommend strong blur/pixelate for sensitive
  text) · Are my images uploaded? (no) · What formats are supported? · Can I blur
  faces automatically? (manual regions for now; note as roadmap) · Batch?
- **Supporting content:** a short "Blur vs pixelate for redaction" explainer — the
  honest guidance above doubles as genuine, rankable content.
- **Related:** `/remove-exif` (strip metadata too — strong privacy cross-link),
  `/resize-image`, `/crop-image` (once built).

---

## Site-wide wiring

1. **`src/pages/index.astro`** — add a `.tool-card` (chip e.g. `blur` / `redact`);
   bump the grid sub-heading count to the new total. Place it near `remove-exif` to
   group the privacy tools.
2. **`src/components/Footer.astro`** — add "Blur image" to the Tools column.
3. Sitemap automatic via `@astrojs/sitemap`.

---

## Verification

1. `npx astro check` — 0 errors. `npm run build` — clean; `dist/blur-image/` exists.
2. `npm run preview`: slider updates the live preview; export downloads a file whose
   pixels are actually blurred (open it and confirm); JPG quality control works;
   FAQ expand/collapse; home card + footer link; `prefers-reduced-motion` respected.
3. Phase 2: draw a region over a face/plate, export, and verify in the saved file
   that **only** the selected region is blurred/pixelated and the rest is sharp; that
   region coordinates map correctly at full resolution (not just preview scale);
   pixelate mode produces blocks, not blur.
4. Privacy check: confirm the exported file's redacted pixels are destroyed (zoom in
   — no recoverable detail under strong blur/pixelate), validating the "irreversible"
   claim.
5. Real-browser functional test (Puppeteer against preview, as with the AVIF batch).

---

## Build order

1. **Phase 1** — whole-image blur slider + live preview + download. Ship this; it's
   enough to rank for `blur image` and start earning the SERP.
2. **Phase 2** — selective region blur + pixelate/redact mode. The privacy
   differentiator; follow once Phase 1 is live.

## Future / not in this batch

- **Auto face-detection** blur (on-device, e.g. a lightweight WASM/face model) — keep
  it client-side to preserve the invariant.
- The region-selection UI generalises to a small **editor cluster**: `/crop-image`,
  `/rotate-image`, `/flip-image`, `/circle-crop` — all reuse the same marquee/canvas
  scaffolding, so Phase 2 is the foundation for that next batch.
