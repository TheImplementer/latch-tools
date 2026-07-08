# Build plan: PDF privacy cluster (6 pages) + EXIF viewer

## Context

SEMrush (July 2026) validated a **6-page PDF privacy cluster** as the strongest next
batch, plus an EXIF viewer that funnels into our existing `remove-exif`. Every
incumbent in these SERPs (ilovepdf / smallpdf / Adobe / DocuSign / pdfFiller)
**uploads the user's file** — so our client-side, never-uploaded invariant is a real
differentiator on every one. `sign-pdf` is the volume anchor (14.8K US, $2.15 CPC).

Rows below are in **build order** (not opportunity order — see the build-order section
for the rationale):

| #   | Tool                           | US vol    | Global | Difficulty       | CPC       | SERP softness / notes                                                                                                                                          |
| --- | ------------------------------ | --------- | ------ | ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `redact-pdf`                   | 3.6K      | 15K    | 46% Possible     | **$2.27** | Reddit #3, Nitro #9 on 4 backlinks, pdfFiller 8 ref domains, pdf24 12. Highest CPC.                                                                            |
| 2   | `flatten-pdf`                  | 5.4K      | 30.9K  | 42% Possible     | $0.79     | **No ref-domain wall anywhere** — smallpdf #1 on 26 RD; .nih/.edu/.uscourts pages + drawboard (2 RD) rank. Softest SERP of the round.                          |
| 3   | `sign-pdf`                     | **14.8K** | 110.5K | 43% Possible     | **$2.15** | Top 3 strong (Adobe 1K RD), but **6 of 10 slots soft**: luminpdf & pdfgear on **1 RD**, DocuSign 6, play.google/utmb.edu 3. Biggest prize.                     |
| 4   | `unlock-pdf` (remove password) | 6.6K      | 176.9K | 48% Possible     | $0.57     | Top 2 locked (ilovepdf/smallpdf 550 RD), but #3–10 soft: Adobe 10 RD, Reddit, techcommunity 0 AS, syncfusion 4 RD.                                             |
| 5   | `password-protect-pdf`         | 4.4K      | 25.1K  | 53% Difficult    | $0.51     | One page also wins `encrypt pdf` (880 US, $0.67) + `add password to pdf` (480) — **identical SERP**. Adobe 535 RD tops it; #5–10 are .gov/.edu/Canva on ~2 RD. |
| 6   | `remove-pdf-metadata`          | 390       | 3.8K   | **34% Possible** | **$2.23** | Extremely soft — pdf24 16 RD, Adobe 14, Reddit/pics.io/Apple on 1 RD each. Small volume, near-guaranteed rank. Quick-win.                                      |
| ∥   | `exif-viewer`                  | 2.4K      | 15.5K  | 65% Difficult    | $0.62     | The round's only **Commercial** intent. Absorbs `view exif data` (320) + `photo gps` (110, KD 31%). Slow compound; value is the funnel into `remove-exif`.     |

**Intent caveat:** SEMrush labels the PDF terms "Informational," but their top 10 are
tool pages — treat them as **transactional tool intent**. The Reddit / forum / YouTube
results that rank are exactly the SERP soft spots _and_ a reminder to ship genuine
supporting content (required by `CLAUDE.md` — no thin pages).

**Deprioritized / skipped:**

- `remove background from image` (49.5K US) and `remove image background` (9.9K US) —
  both **KD 100% Very Hard**: remove.bg alone has 17K ref domains / 490K backlinks.
  Unwinnable for a young site regardless of the "runs locally" angle. Skip as an SEO
  play (build only for product differentiation, chasing ultra-long-tails).
- `watermark photo` (KD 63%) / `watermark image` (KD 69%) — entrenched, India-skewed,
  low CPC. If we ever watermark, do `watermark pdf` (KD 38%, CPC $1.48) later.

---

## Shared technical approach

Privacy invariant unchanged: **all processing client-side, no bytes leave the
device.** Build the plumbing once; then most pages are cheap. Two technical families:

- **Raster family** (`pdf.js` render → canvas → rebuild flat PDF with `pdf-lib`):
  `redact-pdf` and `flatten-pdf` share this exact pipeline. Build it once in #1, reuse
  in #2.
- **Structure family** (`pdf-lib` / `qpdf-wasm` operating on the PDF object model,
  keeping text/vectors crisp): `sign-pdf` (stamp a signature image), `unlock-pdf` /
  `password-protect-pdf` (qpdf-wasm decrypt/encrypt), `remove-pdf-metadata` (clear the
  info dict + XMP).

