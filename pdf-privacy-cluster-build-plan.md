# Build plan: document redaction cluster

> **Status: rewritten 2026-08-26.** Supersedes the July 2026 "PDF privacy cluster (6
> pages) + EXIF viewer" plan. Two of that plan's six tools are **dropped**, one is
> **reframed**, and two new pages are added. Rationale and the SEMrush recheck that
> drove it are below. Shipped since the original plan: `redact-pdf`, `flatten-pdf`.

## Context — why this plan changed

The July plan grouped six tools under "PDF privacy." An August recheck shows that label
was hiding two different businesses:

- **Document redaction** (`redact-pdf`, `unredact-pdf`, `redact-bank-statement`) —
  CPC $2.25–$2.98, KD 5–46%, US/UK-weighted, SERPs held by blogs, forums, GitHub repos
  and sub-10-ref-domain sites. This is winnable and it monetises.
- **Generic PDF utility** (`unlock-pdf`, `password-protect-pdf`) — CPC $0.38–$0.52,
  India-dominant volume, guarded by 500+ ref-domain walls. Unwinnable *and* it pays
  badly if won. Same commodity trap as the 24 format-converter pages.

The strategic correction behind this: **"privacy-first" is a positioning, not a
differentiator.** It doesn't appear in a SERP snippet, isn't a ranking factor, and can't
be verified before the click — smallpdf and ilovepdf upload your file and own these
SERPs anyway. What is actually non-commodity here is **capability**: on-device detection
(`src/lib/detect.ts`), the shared region editor across image and PDF, and a redaction
export that genuinely destroys data (`src/lib/pdfRaster.ts`) rather than drawing a box
over it. The plan below leads with capability and uses never-uploaded as the supporting
proof, not the headline.

### Verified data (SEMrush, 2026-08-26, US volume unless noted)

| Keyword | US vol | KD | CPC | AI Ovw | SERP note |
| --- | --- | --- | --- | --- | --- |
| `redact pdf` | 3.6K | 46% | $2.25 | Yes | pdffiller **8 RD** #6, pdf24 **11 RD** #7, askubuntu **4 RD** #10; top 3 only 28–67 RD |
| `how to redact a pdf` | **4.4K** | **39%** | — | — | how-to intent outranks the head term on volume *and* difficulty |
| `how do i redact a pdf` | 1.9K | 45% | — | — | |
| `how do you redact in pdf` | 1.6K | 43% | — | — | |
| `how to black out text in pdf` | 880 | 40% | $2.07 | Yes | parent term SERP: Reddit **#1**, 2× YouTube, tungsten **2 RD**, pdf-xchange **3 RD** |
| `unredact pdf` | 210 | **33%** | **$2.98** | Yes | **2× GitHub + SourceForge + r/hacking in the top 10**; #1 is AS 0 |
| `how to unredact a pdf` | 880 | 34% | — | — | |
| `redact bank statement` | 50 (UK **110**) | **5%** | **$2.91** | Yes | softest SERP in the batch — redactor.ai 3 RD, smallpdf *blog* 3 RD, xodo *blog* 2 RD, saferedact.app holds **#9 and #10** with 0 traffic |
| `redacted bank statement` | 210 | 17% | — | — | |
| `what is a redacted bank statement` | 90 | 19% | — | — | |
| `how to redact bank statement` | 70 | **6%** | — | — | |
| `sign pdf` | 12.1K | 43% | $1.70 | **No** | **Commercial** intent. 6/10 soft: luminpdf **5 RD**, docusign **7**, play.google **2**, swccd.edu **6** |
| `flatten pdf` *(shipped)* | 5.4K | 47% | $1.08 | Yes | confirmed soft — drawboard **2 RD**, .edu 7, .gov 11 |

**Dropped on this data:**

