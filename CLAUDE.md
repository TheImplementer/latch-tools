# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Privacy-first browser-based file utility tools. All file processing happens client-side in the user's browser — **no file bytes are ever sent to a server**. This is the core product promise and must never be violated.

## Stack

- **Framework:** Astro (static output)
- **Language:** TypeScript
- **Hosting:** Cloudflare Pages

## Commands

```bash
npm run dev          # start dev server (localhost:4321)
npm run build        # build to ./dist
npm run preview      # preview the production build locally
npx astro check      # TypeScript + Astro type-check
npm run lint         # ESLint (once configured)
wrangler pages deploy ./dist  # deploy to Cloudflare Pages
```

## First-time project setup

When scaffolding this project, configure ESLint with the Astro plugin:

```bash
npx astro add eslint
npm install --save-dev eslint-plugin-astro @typescript-eslint/eslint-plugin
```

Also install Prettier with the Astro plugin for the format-on-edit hook:

```bash
npm install --save-dev prettier prettier-plugin-astro
```

## Core invariants

- **Zero server-side file processing.** No file bytes go over the network. No backend, no file upload endpoints, no proxies that touch file content.
- **Lazy-load all heavy libraries.** WASM codecs, EXIF libraries, zip utilities — import these only when the user first interacts with the tool drop zone (not on page load). This keeps LCP fast and is required for Core Web Vitals targets.
- **No third-party scripts that can access file contents.** Analytics must not touch any file data.

## Per-tool page structure

Each tool lives at `src/pages/[tool-name].astro` (e.g. `src/pages/heic-to-jpg.astro`). Every tool page must:

1. Drop zone + file picker (drag-and-drop or click)
2. Show selected filename and size before processing
3. "Convert" button (explicit action — consistent across all tools)
4. Progress/working indicator for operations > ~300ms
5. One-click download with auto-generated filename (e.g. `photo.heic → photo.jpg`)
6. "Convert another" reset (no full page reload)
7. Graceful error state: unsupported format, corrupt file, file too large — plain-language message, never a raw error stack

Use `/add-tool` to scaffold new tool pages.

## SEO requirements

- Keyword-aligned URL slugs: `/heic-to-jpg`, `/png-to-jpg`, `/remove-exif`, etc.
- Unique `<title>`, `<meta name="description">`, and `<h1>` per page
- Structured data (FAQ / HowTo / SoftwareApplication schema) on each tool page
- Supporting content per tool: what it does, how to use it, short FAQ, privacy angle
- Sitemap and clean internal linking between related tools
- Do not create thin content pages; each tool page needs genuine supporting content

## Accessibility

- Keyboard-operable drop zones and buttons
- Proper labels and visible focus states
- Sufficient colour contrast
- Respect `prefers-reduced-motion` and `prefers-color-scheme`

## Privacy policy and disclosures

- State "files never leave your device" prominently on every tool page
- When analytics or ads are added later, include a compliant cookie/consent banner (UK/EU required)

## Deferred tools (do not implement for MVP)

Compress-to-target-size, AVIF→PNG, images→PDF, video-to-GIF, audio trim, face blur. These are documented in `mvp-requirements.md`.