- **`pdf.js`** (`pdfjs-dist`) — render/rasterise pages to canvas (raster family + any
  future pdf-to-jpg).
- **`pdf-lib`** — pure-JS page/object ops (already the planned `heic-to-pdf` dep; the
  cluster shares it). Assembles output PDFs, stamps images, flattens form fields,
  edits metadata.
- **`qpdf-wasm`** (or `pdf-lib` encryption where sufficient) — encrypt/decrypt for #4/#5.
- **Lazy-load everything** per `CLAUDE.md`: import the codec/lib only on first drop-zone
  interaction, never on page load (Core Web Vitals).
- Reuse the existing tool-page scaffolding: drop zone, filename+size preview, explicit
  action button, progress indicator > ~300ms, one-click download, "convert another"
  reset, graceful error states.

---

## Tool 1 — `redact-pdf` (beachhead, build first)

**Why first:** highest CPC ($2.27), reuses the most existing code (`redact.ts`), extends
the shipped redaction cluster, and **establishes the pdf.js raster pipeline** that #2
reuses for free.

### Technical

- Render each page with `pdf.js` to a canvas at a sensible DPI (e.g. 2× for crispness).
- **Reuse `src/lib/redact.ts`** — the same drag-rectangle → blackout engine already
  powering `redact-image`. The user draws bars over each page's raster.
- Export: composite the bars into the raster, then rebuild a **flat raster PDF** with
  `pdf-lib` (one image per page). Flattening to raster is the point — it destroys the
  text layer, which is what makes PDF redaction actually safe.
- Multi-page nav (prev/next, page thumbnails) is the main new UI vs `redact-image`.

### SEO (unique per `CLAUDE.md`: `SoftwareApplication` + `HowTo` + `FAQPage`)

- **Title:** `Redact PDF — Black Out Text Safely, Free · Latch Tools` (≤60 chars)
- **H1:** `Redact a PDF`
- **Angle:** black out names, numbers, clauses **in your browser** — bars flattened into
  the pixels, so unlike a box drawn in a PDF editor there's no text hiding underneath.
- **Headline FAQ:** _"Can redacted PDF text be recovered?"_ — extend the redact-image
  safety story (the classic black-box-over-live-text failure). Also: uploaded anywhere?
  (no) · multi-page? · scanned vs digital PDFs.
- **Related:** `/redact-image/`, `/flatten-pdf/`, `/remove-exif/`, `/unlock-pdf/`.

---

## Tool 2 — `flatten-pdf` (nearly free — reuses #1's raster pipeline)

**Why second:** 5.4K US, KD 42%, and the **softest SERP of the round** (nothing above
32 ref domains). Its thorough mode is _exactly_ redact-pdf's export path minus the
drawing UI, so it's roughly a half-day add once #1 exists.

### Technical

- **Two modes, offer the thorough one by default:**
  - **Rasterise (thorough):** render every page → rebuild a flat raster PDF (reuse #1's
    pipeline verbatim). Flattens layers, annotations, form fields, and any hidden
    content — the universal "make it uneditable / merged" that matches search intent
    and reinforces redaction/signature safety.
  - **Form-flatten (crisp, optional):** `pdf-lib` `form.flatten()` bakes AcroForm field
    values into the page while keeping text vector-sharp — lighter, for the "flatten my
    filled form so it can't be changed" use case.
- No drawing UI; drop → (choose mode) → flatten → download.

### SEO

- **Title:** `Flatten PDF — Lock Form Fields & Layers Free · Latch Tools` (≤60)
- **H1:** `Flatten a PDF`
- **Angle:** merge layers and lock form fields so the file can't be edited — and so
  redactions/signatures can't be undone. In your browser, never uploaded.
- **FAQ:** what does flattening do? · will my form data stay filled? (yes — baked in) ·
  raster vs form-flatten · uploaded anywhere? (no).
- **Related:** `/redact-pdf/`, `/sign-pdf/`, `/remove-pdf-metadata/`.

---

## Tool 3 — `sign-pdf` (biggest prize — the volume anchor)

**Why here:** 14.8K US (4× redact-pdf), CPC $2.15, KD 43%, soft page-1 back-half. It
needs new signature-placement UI, so it follows once the PDF plumbing is proven.

### Technical

- Render the page with `pdf.js`; let the user create a signature (draw on a canvas /
  type in a script font / upload a PNG), then **drag, place, and resize** it on the page
  — this reuses the region-placement interaction model from `redact.ts`.
