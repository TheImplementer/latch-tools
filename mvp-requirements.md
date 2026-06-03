# Privacy-First File Tools — MVP Requirements

## 1. Product summary

A collection of browser-based file utilities that run entirely client-side. Files are never uploaded to a server; all processing happens in the user's browser using JavaScript/WebAssembly. The core promise is **"Your files never leave your device."**

This is both a genuine privacy differentiator and a cost advantage: with no file processing on the backend, hosting is effectively free at any reasonable scale.

## 2. Goals and non-goals

### Goals
- Ship a small, fast, genuinely useful cluster of file tools.
- Validate organic search traffic before investing in monetization.
- Keep server costs near zero by doing all processing client-side.
- Build a defensible position on privacy and speed, not on having "more tools than competitors."

### Non-goals (for MVP)
- User accounts, logins, or saved history.
- Server-side processing or file storage of any kind.
- Payments or a paid tier (this comes later, post-traffic).
- A mobile app. The web app must be excellent on mobile, but no native app.

## 3. Success criteria

The MVP is successful if, within roughly 3 months of launch:
- At least 3–4 tools are live, stable, and pass a basic Core Web Vitals check.
- The site is indexed and at least one tool page is ranking for a long-tail query.
- Average tool completion (file in → result downloaded) works on mobile Safari, Chrome, and Firefox without errors.

## 4. MVP tool scope

Launch with a tight set. Each tool gets its own dedicated, SEO-friendly page. Recommended launch set, in priority order:

1. **HEIC to JPG converter** — the strongest single search intent (iPhone pain point).
2. **PNG ↔ JPG converter** — extremely high-volume search intent; reuses the same single-pass canvas mechanism as the other converters.
3. **WebP to PNG converter** — common developer/designer need.
4. **Resize image for passport / visa / LinkedIn** — specific, high-value use cases.
5. **Remove EXIF / metadata from images** — clean privacy angle that reinforces the brand.

All five launch tools are single-pass operations sharing one drop-zone-and-canvas codebase. The "compress to a target size" tool is deliberately deferred: it needs an iterative encode-measure-adjust loop (binary search on quality, with a downscale fallback) and a Web Worker to stay responsive, making it the only tool in the set that doesn't fit the single-pass pattern. It's a strong fast-follow once there's traffic worth optimising for.

Hold these for fast-follow releases (not required for launch): compress image to a target size, AVIF to PNG, images to PDF, PDF metadata viewer, video-to-GIF under a target size, audio trim/normalize, local face blur.

## 5. Functional requirements

### 5.1 Per-tool behaviour
- All file reading, conversion, and output generation happen client-side. No file bytes are sent over the network.
- Drag-and-drop a file onto a drop zone, **or** click to open the native file picker.
- Show the selected file name and size before processing.
- Process on an explicit action (e.g. a "Convert" button) or automatically on drop — pick one pattern and keep it consistent across all tools.
- Display a clear progress or "working" state for operations that take more than ~300 ms.
- Provide a one-click **Download** of the result, with a sensible auto-generated filename (e.g. `photo.heic` → `photo.jpg`).
- Allow processing another file without a full page reload ("Convert another").
- Handle errors gracefully: unsupported file, corrupt file, file too large for browser memory. Show a plain-language message, never a raw stack trace.

### 5.2 Batch (nice-to-have for MVP, required soon after)
- Allow multiple files at once where it makes sense (e.g. converting a batch of images), with per-file status and a "Download all (zip)" option.

### 5.3 Tool-specific notes
- **HEIC to JPG:** allow a quality slider (default ~0.85). Support `.heic` and `.heif`.
- **PNG ↔ JPG:** single-pass `canvas.toBlob` conversion in both directions. Going to JPG, let the user set quality and pick a background colour to flatten transparency onto (since JPG has no alpha). Going to PNG, preserve full quality (lossless).
- **WebP to PNG / AVIF to PNG:** straightforward decode-and-re-encode; preserve transparency.
- **Resize for passport/visa/LinkedIn:** offer named presets (UK passport, US passport, Schengen visa, LinkedIn profile, etc.) with the correct pixel/aspect requirements, plus a custom dimensions option. Document the source of each spec on the page.
- **Remove EXIF:** strip all metadata, output a clean copy, and optionally show the user what metadata was found before removal (reinforces the privacy value).

## 6. Non-functional requirements

### 6.1 Privacy (the core promise)
- No file ever leaves the device. State this prominently on every tool page.
- No third-party scripts that could touch file contents.
- A short, honest privacy policy explaining that files are processed locally and that the only data collected is standard analytics (and, later, ad-related data).
- If/when ads and analytics are added, disclose them clearly and provide a compliant cookie/consent banner (UK/EU — important given your location).

### 6.2 Performance
- Each tool page should be usable quickly. Lazy-load the heavy conversion libraries (e.g. the WASM codec) only when a file is selected or the tool is interacted with, not on initial page load.
- Target good Core Web Vitals (LCP, CLS, INP) — this directly affects SEO ranking.
- Keep the initial HTML/CSS payload small so pages render instantly even before JS loads.

### 6.3 Compatibility
- Work on current Chrome, Firefox, Safari, and Edge, on both desktop and mobile.
- Degrade gracefully where a browser lacks a needed API (show a clear message rather than failing silently).

### 6.4 Accessibility
- Keyboard-operable drop zones and buttons.
- Proper labels, focus states, and sufficient colour contrast.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

### 6.5 SEO (critical for this business model)
- Each tool is a separate static page with a clear, keyword-aligned URL (e.g. `/heic-to-jpg`).
- Unique title, meta description, and an H1 per page.
- Genuinely useful supporting content on each page: what the tool does, how to use it, a short FAQ, and why the privacy angle matters. This avoids the "thin content" problem search engines penalise.
- Structured data (FAQ / HowTo / SoftwareApplication schema) where appropriate.
- A sitemap, clean internal linking between related tools, and fast server response.

## 7. Technical approach (suggested, not prescriptive)

- **Architecture:** static site. No backend required for the MVP. A static-site generator or a lightweight framework that outputs static pages works well and keeps Core Web Vitals strong.
- **Processing libraries (client-side):**
  - HEIC/HEIF decoding via a WASM library.
  - Image encode/resize/compress via the Canvas API and/or a WASM image codec for quality control.
  - EXIF reading/stripping via a small client-side library.
  - Zipping for batch downloads via a client-side zip library.
- **Analytics:** a lightweight, privacy-respecting analytics tool fits the brand better than heavy trackers.
- **No file uploads, no database, no auth** for the MVP.

## 8. Page / site structure

- Home page: states the privacy promise, lists the tools, links to each.
- One page per tool (the SEO landing pages).
- Privacy policy page.
- About page (builds trust — who's behind it, why local processing).
- Optional: a simple blog/notes section for supporting content and additional search surface.

## 9. Monetization (deferred, documented for context)

Do **not** add ads until traffic exists. Planned sequence:
1. AdSense for early testing once traffic qualifies.
2. A premium ad network once volume justifies it.
3. A future "Pro" tier: no ads, larger files, batch presets — only if usage supports it.

Ads must respect AdSense policy: real user interest only, no encouraging clicks, compliant consent for UK/EU visitors.

## 10. Out-of-scope risks to track
- Browser memory limits on very large files (especially video) — set sensible size guidance.
- Codec/library licensing — verify the licence of any WASM codec used.
- Passport/visa spec accuracy — cite official sources and add a "verify before submitting" note to avoid giving the impression of an official service.
