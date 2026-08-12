# Latch Tools

**Private file tools that run entirely in your browser.** Convert, resize, and redact images without uploading them anywhere — every byte is processed on your own device.

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

**Face detection runs on your device too.** Most tools that offer automatic face blurring upload your photo to a server to find the faces. This one downloads a small open-source model ([YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT) into your browser instead and runs it locally, so the image still never moves. The ONNX runtime's WebAssembly binary is self-hosted for the same reason — it is served from this origin, never a CDN.

**No analytics, no third-party scripts.** The site loads no analytics, no tracking beacon, and no third-party scripts of any kind — the only code that runs is the tool's own. Beyond the standard server logs any web host generates, nothing about your visit is recorded.

## Tools

**Convert** — HEIC→JPG/PNG · PNG↔JPG · WebP↔JPG/PNG/AVIF · AVIF→JPG/PNG/WebP · PNG/JPG→AVIF · JPEG&nbsp;XL (JXL↔PNG/JPG, PNG/JPG→JXL) · SVG→PNG/JPG · JFIF→JPG/PNG

**Redact & protect** — remove EXIF metadata · blur faces (with on-device auto-detection) · blur license plates · pixelate regions · black-box redaction

**Utilities** — resize images · image↔Base64

## How it works

- **No backend touches files.** There is no upload endpoint, no proxy, no file-handling server. The site is fully static.
- **Image codecs are WebAssembly**, run in the browser: AVIF and JPEG&nbsp;XL via [jSquash](https://github.com/jamsinclair/jSquash), HEIC via [heic2any](https://github.com/alexcorvi/heic2any), EXIF parsing via [exifr](https://github.com/MikeKovarik/exifr).
- **Redaction is irreversible.** Blur/pixelate/black-box effects are re-rendered at the image's full resolution on export and baked into the pixels — there is no overlay to peel back. See [`src/lib/redact.ts`](src/lib/redact.ts).
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
npm run dev        # dev server at localhost:4321
npm run build      # build static site to ./dist
npm run preview    # preview the production build
npx astro check    # TypeScript + Astro type-check
npm run lint       # ESLint
```

## Project layout

```
src/
  pages/        one .astro file per tool (e.g. heic-to-jpg.astro)
  layouts/      shared page shell
  components/   header, footer, redaction widget, etc.
  lib/
    redact.ts   the shared blur / pixelate / black-box engine
  styles/       global tokens + theme
scripts/        build-time OG image + sitemap generation
```

Each tool page is self-contained: drop zone, client-side processing, and one-click download, following a consistent structure across the site.

## License

[MIT](LICENSE) © 2026 Latch Tools
