---
name: verify
description: Verify the build is clean before shipping — runs type-check, build, and flags issues. Run /verify before committing or deploying.
---

Run these checks in order and report any failures:

1. **Type-check:** `npx astro check`
   - Report any TypeScript or Astro template errors.

2. **Production build:** `npm run build`
   - Report any build errors or warnings.
   - Check the **eagerly-loaded JS per page**, not the size of `./dist` as a whole. What matters is the entry chunk a visitor downloads before they interact: flag any page whose eager JS grows past ~50KB, and report the delta against the previous build.
   - Total `./dist` is _expected_ to be large and is not a useful signal — it includes ~21MB of lazy WASM codecs, the lazily-fetched ONNX runtime and detection models, and the per-page OG images. Only chunks reachable without user interaction count.

3. **Core Web Vitals checklist (manual review):**
   - Confirm that WASM codec imports appear inside event handlers or dynamic `import()` calls, NOT at the top of any page file. A top-level import blocks the initial render.
   - Confirm `src/lib/detect.ts` is only ever reached via `await import(...)`. A static import of it would pull the ONNX runtime into the eager bundle.
   - Confirm that each tool page has a unique `<title>` and `<meta name="description">`.
   - Confirm there are no `<script src="...">` tags pointing to third-party domains that could access file content.

4. **Accessibility spot-check:**
   - Check that drop zone elements have appropriate ARIA roles and keyboard handlers.
   - Check that Download and "Convert another" buttons have descriptive labels.

Report all findings clearly. If all checks pass, say so explicitly so the user knows it's safe to deploy.

To deploy after a clean verify: `wrangler pages deploy ./dist`
