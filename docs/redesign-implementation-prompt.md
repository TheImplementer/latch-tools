# Latch Tools — redesign implementation prompt

**How to use this:** Give this to a coding agent (or use it yourself) to migrate the live Astro codebase from its current visual system to the decided "balanced green utility" direction. The reference design is a static HTML/CSS prototype, not a copy-paste source — this codebase has real interaction logic (drag/drop, conversion, batch download, theme persistence, error handling) that must be preserved and re-skinned, not replaced with the prototype's simplified click-to-preview state switcher.

**Reference prototype:** `~/Downloads/latch-tools-balanced-v4/` — `index.html`, `heic-to-jpg.html` (all 6 widget states, 10-photo batch list), `jpeg-xl.html` (grouped-format hub pattern), `styles.css`, `design-notes.md`. Look at this before writing any code; it's the visual source of truth for spacing, type scale, and component shape.

**Do not use the earlier iterations** in the same Downloads folder (`latch-tools-prototype`, `latch-tools-balanced-v3`) except for historical context — v4 supersedes them and fixed real issues (contrast, batch UI, footer links, error disclosure) that v3 and the technical prototype had.

---

## 1. What's changing and what isn't

**Changing:** every visual token (colour, radius, shadow, font stack), component markup/class names in `global.css` and the shared Astro components, tool directory layout on the homepage, and the copy register on user-facing strings (see Section 5).

**Not changing:**

- The Astro/TypeScript/Cloudflare Pages stack, static output, zero-backend architecture.
- The 7-step tool-page UX contract from `CLAUDE.md`: drop zone → filename/size preview → explicit Convert action → progress indicator → one-click download → "convert another" reset → plain-language error state.
- Any working JS logic in the `<script>` blocks of tool pages (file validation, HEIC decoding, quality slider wiring, drag/drop handlers, cancel/download-all). These are real, tested code paths — restyle the DOM they render into, don't rewrite the state machine. The prototype's `data-state-button` / `data-state-panel` click-toggle in `app.js` is prototype-only scaffolding for showing all 6 states at once; the live site's actual state transitions (driven by real file events) already work and must be kept.
- Lazy-loading of WASM/codec libraries — must still only import on first drop-zone interaction, never at module top-level.
- SEO surface: URL slugs, `<title>`, `<meta description>`, `<h1>` text, structured data (FAQ/HowTo/SoftwareApplication schema), and existing internal links. Reword body/UI copy per Section 5, but do not change ranking-relevant title/H1 text without flagging it first — some pages are already ranking (see `tool-roadmap.md` / `jxl-cluster-seo-plan.md` in project memory).

---

## 2. Design tokens — replace `src/styles/global.css` `:root` block

Current tokens use a blue accent (`--accent: #1f6feb`) and a cool grey scale. Replace with the v4 system:

```css
:root {
  color-scheme: light;
  --page: #f4f6f3;
  --surface: #ffffff;
  --surface-soft: #eef2ee;
  --surface-raised: #fafbf9;
  --text: #202521;
  --text-soft: #5e6962;
  --text-faint: #667169; /* v4 fixed this for AA contrast — do not revert to v3's #7e8982 */
  --border: #d9dfda;
  --border-strong: #bbc6be;
  --accent: #176b4a;
  --accent-hover: #10583c;
  --accent-soft: #e7f2eb;
  --success: #176b4a;
  --danger: #b63838;
  --danger-soft: #faecec;
  --focus: rgba(23, 107, 74, 0.36);
  --button-text: #ffffff;
  --shadow:
    0 16px 38px rgba(30, 45, 35, 0.08), 0 2px 5px rgba(30, 45, 35, 0.04);
  --shadow-small: 0 2px 7px rgba(30, 45, 35, 0.06);
  --radius-small: 7px;
  --radius: 11px;
  --radius-large: 15px;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --content: 1080px;
}

:root[data-theme="dark"],
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --page: #141814;
    --surface: #1c211d;
    --surface-soft: #242b25;
    --surface-raised: #202620;
    --text: #eef2ee;
    --text-soft: #a9b3ac;
    --text-faint: #929d95;
    --border: #323a33;
    --border-strong: #4a554c;
    --accent: #55c28b;
    --accent-hover: #72d6a2;
    --accent-soft: rgba(85, 194, 139, 0.13);
    --success: #55c28b;
    --danger: #f07979;
    --danger-soft: rgba(240, 121, 121, 0.12);
    --focus: rgba(85, 194, 139, 0.45);
    --button-text: #102118; /* dark-mode buttons use dark text on the mint accent — don't forget this or contrast breaks */
    --shadow: 0 18px 42px rgba(0, 0, 0, 0.32), 0 2px 5px rgba(0, 0, 0, 0.28);
    --shadow-small: 0 2px 7px rgba(0, 0, 0, 0.26);
  }
}
```

