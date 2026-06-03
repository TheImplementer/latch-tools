---
name: verify
description: Verify the build is clean before shipping — runs type-check, build, and flags issues. Run /verify before committing or deploying.
---

Run these checks in order and report any failures:

1. **Type-check:** `npx astro check`
   - Report any TypeScript or Astro template errors.

2. **Production build:** `npm run build`
   - Report any build errors or warnings.
   - Note the output size of `./dist` — flag if the total exceeds 500KB before WASM assets (WASM is expected to be large and lazy-loaded, so it doesn't count toward the initial payload).

3. **Core Web Vitals checklist (manual review):**
   - Confirm that WASM codec imports appear inside event handlers or dynamic `import()` calls, NOT at the top of any page file. A top-level import blocks the initial render.
   - Confirm that each tool page has a unique `<title>` and `<meta name="description">`.
   - Confirm there are no `<script src="...">` tags pointing to third-party domains that could access file content.

4. **Accessibility spot-check:**
   - Check that drop zone elements have appropriate ARIA roles and keyboard handlers.
   - Check that Download and "Convert another" buttons have descriptive labels.

Report all findings clearly. If all checks pass, say so explicitly so the user knows it's safe to deploy.

To deploy after a clean verify: `wrangler pages deploy ./dist`