- **`unlock-pdf`** — US 12.1K looks good until you read the rest: **72% of the 510K
  global volume is India**, CPC **$0.38**, and the top of the SERP is a genuine wall
  (ilovepdf **572 RD**, smallpdf **548**, pdf.net **225**). At DR 10 this is closed, and
  winning it would pay less per visitor than position 5 on any redaction term.
  *(A decrypt capability survives as an in-flow utility — see below. The landing page
  does not.)*
- **`password-protect-pdf`** — KD 54%, CPC **$0.52**, AI Overview *and* a video
  carousel compressing organic CTR, and four heavyweights on page 1 (Adobe **560 RD**,
  smallpdf 186, pdf2go 160, ilovepdf 125). It is also the semantic inverse of what this
  site does. Dropped entirely, no surviving capability.
- **`anonymize pdf`** — 20 US / 470 global. Dead term.
- **`redact passport`** — no SEMrush data. The specific-document pattern holds for bank
  statements only; do not generalise it into a page-per-document-type template.
- **Batch / persona terms** (`blur multiple license plates`, `batch blur images`,
  `car dealership photo editing`) — **all three return N/A on every metric**, i.e. below
  the measurement floor. The GSC impressions for "bulk license plate blur" were real but
  ultra-long-tail. **Batch stays a product feature that makes existing pages convert;
  it is not a content strategy.** Do not spin up pages for it.
- **Deblur explainer** (`can blurred images be unblurred`, `recover redacted text`) —
  both N/A. The July/August instinct to build a deblur link-magnet was aimed at the
  wrong term; `unredact pdf` is the version of that idea with measurable demand. See
  Tool 2.

---

## Shared technical approach

Privacy invariant unchanged: **all processing client-side, no bytes leave the device.**
The plumbing already exists — this batch is mostly content and one new tool.

- **`pdf.js`** (`pdfjs-dist`) — page rasterisation. Already in use.
- **`pdf-lib`** — page/object ops, output assembly. Already in use.
- **`src/lib/pdfRaster.ts`** — the shared raster pipeline behind both `/redact-pdf/` and
  `/flatten-pdf/`. This is the load-bearing asset for the whole plan: it means our
  redaction destroys the text rather than covering it, which is a demonstrable claim
  (see Tool 2) rather than a marketing one.
- **`src/lib/regions.ts` / `src/lib/redact.ts` / `src/lib/pdfRedact.ts`** — region
  editor, effect maths, PDF controller. Reused as-is.
- **`qpdf-wasm`** — introduced only for the in-flow decrypt utility, not for a
  password-protect page.
- **Lazy-load everything** per `CLAUDE.md` — import on first drop-zone interaction only.

---

## Tool 1 — rework `/redact-pdf/` for how-to intent (do this first)

**Why first:** the page already exists and already ranks for nothing in particular. The
head term is 3.6K at KD 46; the how-to cluster is **7.9K US at KD 39–45** — more volume
at lower difficulty. This is the cheapest available upside in the whole plan: no new
tool code, only restructuring.

### What changes

- **Restructure the page as a guide with the tool embedded**, not a tool page with an
  FAQ bolted on. Reddit and YouTube hold top-10 slots on these SERPs, which is Google
  saying it can't find a good explanation — not that it lacks another converter widget.
- **H2s must carry the how-to phrasings verbatim**: "How to redact a PDF",
  "How to black out text in a PDF". These are the actual queries.
- Keep the widget above the fold; the guide runs beneath it. Do not push the tool down.
- **Lead the copy with the mechanism, not the promise.** The differentiated claim is
  *how* it redacts (rasterise → the text is gone), not *where* it runs.
- Cross-link into `/unredact-pdf/` (Tool 2) as the "why this matters" companion.

### SEO

- **Title:** keep `Redact PDF — Black Out Text Safely, Free · Latch Tools`
- **H1:** `How to redact a PDF` (changed — matches the dominant intent)
- **Schema:** `HowTo` becomes the primary entity; keep `SoftwareApplication` + `FAQPage`.
- **Headline FAQ:** _"Can redacted PDF text be recovered?"_ → short answer + link to the
  full explainer at `/unredact-pdf/`.
