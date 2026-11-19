# Latch Tools

**Private file tools that run entirely in your browser.** Convert, resize, and redact images and PDFs without uploading them anywhere — every byte is processed on your own device.

Live at **[latchtools.com](https://latchtools.com)**.

Most "free" online file tools upload your files to a server you can't see. Latch doesn't have a server that touches your files, because it doesn't need one — all the work happens client-side in JavaScript and WebAssembly. Close your network connection after the page loads and everything still works.

## Don't take our word for it — verify it

The whole promise is _"your files never leave your device."_ You can check that claim against the source in about ten seconds. There are no upload primitives anywhere in the app:

```bash
# Every exfiltration primitive — all return nothing:
grep -rn "XMLHttpRequest" src/
grep -rn "FormData"       src/
grep -rn "sendBeacon"     src/
grep -rn "WebSocket"      src/

# One hit, in src/lib/detect.ts — see below:
grep -rn "fetch("         src/
```

That single `fetch(` is a **GET for a static file on this site's own origin**: the face-detection model weights in [`public/models/`](public/models/). It has no request body, and it downloads rather than uploads. Everything a `fetch` would need in order to leak an image — a body, a form, a remote host — is absent, which is what the other four greps demonstrate.

The only external URLs referenced in the codebase are `schema.org` and `w3.org` (XML/JSON-LD namespace identifiers — not network requests), the site's own canonical URLs, and documentation links in comments and page copy.

**The bundled libraries, in fairness.** Greps over `src/` cover the code this project wrote, so it's worth being straight about the one dependency that does have a network layer of its own. The PDF tools use Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), which can load a document either from a URL or from bytes you hand it. We always hand it bytes we already hold ([`src/lib/pdf.ts`](src/lib/pdf.ts)), so that path is never used. What it does fetch is its own static assets — the worker, the JBIG2/JPEG 2000/colour decoders, character maps and font data — and all of them are served from this origin out of [`public/pdfjs/`](public/pdfjs/), never a CDN, for the same reason the ONNX runtime binary is. A Playwright test asserts that a full redaction round-trip makes **no off-origin request of any kind**; `npm test` runs it in both Chromium and WebKit.

**Face detection runs on your device too.** Most tools that offer automatic face blurring upload your photo to a server to find the faces. This one downloads a small open-source model ([YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT) into your browser instead and runs it locally, so the image still never moves. The ONNX runtime's WebAssembly binary is self-hosted for the same reason — it is served from this origin, never a CDN.

**One third-party script: Cloudflare Web Analytics.** latchtools.com runs Cloudflare's cookieless Web Analytics, which Cloudflare adds to pages at the edge (it isn't in this repo, so local builds and the tests don't load it). When you leave a page, it sends one report with the page address, referrer, browser and OS version, load timings and a random per-load ID. Nothing about files, because no tool puts anything in the URL. It sets no cookies and stores nothing in the browser. The [privacy policy](https://latchtools.com/privacy-policy/) lists the exact fields. Apart from that script, everything the site loads, from fonts to codecs, is served from its own origin.

## Tools

**Convert** — HEIC→JPG/PNG · PNG↔JPG · WebP↔JPG/PNG/AVIF · AVIF→JPG/PNG/WebP · PNG/JPG→AVIF · JPEG&nbsp;XL (JXL↔PNG/JPG, PNG/JPG→JXL) · SVG→PNG/JPG · JFIF→JPG/PNG

**Redact & protect** — remove EXIF metadata · blur faces (with on-device auto-detection) · blur license plates · pixelate regions · black-box redaction · [redact PDFs](https://latchtools.com/redact-pdf/)

**Utilities** — resize images · image↔Base64

## How it works

- **No backend touches files.** There is no upload endpoint, no proxy, no file-handling server. The site is fully static.
- **Image codecs are WebAssembly**, run in the browser: AVIF and JPEG&nbsp;XL via [jSquash](https://github.com/jamsinclair/jSquash), HEIC via [heic2any](https://github.com/alexcorvi/heic2any), EXIF parsing via [exifr](https://github.com/MikeKovarik/exifr).
- **Redaction is irreversible.** Blur/pixelate/black-box effects are re-rendered at the image's full resolution on export and baked into the pixels — there is no overlay to peel back. See [`src/lib/regions.ts`](src/lib/regions.ts) for the effects and [`src/lib/redact.ts`](src/lib/redact.ts) for the image tools.
- **PDF redaction destroys the text layer**, rather than covering it. A black rectangle drawn in a PDF editor leaves the words underneath in the file, where copy-paste and text extractors still find them. Here each page is rendered to a canvas, the bars are composited into those pixels, and the PDF is rebuilt from the rasters with [pdf-lib](https://github.com/Hopding/pdf-lib) — so there is no text layer left to recover. See [`src/lib/pdfRedact.ts`](src/lib/pdfRedact.ts).
- **Face detection is local**, via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) with self-hosted WebAssembly and the MIT-licensed YuNet model. Detected boxes are only ever _proposals_ — you review, adjust and delete them, and nothing is exported until you press the button. See [`src/lib/detect.ts`](src/lib/detect.ts) and [`public/models/NOTICE.md`](public/models/NOTICE.md).
- **Heavy libraries are lazy-loaded** only when you first drop a file, so pages stay fast. Nothing is downloaded until you actually use a tool.
- **ZIP packaging** for batch downloads happens in-browser via [JSZip](https://github.com/Stuk/jszip).

## Tech stack

- **[Astro](https://astro.build)** — static site output, zero client JS except each tool's own logic
- **TypeScript**
- **[Cloudflare Pages](https://pages.cloudflare.com)** — static hosting

## Development

```bash
npm install
npx playwright install chromium webkit   # once, for the tests

npm run dev        # dev server at localhost:4321
npm run build      # build static site to ./dist
npm run preview    # preview the production build
npm test           # Playwright, Chromium + WebKit
npx astro check    # TypeScript + Astro type-check
npm run lint       # ESLint
```

`npm test` builds the site and drives it in two engines. The headline case proves
the product claim rather than the UI: it generates a PDF containing a known
string, checks the string really is extractable from that input, redacts it, and
then asserts the string is absent from the exported file, that no page has any
text left at all, and that the bar is genuinely black where it was drawn.

## Project layout

```
src/
  pages/        one .astro file per tool (e.g. heic-to-jpg.astro)
  layouts/      shared page shell
  components/   header, footer, redaction widget, etc.
  lib/
    regions.ts  drag-a-box editing + the blur / pixelate / black-box effects
    redact.ts   the image tools' file queue and export
    pdfRedact.ts  the PDF tool: pages in, one flattened PDF out
    pdf.ts      pdf.js setup, with every asset served from this origin
  styles/       global tokens + theme
scripts/        build-time OG image generation, pdf.js asset sync
tests/          Playwright specs + fixture generators
```

Each tool page is self-contained: drop zone, client-side processing, and one-click download, following a consistent structure across the site.

## License

[MIT](LICENSE) © 2026 Latch Tools