- Stamp with `pdf-lib` (`page.drawImage`) so the **text/vectors stay crisp** (structure
  family — do NOT rasterise the whole page). Support multiple signatures + typed
  date/text fields. Export via `pdf-lib`.

### ⚠️ Honest-copy caveat

Frame as **visual "fill & sign"** (a drawn/typed signature stamped on the page) — NOT
certificate-based digital signatures (PKI). That matches what ilovepdf/smallpdf/Adobe's
free tools do; just don't imply legal e-signature cert validity. Privacy wedge is
strong: **"sign a contract without uploading it to DocuSign/Adobe."**

### SEO

- **Title:** `Sign PDF — Fill & Sign in Your Browser · Latch Tools` (≤60)
- **H1:** `Sign a PDF`
- **Secondary keywords:** fill and sign pdf, add signature to pdf, esign pdf.
- **FAQ:** is my document uploaded? (no — the wedge) · is this a legal e-signature?
  (visual fill-and-sign; note the distinction) · can I type or draw? · multiple
  signatures? · lock it afterwards (→ link `/flatten-pdf/`).
- **Related:** `/flatten-pdf/`, `/password-protect-pdf/`, `/redact-pdf/`.

---

## Tool 4 — `unlock-pdf` (remove password)

### Technical

- User drops a locked PDF and **enters the password they already have**; `qpdf-wasm`
  decrypts client-side and re-exports an unrestricted copy. Owner-password / permission
  locks (print/copy disabled) can often be stripped without a password.
- Simple UI — no canvas. Drop → password field → unlock → download.

### ⚠️ Framing (brand + abuse)

Position strictly as **"unlock a PDF you have the password for / remove owner
restrictions,"** never password _cracking_. Client-side is a trust win: _"we never see
your password or your file — nothing is uploaded."_ Direct wedge against ilovepdf/
smallpdf, which upload your confidential locked doc.

### SEO