- **Related:** `/unredact-pdf/`, `/redact-bank-statement/`, `/redact-image/`,
  `/flatten-pdf/`.

---

## Tool 2 — `/unredact-pdf/` (explainer, NOT a tool) — the link magnet

**Why:** highest CPC in the dataset (**$2.98**), KD 33–34%, ~1.1K US across
`unredact pdf` + `how to unredact a pdf`. But the volume is not the point — **the SERP
composition is**:

| # | Result | Ref domains |
| --- | --- | --- |
| 1 | unredact.net | 34 (AS **0**) |
| 2 | adobe.com | **2** |
| 3 | **reddit.com/r/hacking** | 2 |
| 4 | **github.com/kdent/unredact** | 4 |
| 6 | tungstenautomation.de | **1** |
| 7 | **sourceforge.net** | — |
| 10 | **github.com/leedrake5/unredact** | 45 |

Two GitHub repos, a SourceForge project and r/hacking in one top ten. This is a
technical/research query space, not a commercial tool SERP — and that audience links
out, which ilovepdf and smallpdf never do. This directly targets the DR-10 / 488-junk-
referring-domains problem recorded in `open-source-launch` memory: a few DR-40+
editorial links beat hundreds of directory listings, and a well-sourced security
explainer from a public MIT repo is the asset that can earn them.

### ⚠️ Hard constraint: explainer only

**Do not build an un-redaction tool.** That is a deanonymisation tool, and the same
decision was already taken for deblur. This page explains the failure mode and funnels
to `/redact-pdf/`, which does it properly.

### Content spine

The reason this term has demand at all: most PDF "redaction" is a black rectangle drawn
over text that is still sitting in the content stream, recoverable with copy-paste or
`pdftotext`. The page should cover:

- The three common failure modes: vector box over live text; image-layer cover with the
  text layer intact; metadata/XMP and revision history surviving the visible edit.
- **Why ours doesn't fail that way** — `/redact-pdf/` rasterises the page via
  `src/lib/pdfRaster.ts` before the bars are baked, so there is no surviving text
  object. Cite the repo; it is public. This is the strongest content-plus-product story
  on the site because the claim is verifiable in source.
- A demonstration: a "properly redacted" PDF made in a common editor, and the recovered
  text next to it.
- Documented real-world cases of the failure (court filings, released government
  documents) — this is what makes it citable.

**Ignore** `unredacted epstein files pdf` (590, KD 64) and `epstein files unredacted
pdf` (320, KD 40) in the related-keyword list. Different intent, news-cycle volume, and
they will inflate any estimate for this cluster if counted.

### SEO

- **Title:** `Can Redacted PDF Text Be Recovered? · Latch Tools`
- **H1:** `How to unredact a PDF — and why yours might not be redacted`
- **Schema:** `Article` + `FAQPage`. **No `SoftwareApplication`** — there is no tool on
  this page.
- **Related:** `/redact-pdf/` (primary CTA), `/redact-bank-statement/`, `/redact-image/`.

---

## Tool 3 — `/redact-bank-statement/`

**Why:** KD **5%** ("Very easy"), CPC **$2.91**, and **UK is the #1 market** (110/mo vs
US 50) — the home market. The related cluster adds `redacted bank statement` (210, KD
17), `what is a redacted bank statement` (90, KD 19) and `how to redact bank statement`
(70, KD **6**).

The SERP is the softest in the batch and, critically, **contains no dedicated tool
page** — Adobe ranks a blog post, smallpdf ranks a blog post, xodo ranks a blog post,
and `saferedact.app` holds both #9 and #10 with 0 traffic. Reddit at #2 is
`r/NYCapartments`, which hands over the use case: **proving income to a landlord without
exposing every transaction.** UK skew fits (rental referencing, mortgage applications).

### Technical

No new engine. This is `/redact-pdf/` with a purpose-built spine: preset guidance on
what to black out (account number, sort code, balance, individual transactions) and what
to leave legible (name, address, period, salary credits) so the document still serves
its purpose.