(Write both the `[data-theme="dark"]` selector and the `prefers-color-scheme` media query block, matching the existing pattern already in `global.css` — see v4's `styles.css` lines 30–76 for the exact duplication structure.)

**Font loading:** delete the three self-hosted font families (Space Grotesk, Manrope, IBM Plex Mono) and their `@font-face` blocks entirely. The new system uses only OS system fonts — this also means deleting the `/public/fonts/*.woff2` files once nothing references them, and removing the font preload tags from `Layout.astro` if any exist. This is a real performance win (zero font requests) as well as a visual one — confirm nothing else in the codebase still references `--font-display` / `--font-body` / `--font-mono` (old token names) after the swap; rename all usages to `--sans` / `--mono`.

**Radius/shadow scale:** old tokens were `--r-xs` through `--r-xl` plus `--r-pill`; new tokens are `--radius-small` / `--radius` / `--radius-large` with no pill radius. Audit every use of `border-radius: var(--r-pill)` (nav badges, trust pill, chips, format tags) — none of these should stay pill-shaped in the new system. Use `--radius` or `--radius-small` instead.

---

## 3. Component migration

Work through `src/components/` in this order — each depends on the previous:

1. **`Header.astro`** — drop the glassmorphic `backdrop-filter: blur` treatment; use a flat `--surface` background with a `1px solid var(--border)` bottom edge (see v4 `.site-header`). Keep the sticky positioning. Keep the theme toggle button and its existing `localStorage` persistence logic — just restyle it (v4 pattern: plain bordered button labelled "Theme", not an icon toggle).

2. **`TrustPill.astro`** — this component is currently used repeatedly across every page (hero + widget + footer), which violates the "state it once" rule already in project memory (`copy-voice-no-repetition.md`). Replace its pill-shaped multi-use pattern with a single banner-style component (v4's `.trust-note`: soft green background, rounded rect, shield icon, bold lead-in + explanatory text) used **once** near the top of each page. Do not add it again inside the widget states — the widget footer's repeated privacy microcopy in the current site should be deleted, not restyled.

3. **`Footer.astro`** — v4 introduces a 4-column footer (`brand+tagline`, `Convert`, `Protect`, `Latch`) with real internal links per column, replacing the current two-column layout. This is SEO-relevant (internal linking) — reproduce the full v4 footer link structure, and cross-check against the actual current tool list in `src/pages/` (not just the prototype's 4 sample links) so every shipped tool is linked from the footer, matching the intent of `og-and-sitemap-tooling.md`'s internal-linking notes in project memory.

4. **`BrandMark.astro`** — swap the current padlock SVG's stroke colour context to work against the new accent; the mark itself (rounded rect + shackle) can stay, v4 uses the same silhouette. Confirm it still reads correctly at 22px in the new header height (58–62px vs the old 68px).

5. **New: a `TrustNote.astro` or similar** to replace `TrustPill.astro`'s multi-context usage — accepts the surrounding copy as a prop so hero and tool-page instances can have different explanatory text while sharing the visual treatment.

---

## 4. Homepage (`src/pages/index.astro`)

Replace the 3-column `.tool-grid` of identical rounded icon-cards with v4's grouped-row directory:

- Group tools under plain-language headings ("Convert images", "Protect your privacy", "Resize and encode") — not the technical-prototype's `/convert` path-style labels.
- Each row: lowercase mono format label (`.heic → .jpg`, `blur`, `redact`, `base64`) leading, then bold tool name, then one-line plain-language description, then a trailing arrow. Reference v4's `.tool-row` / `.format-label` classes and exact copy in `index.html` — reuse its wording where it's already better than the current site's (e.g. "Make iPhone photos easier to open and share" vs current "Turn iPhone HEIC photos into universal JPGs anything can open").
- Add the search/filter input (`data-tool-search` in v4) — straightforward vanilla JS, port `app.js`'s filter logic directly, it has no dependency on anything prototype-specific.
- Remove the icon-chip SVGs per tool card entirely; identification now comes from the format label, not an icon.
- Keep the single `TrustNote` banner in the hero; remove the separate "Privacy band" 3-column section further down the page — v4 doesn't repeat trust messaging in a second section, and neither should the rebuilt homepage (this is the repetition rule again).
- Preserve the "Need another tool?" mailto card if you want a suggestion-collection mechanism, but restyle it into the new grouped-row format rather than the old card grid (or drop it if it doesn't fit the row layout — that's a judgement call, ask if unsure rather than silently cutting it).

---

## 5. Tool page migration — use `heic-to-jpg.astro` as the pilot

This is the highest-effort, highest-value page since every other tool page follows its pattern. Steps:

1. **Restyle only, don't rewrite `<script>`.** The existing `showState()`, `addFiles()`, `renderFileList()`, `startConversion()`, `downloadAll()` functions etc. (see current file, lines ~412–698) work correctly against `data-*` hooks and CSS classes. Rename/restructure CSS classes to match v4's naming (`.converter-shell`, `.drop-zone`, `.selected-file`, `.result-summary`, etc.) but keep the JS's element selectors in sync — this is a mechanical rename pass, not new logic.

2. **Batch UI:** v4 added a proper scrollable file-list for multi-file batches (`.file-list`, `.batch-heading` showing "10 photos ready · 10 of 10", `.batch-summary` showing total size) that the current live site's single-file-focused layout doesn't have. Port this pattern since `MAX_FILES = 10` already exists in the current code — the UI should have caught up to the batch capability that's already implemented.

3. **Fix the ZIP inconsistency found in v4 itself:** its "selected" state copy says "each photo will download as a separate JPG" but the "done" state offers `Download 10 JPGs · ZIP`. Standardise on ZIP for batch downloads in the rebuilt version (the current live site's `downloadAll()` — check what it actually does today and match the copy to the real behaviour, don't just copy v4's inconsistent strings verbatim).

4. **Copy pass** — adopt v4's plain-language conventions sitewide, not just on this page:
   - "photos" instead of "files" where the tool is image-specific (keep "files" for genuinely generic tools).
   - Quality slider gets a text label alongside the percentage: "92% · high quality" and endpoint labels "Smaller file" / "Best quality" (v4 `.quality-top`, `.quality-scale`).
   - Error messages: human explanation first, then "The original file has not been changed" reassurance, then a `<details><summary>Technical details</summary>` disclosure holding the error code — don't show raw error codes inline in the main message (v4 `.support-details` pattern). This is stronger than both the current site (which shows the code inline) and the technical prototype (which foregrounds it) — codes are useful for support but shouldn't be the first thing a non-technical user reads.
   - Done state shows the before/after size delta as a first-class visual element (v4 `.result-summary` / `.saving`), not buried in body text.

5. **Spec/limits line:** replace the current multi-row `<dl class="spec">` table with v4's single quiet line under the tool description ("HEIC and HEIF photos · Up to 10 at once · 50 MB per photo") — less visually heavy, same information.

6. **Fix the pre-existing content bug while you're in this file:** the FAQ section currently states "up to 50 photos at once" while the code (`MAX_FILES = 10`) and the drop-zone hint both say 10. Reconcile to 10 everywhere (code, hint text, FAQ, structured data) unless product intends to actually raise the batch limit — confirm with the user if raising the limit is preferred over lowering the FAQ claim.

Once `heic-to-jpg.astro` is fully migrated and verified working (real file conversion, not just visual), use it as the template to propagate to the other ~29 tool pages. Batch this with a script or systematic find/replace across shared class names where safe, but hand-check each page's specific copy (format names, FAQ content, structured data) since these are not identical files.

---

## 6. Format hub pages (e.g. `jpeg-xl.astro`)

v4's `jpeg-xl.html` shows the grouped-format hub pattern: a 2×2 grid of conversion-direction cards (`.jxl → .jpg`, `.jxl → .png`, `.jpg → .jxl`, `.png → .jxl`), each with format label, name, one-line description, and arrow — plus two supporting-content blocks ("What is JPEG XL?", "Which output should I choose?") below. Apply this to the existing `jpeg-xl.astro` hub page, replacing its current card treatment, and use the same pattern if/when other format hubs are built per `jxl-cluster-seo-plan.md`.

---

## 7. Verification before calling this done

- [ ] `npx astro check` passes with no new type errors.
- [ ] `npm run build` succeeds.
- [ ] Visually spot-check homepage + `heic-to-jpg` + `jpeg-xl` hub in **both** light and dark mode, desktop and mobile widths (use the `web-perf` skill or manually resize) — confirm no leftover blue accents, pill shapes, glassmorphism, or the old font stack anywhere (grep for `Space Grotesk`, `Manrope`, `IBM Plex Mono`, `--r-pill`, `backdrop-filter` across `src/` to catch stragglers).
- [ ] Actually drop a real HEIC file into the migrated `heic-to-jpg` page and confirm conversion, download, and "convert another" still work end-to-end — this is a functional regression check, not just a visual one.
- [ ] Keyboard-only pass: tab through drop zone, file remove buttons, quality slider, convert button, download button — focus rings should use the new `--focus` token and remain visible.
- [ ] Confirm `prefers-reduced-motion` still disables the spinner/scroll animations (check `global.css`'s existing reduced-motion block survived the token swap).
- [ ] Check color contrast on `--text-faint` against both `--page` and `--surface` in light mode — v4 already fixed this from v3's failing `#7e8982` to `#667169`, but re-verify after your own token integration in case cascade/blend changes anything.
- [ ] Confirm WASM/codec imports are still inside event handlers, not module top-level (grep for the dynamic `import()` calls and check they weren't accidentally hoisted during the restyle).
- [ ] Re-run `scripts/gen-og.mjs` / `wire-og.mjs` if OG images visually reference the old design system (check `og-and-sitemap-tooling.md` in project memory for what these scripts assume).
- [ ] Diff the FAQ/HowTo/SoftwareApplication structured data before and after — should be unchanged except for the deliberate 10-vs-50 fix.

---

## 8. Suggested sequencing (if doing this incrementally rather than all at once)

1. Token swap in `global.css` alone, deployed and eyeballed — biggest visual delta for lowest risk, touches no component logic.
2. Shared components (Header, Footer, TrustNote replacing TrustPill).
3. Homepage directory rework.
4. `heic-to-jpg.astro` full pilot migration (styling + batch UI + copy + bug fixes) — treat this as the template others will copy.
5. Propagate to remaining tool pages in batches (e.g. by cluster: image-format converters, then privacy/redaction tools, then encode/resize tools).
6. Format hub pages.
7. Final sitewide verification pass per Section 7.

Do this as a dedicated branch, not directly on `main` — this touches every page in the site.