- **Title:** `Unlock PDF — Remove PDF Password, Free · Latch Tools`
- **H1:** `Remove a password from a PDF`
- **Secondary keywords:** unlock pdf, remove pdf password, decrypt pdf.
- **FAQ:** Do I need the password? (yes for encrypted; owner locks may not) · uploaded?
  (no) · legal? (only unlock PDFs you're authorised to).
- **Related:** `/password-protect-pdf/`, `/redact-pdf/`, `/remove-exif/`.

---

## Tool 5 — `password-protect-pdf` (one page, three keywords)

### Technical

- Reuse the `qpdf-wasm` (or `pdf-lib` encryption) plumbing from #4, inverted: drop a PDF
  → set a password → export an encrypted copy. Optionally expose permission flags.

### SEO

- **Title:** `Password Protect PDF — Encrypt PDF Free · Latch Tools`
- **H1:** `Password protect a PDF`
- **Target `password protect pdf` + `encrypt pdf` + `add password to pdf` on this one
  page** — same SERP. Work all three phrasings into H2s / FAQ.
- **FAQ:** encryption strength (AES-256) · uploaded? (no) · how to remove it again (→
  `/unlock-pdf/`) · opens everywhere? (yes — standard PDF encryption).
- **Related:** `/unlock-pdf/`, `/redact-pdf/`.

---

## Tool 6 — `remove-pdf-metadata` (quick-win)

**Why:** only 390 US, but KD 34%, CPC $2.23, and a SERP where Reddit/Apple/pics.io rank
on a single ref domain. Trivial to build and it's the glue between the metadata cluster
(`remove-exif`) and the PDF cluster.

### Technical

- `pdf-lib`: load → clear the document info dictionary (title/author/subject/keywords/
  producer/creator) and **strip the XMP metadata stream** → re-save. No rendering, no
  crypto.

### SEO

- **Title:** `Remove PDF Metadata — Strip Author & Info · Latch Tools` (trim to ≤60)
- **H1:** `Remove metadata from a PDF`
- **Secondary keywords:** remove pdf metadata, pdf metadata remover, remove author from pdf.
- **FAQ:** what metadata does a PDF carry? · uploaded? (no) · does it change the visible
  content? (no — only hidden properties).
- **Related:** `/remove-exif/`, `/flatten-pdf/`, `/redact-pdf/`.

---

## Tool ∥ — `exif-viewer` (parallel non-PDF build, funnels to remove-exif)

### Technical

- No PDF dep — build any time. Parse EXIF/IPTC/XMP client-side (`exifr`, lazy-imported)
  and render a readable table: camera, timestamp, **GPS map link**, software, etc. Show
  a prominent "these details are embedded in your file" message with a one-click
  hand-off to **`/remove-exif/`**.

### SEO

- **Title:** `EXIF Viewer — See Photo Metadata & GPS · Latch Tools`
- **H1:** `View a photo's EXIF data`
- **Absorb** `view exif data` (320) + `photo gps` (110, KD 31%) + "photo metadata
  viewer" on one page (pics.io ranks across all of these from one URL — precedent).
- **Angle:** see exactly what a photo reveals — location, device, timestamp — _then
  remove it before you share._ View → strip is the two-step privacy funnel.
- **Related (hard cross-link):** `/remove-exif/`, `/blur-image/`.
- Note KD 65% + entrenched incumbents (jimpl, exif.tools, exiftool): slow compound, not
  a quick win. Near-term value is the funnel into `remove-exif`, which we already rank for.

---

## Site-wide wiring (each tool)

1. `src/pages/index.astro` — add a `.tool-card` (chips e.g. `pdf` / `privacy`), grouped
   near the redaction + `remove-exif` privacy tools; bump the grid count.
2. `src/components/Footer.astro` — add to the Tools column.
3. Reciprocal contextual links: every new page links to its siblings and to the existing
   redaction cluster / `remove-exif`; add return links from those pages (same muted
   inline-link pattern used across the redaction cluster).
4. Sitemap + per-URL `lastmod` are automatic (`@astrojs/sitemap` + git-date serialize).
5. OG images: run `scripts/gen-og.mjs` after each page lands (it reads the H1).

---

## Build order

1. **`redact-pdf`** — establishes `pdf.js` rasterisation, reuses `redact.ts`, best CPC,
   tightest cluster fit. Risk-adjusted beachhead.
2. **`flatten-pdf`** — reuses #1's raster pipeline (nearly free); 5.4K US, softest SERP.
3. **`sign-pdf`** — biggest prize (14.8K US, $2.15 CPC); needs new signature UI, so it
   follows the proven plumbing.
4. **`unlock-pdf`** — 6.6K US; introduces `qpdf-wasm`.
5. **`password-protect-pdf`** — reuses qpdf-wasm from #4; one page, three keywords.
6. **`remove-pdf-metadata`** — cheap quick-win; slot in anytime after `pdf-lib` lands.
7. **`exif-viewer`** — independent of the PDF stack; build in parallel whenever there's
   a gap.

**Sequencing logic:** #1–2 are the raster family (build the pipeline, then harvest it
twice). #3 is the highest-value structure-family tool but carries the most new UI. #4–5
share qpdf-wasm. #6 is a trivial pickup. If optimising purely for fastest traffic, #3
could jump ahead of #1 (it has 4× the US volume) — but leading with redact-pdf reuses
the most existing code, monetises 6×, and de-risks the pipeline the others depend on.

---

## Verification (per tool)

1. `npx astro check` — 0 errors; `npm run build` clean; `dist/<slug>/` exists.
2. `npm run preview`, full round-trip:
   - **redact-pdf** — exported pages are flat rasters with **no selectable text under
     the bars**.
   - **flatten-pdf** — output has no editable form fields (raster mode) / baked-in field
     values (form-flatten mode); opens in a standard viewer.
   - **sign-pdf** — signature is stamped at the right position/scale, the rest of the
     document's text stays **selectable/crisp** (not rasterised), file opens everywhere.
   - **unlock/protect** — output opens with the expected password state.
   - **remove-pdf-metadata** — document properties (in a viewer / `exiftool`) show the
     info dict + XMP cleared; visible content unchanged.
3. **Privacy check:** confirm nothing hits the network during processing (DevTools
   Network tab empty for file bytes) — the core invariant.
4. Real-browser functional test (Puppeteer/Playwright against preview), as with the AVIF
   and redaction batches.
5. Post-launch: submit each new URL in Google Search Console (URL Inspection → Request
   Indexing) and confirm it's in `sitemap-0.xml`.

---

## Future / not in this batch

- `watermark-pdf` — cheap once the PDF plumbing exists (KD 38%, CPC $1.48).
- The rest of the volume PDF cluster: `merge-pdf`, `split-pdf`, `compress-pdf`,
  `pdf-to-jpg` (see `tool-roadmap` memory — big volume, harder SERPs).
- `remove-background-from-image` — tool is buildable client-side (ML/WASM) but the head
  term is KD 100%; only revisit for product value + ultra-long-tails.
- Auto-detection for redact-pdf (on-device OCR/PII highlight) — keep client-side.