### SEO

- **Title:** `Redact a Bank Statement — Free, In Your Browser · Latch Tools`
- **H1:** `How to redact a bank statement`
- **Must answer the definitional query too** — `what is a redacted bank statement` (90,
  KD 19) is informational; give it a real H2 answer, not an FAQ line.
- **Use cases as H2s:** rental application, mortgage/loan, visa application, expense
  claims.
- **FAQ:** what should I black out? · will the landlord accept a redacted statement? ·
  is it legal to redact? · can the hidden numbers be recovered? (→ `/unredact-pdf/`).
- **Related:** `/redact-pdf/`, `/unredact-pdf/`, `/remove-pdf-metadata/`.

---

## Tool 4 — `/sign-pdf/` (volume anchor, survives the recheck)

**Why it survived:** it was nearly cut with the other two PDF utilities, and the data
says otherwise. It is the **only Commercial-intent term in the batch**, carries **no AI
Overview** eating its CTR, holds a $1.70 CPC, and its soft page-1 slots have **not**
closed since July — luminpdf still ranks #3 on **5 ref domains**, DocuSign #6 on 7,
play.google #7 on 2, swccd.edu #10 on 6. US volume is 12.1K (down from the 14.8K in the
July read; point-in-time variance, not a trend).

It is off the redaction thesis, and it is the most build effort in this plan, so it goes
last — but it is genuinely winnable and the biggest prize here.

### Technical

Unchanged from the July plan: `pdf.js` render → user creates a signature (draw / type /
upload PNG) → drag, place, resize reusing the `regions.ts` placement model → stamp with
`pdf-lib` `page.drawImage`. **Structure family — do not rasterise the page**; the
document's text must stay crisp and selectable.

### ⚠️ Honest-copy caveat (unchanged)

Frame as **visual "fill & sign"**, not certificate-based digital signatures (PKI). Match
what ilovepdf/smallpdf/Adobe's free tools actually do; never imply legal e-signature
certificate validity.

### SEO

- **Title:** `Sign PDF — Fill & Sign in Your Browser · Latch Tools`
- **H1:** `Sign a PDF`
- **Secondary:** `how to sign a pdf` (8.1K, KD 45), `pdf signer` (8.1K, KD 48).
- **FAQ:** is my document uploaded? · is this a legal e-signature? · type or draw? ·
  multiple signatures? · lock it afterwards (→ `/flatten-pdf/`).
- **Related:** `/flatten-pdf/`, `/redact-pdf/`.

---

## In-flow utility — decrypt (capability, not a landing page)

**You cannot redact a password-protected PDF without decrypting it first**, and the code
already knows: `src/lib/flattenPdf.ts:152` carries a live error path for
`"This PDF is encrypted."` Today that is a dead end for the user.

Build the decrypt step **inside the redaction flow**: when a dropped PDF is encrypted,
prompt for the password the user already has, decrypt client-side with `qpdf-wasm`, and
continue. Owner-password/permission locks can often be cleared without a password.

**What this is not:** a `/unlock-pdf/` landing page. No head-term optimisation, no
`SoftwareApplication` schema, no OG campaign, not in the primary nav. If it gets a URL
at all, it is a thin honest utility page reachable from the redaction tools — never an
investment target. Framing stays "unlock a PDF you have the password for," never
cracking.

---

## Held — not in this batch

- **`remove-pdf-metadata`** — was the July plan's quick win (390 US, KD 34%, CPC $2.23)
  and was **not** re-verified on 2026-08-26. Trivial to build (`pdf-lib`: clear info
  dict + strip XMP) and it is genuine glue between `remove-exif` and the redaction
  cluster. **Re-pull the keyword before committing to it**; if it still holds, slot it
  in anywhere — it costs almost nothing.
- **`exif-viewer`** — remains **demoted** (2026-08-13, on GSC evidence: `remove-exif`
  sits at position 97 for its own exact-match query). Nothing in the August data
  changes that. Do not build without re-validating *viewer* intent as its own SERP.

---

## Site-wide wiring

The repositioning matters as much as the new pages:

1. **`src/pages/index.astro` — flip the hierarchy.** It currently leads with
   `<h3>Convert images` and puts `Protect your privacy` second. Redaction goes first;
   the h1 (`Edit your files without…`) should name redaction outright.
2. **Converters get a `/convert/` hub** and come off the homepage primary grid. They
   stay live and keep whatever they rank for — `/jpeg-xl/` (245 imp) and
   `/jfif-to-jpg/` (187 imp) are still the #2 and #3 pages by impressions, so deleting
   them buys nothing. They just stop defining the site. **Add no new converter slugs.**
3. **Internal links point *into* redaction**, not sideways between converters. The link
   graph currently treats all 32 tools as peers.
4. `src/components/Footer.astro` — Tools column updated per new page.
5. Sitemap + `lastmod` automatic (`@astrojs/sitemap` + git-date serialize).
6. OG images: run `scripts/gen-og.mjs` after each page lands (it reads the H1 — note
   Tool 1's H1 changes, so regenerate `/redact-pdf/`'s).

---

## Build order

1. **Rework `/redact-pdf/` for how-to intent** — no new tool code, targets 7.9K US at
   KD 39–45 instead of 3.6K at 46. Cheapest upside on the board.
2. **`/unredact-pdf/` explainer** — aimed at the link bottleneck rather than traffic.
   Depends on nothing; it is writing plus a demonstration. Ship close behind #1 so
   the two cross-link on arrival.
3. **`/redact-bank-statement/`** — reuses the `/redact-pdf/` widget wholesale; near-
   certain rank at KD 5–19, highest-value visitors, UK-first.
4. **`/sign-pdf/`** — most new UI, off-thesis but genuinely winnable and the volume
   anchor. Last because it is the only one that needs real build time.
5. **Decrypt in-flow utility** — slot in whenever an encrypted PDF blocking the
   redaction flow becomes annoying enough. Not urgent, not a page.

**Sequencing logic:** #1–3 are content and configuration on top of an engine that
already exists, so they land fast and they compound (each one links the others). #2 is
sequenced early despite the smallest volume because links are the constraint on
everything else — ranking anywhere near these terms needs authority the site does not
have, and this is the only page in the plan that can earn it. #4 is the one real build.

---

## Verification (per page)

1. `npx astro check` — 0 errors; `npm run build` clean; `dist/<slug>/` exists.
2. `npm run preview`, full round-trip:
   - **redact-pdf / redact-bank-statement** — exported pages are flat rasters with **no
     selectable text under the bars** (the non-vacuous check: `pdftotext` the output and
     confirm the redacted strings are absent).
   - **sign-pdf** — signature stamped at the right position/scale; the rest of the
     document's text stays **selectable and crisp**, not rasterised.
   - **unredact-pdf** — no widget, no file handling; check links and schema only.
3. **Privacy check:** DevTools Network tab empty for file bytes during processing — the
   core invariant.
4. Playwright run (`npm test`, chromium + webkit) per the existing harness.
5. Post-launch: submit each URL in GSC (URL Inspection → Request Indexing); confirm in
   `sitemap-0.xml`.

---

## Future / not in this batch

- `watermark-pdf` — cheap once PDF plumbing exists (KD 38%, CPC $1.48).
- Auto-detection for `redact-pdf` (on-device OCR / PII highlight) — keep client-side.
  This is the capability lane that is genuinely hard to copy; revisit once the content
  above is live.
- `merge-pdf`, `split-pdf`, `compress-pdf`, `pdf-to-jpg` — big volume, harder SERPs, and
  all of them are PDF *utility* rather than redaction. Treat with the same suspicion
  that killed `unlock-pdf`: check CPC and geography before KD.
- `remove-background-from-image` — KD 100%; product value only.
