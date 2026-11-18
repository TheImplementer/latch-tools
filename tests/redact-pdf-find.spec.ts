// Find and black out, on /redact-pdf/ and /redact-bank-statement/.
//
// The claim under test: every character of every match ends up under a bar in
// the exported file. Text extraction can't check that (the export has no text
// at all), so the fixtures print every target in red, and the tests count red
// pixels in the exported page images. See makeFindPdf in ./fixtures for why
// the count proves what it does, and for the one red word that must survive.

import { expect, test, type Page } from "@playwright/test";
import {
  FIELD_RECT,
  FIND,
  FIND_CONTROL_RED,
  FORM_VALUE,
  extractPageImages,
  extractText,
  makeChromeStatementPdf,
  makeFindPdf,
  makeFormPdf,
  makeOcrScanPdf,
} from "./fixtures";
import {
  downloadBytes,
  inset,
  openTool,
  sampleRect,
  watchOrigins,
} from "./helpers";
import { findMatches, PATTERN_KINDS } from "../src/lib/findPatterns";

const ALL_KINDS = PATTERN_KINDS.map((k) => k.kind);

async function open(
  page: Page,
  path: string,
  bytes: Uint8Array,
  name = "statement.pdf",
) {
  await openTool(page, path);
  await page.locator('[data-el="file-input"]').setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();
}

async function setKinds(page: Page, kinds: string[]) {
  for (const k of ALL_KINDS) {
    await page.locator(`[data-find-kind="${k}"]`).setChecked(kinds.includes(k));
  }
}

async function find(page: Page, query: string, kinds: string[]) {
  await page.locator('[data-el="find-input"]').fill(query);
  await setKinds(page, kinds);
  await page.locator('[data-el="find-btn"]').click();
  // The button reads "Stop searching" while it runs.
  await expect(page.locator('[data-el="find-label"]')).toHaveText(
    "Find & black out",
  );
}

async function exportPdf(page: Page): Promise<Uint8Array> {
  await page.locator('[data-el="apply-btn"]').click();
  await expect(page.locator('[data-panel="done"]')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-el="download-btn"]').click(),
  ]);
  return downloadBytes(download);
}

/** Red pixels in a page image, and where they are, for a useful failure. */
async function countRed(page: Page, jpeg: Uint8Array) {
  return countCast(page, jpeg, "red");
}

/**
 * Pixels with a clear red or blue cast in a page image. Blue is set well
 * above the navy row's background, which is bluish too but isn't text.
 */
async function countCast(page: Page, jpeg: Uint8Array, cast: "red" | "blue") {
  return page.evaluate(async ([b64, cast]) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(
      new Blob([buf], { type: "image/jpeg" }),
    );
    const w = bmp.width,
      h = bmp.height;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const { data } = ctx.getImageData(0, 0, w, h);
    let n = 0,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Any pixel with a clear red cast, including the anti-aliased edge of
        // a glyph: a fringe left showing means a box stopped short. Black
        // bars, grey text, white paper and the navy row have no such cast.
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const hit =
          cast === "red" ? r - g > 50 && r - b > 50 : b - r > 100 && b - g > 80;
        if (hit) {
          n++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    return {
      n,
      at: n
        ? [x0 / w, y0 / h, x1 / w, y1 / h].map((v) => v.toFixed(3)).join(",")
        : "",
    };
  }, [Buffer.from(jpeg).toString("base64"), cast] as const);
}

test("every match is fully covered, on every kind of page", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  const src = await makeFindPdf();
  // The targets really are in the input, as text.
  const text = (await extractText(src)).join(" ");
  for (const v of Object.values(FIND).filter((v) => v !== FIND.name))
    expect(text).toContain(v);

  await open(page, "/redact-pdf/", src);
  await find(page, FIND.name, ALL_KINDS);

  await expect(page.locator('[data-el="find-status"]')).toContainText(
    "Blacked out",
  );
  // Page 4 is a picture: search must say it couldn't read it.
  await expect(page.locator('[data-el="find-warn"]')).toContainText("Page 4");
  // One results row per distinct thing found: the name and seven patterns.
  await expect(page.locator('[data-el="find-list"] li')).toHaveCount(8);

  const out = await exportPdf(page);
  const images = await extractPageImages(out);
  expect(images).toHaveLength(4);
  for (let i = 0; i < 3; i++) {
    const red = await countRed(page, images[i]);
    // Every page has one surviving red word: KEEP-THIS-RED. Everything else
    // red was a target. So the red that's left must all sit on that word's
    // line, which is the last line of the block.
    expect(
      red.n,
      `page ${i + 1}: the control word must survive`,
    ).toBeGreaterThan(50);
  }
  origins.assertNoneOffOrigin();
});

test("no target pixel survives once the control word is boxed too", async ({
  page,
}) => {
  // The same document, also searching for the control word. Now nothing red
  // may remain anywhere: a single leftover pixel is a character the bars missed.
  await open(page, "/redact-pdf/", await makeFindPdf());
  await find(page, FIND.name, ALL_KINDS);
  await find(page, FIND_CONTROL_RED, []);
  await expect(page.locator('[data-el="find-list"] li')).toHaveCount(9);

  const images = await extractPageImages(await exportPdf(page));
  for (let i = 0; i < 3; i++) {
    const red = await countRed(page, images[i]);
    expect(red.n, `page ${i + 1}: red left at ${red.at}`).toBe(0);
  }
});

test("a statement printed from a browser is covered too", async ({ page }) => {
  const src = await makeChromeStatementPdf();
  await open(page, "/redact-bank-statement/", src);
  // The bank page starts with the bank-detail patterns ticked.
  for (const k of ["bank", "iban", "card"])
    await expect(page.locator(`[data-find-kind="${k}"]`)).toBeChecked();
  await expect(page.locator('[data-find-kind="email"]')).not.toBeChecked();

  // Add email, phone, the name and the control word; keep the defaults.
  await page.locator('[data-el="find-input"]').fill("Jane Example");
  for (const k of ["email", "phone"])
    await page.locator(`[data-find-kind="${k}"]`).check();
  await page.locator('[data-el="find-btn"]').click();
  await expect(page.locator('[data-el="find-label"]')).toHaveText(
    "Find & black out",
  );
  await find(page, FIND_CONTROL_RED, [
    "bank",
    "iban",
    "card",
    "email",
    "phone",
  ]);

  // Dates and references that look like bank details must not be boxed.
  const listed = await page
    .locator('[data-el="find-list"] .find-text')
    .allTextContents();
  expect(listed).not.toContain("01-10-24");
  expect(listed).not.toContain("20241003");
  expect(listed).toContain("40-11-22");
  expect(listed).toContain("87654321");

  const images = await extractPageImages(await exportPdf(page));
  const red = await countRed(page, images[0]);
  expect(red.n, `red left at ${red.at}`).toBe(0);
});

test("an OCR'd scan is covered: boxes follow the picture, not the text layer", async ({ page }) => {
  const src = await makeOcrScanPdf();
  // The scan really carries the targets as (invisible) text.
  expect((await extractText(src)).join(" ")).toContain(FIND.account);

  await open(page, "/redact-pdf/", src);
  await find(page, "Jane Example", ALL_KINDS);
  await expect(page.locator('[data-el="find-warn"]')).toBeHidden();
  await find(page, FIND_CONTROL_RED, []);
  const images = await extractPageImages(await exportPdf(page));
  const red = await countRed(page, images[0]);
  expect(red.n, `red left at ${red.at}`).toBe(0);
});

// Faces whose widths differ a lot from the browser's default sans-serif, which
// is what positions are estimated with. Each falls back to a default face if
// it isn't installed, which only makes the case easier.
for (const font of ["Impact", "Verdana", "Georgia", "Courier New"]) {
  test(`covered in ${font}, whose widths the browser can't know`, async ({ page }) => {
    await open(page, "/redact-pdf/", await makeChromeStatementPdf(`'${font}'`));
    await find(page, "Jane Example", ALL_KINDS);
    await find(page, FIND_CONTROL_RED, []);
    // The patterns found the bank details again, on top of the two searches.
    await expect(page.locator('[data-el="find-list"] li')).not.toHaveCount(2);
    const images = await extractPageImages(await exportPdf(page));
    const red = await countRed(page, images[0]);
    expect(red.n, `red left at ${red.at}`).toBe(0);
  });
}

test("the boxes stay off the words next to a match", async ({ page }) => {
  // Baseline: the same document with one box, far from any label.
  await open(page, "/redact-pdf/", await makeFindPdf());
  await find(page, FIND_CONTROL_RED, []);
  const before = await extractPageImages(await exportPdf(page));

  await open(page, "/redact-pdf/", await makeFindPdf());
  await find(page, FIND.name, ALL_KINDS);
  await find(page, FIND_CONTROL_RED, []);
  const after = await extractPageImages(await exportPdf(page));

  for (let i = 0; i < 3; i++) {
    const b0 = (await countCast(page, before[i], "blue")).n;
    const b1 = (await countCast(page, after[i], "blue")).n;
    expect(b0, `page ${i + 1} has blue label text`).toBeGreaterThan(1000);
    // "Sort code:", "Account number:", "or call" and the rest must survive.
    // A box that strayed onto one of them costs far more than this margin.
    expect(b1 / b0, `page ${i + 1}: share of label text still visible`).toBeGreaterThan(0.95);
  }
});

test("the results list removes what it lists", async ({ page }) => {
  await open(page, "/redact-pdf/", await makeFindPdf());
  await find(page, "", ["email", "phone"]);
  const rows = page.locator('[data-el="find-list"] li');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(FIND.email);
  await expect(rows.first()).toContainText("3 boxes, pages 1, 2 and 3");

  await rows.first().locator(".find-x").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(FIND.phone);
  // The page-strip badges follow: one phone box per page.
  await expect(page.locator('[data-thumb="0"] .strip-badge')).toHaveText("1");

  // Searching again re-finds rather than doubling up.
  await find(page, "", ["email", "phone"]);
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-thumb="0"] .strip-badge')).toHaveText("2");

  await page.locator('[data-el="find-clear"]').click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator('[data-thumb="0"] .strip-badge')).toHaveCount(0);
  await expect(page.locator('[data-el="apply-btn"]')).toBeDisabled();
});

test("a search with no match says so and adds nothing", async ({ page }) => {
  await open(page, "/redact-pdf/", await makeFindPdf());
  await find(page, "Nobody Here", []);
  await expect(page.locator('[data-el="find-status"]')).toContainText(
    "Didn't find “Nobody Here” in 4 pages",
  );
  await expect(page.locator('[data-el="find-list"]')).toBeHidden();
  await expect(page.locator('[data-el="apply-btn"]')).toBeDisabled();

  // And an empty search asks for something to look for.
  await find(page, "", []);
  await expect(page.locator('[data-el="find-status"]')).toContainText(
    "Type a name, number or phrase",
  );
});

test("a form field's value is found and its field blacked out", async ({
  page,
}) => {
  await open(page, "/redact-pdf/", await makeFormPdf(), "form.pdf");
  await find(page, FORM_VALUE, []);
  await expect(page.locator('[data-el="find-list"] li')).toHaveCount(1);
  const images = await extractPageImages(await exportPdf(page));
  const bar = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(FIELD_RECT, 0.1),
  );
  expect(bar.max, "the whole field is under the bar").toBeLessThan(40);
});

// ---- Patterns, as plain strings ----

test.describe("patterns", () => {
  test("find the formats they're for", () => {
    const text =
      `Sort code: 20-45-67 Account number: 41234567 IBAN: GB33 BUKB 2045 6741 2345 67 BIC BUKBGB22 ` +
      `jane.example@example.co.uk Tel: +44 20 7946 0958 Mobile 07700 900123 SSN 123-45-6789 SSN: 123 45 6789 ` +
      `Card 4111 1111 1111 1111 card 5500-0000-0000-0004 Amex 3782 822463 10005 NI AB 12 34 56 C ` +
      `US (212) 555-0147 or 415.555.0199 Intl +33 1 42 68 53 00 DE89370400440532013000 ` +
      `Transfer to J SMITH 40-11-22 87654321 Acc no. 12345678 tel 01632 960983`;
    const got = findMatches(text, "", ALL_KINDS).map(
      (m) => `${m.kind}:${m.text}`,
    );
    expect(got).toEqual([
      "bank:20-45-67",
      "bank:41234567",
      "iban:GB33 BUKB 2045 6741 2345 67",
      "email:jane.example@example.co.uk",
      "phone:+44 20 7946 0958",
      "phone:07700 900123",
      "ssn:123-45-6789",
      "ssn:123 45 6789",
      "card:4111 1111 1111 1111",
      "card:5500-0000-0000-0004",
      "card:3782 822463 10005",
      "nino:AB 12 34 56 C",
      "phone:(212) 555-0147",
      "phone:415.555.0199",
      "phone:+33 1 42 68 53 00",
      "iban:DE89370400440532013000",
      "bank:40-11-22",
      "bank:87654321",
      "bank:12345678",
      "phone:01632 960983",
    ]);
  });

  test("leave dates, amounts and references alone", () => {
    const text =
      `Statement date 01-10-24 to 31-10-24. Period 2024-10-01. Balance 1,204.80 Total 12,345,678.90 ` +
      `Reference 20241001 Transaction ID 98765432101 Page 1 of 3 Invoice INV-2024-00123 Order #1234-5678 ` +
      `Postcode SW1A 1AA Version 1.2.3.4 Time 14:32:05 Date 2024/10/01 Amount $1,234,567.00 ` +
      `Customer no. 0001234567 ISBN 978-0-306-40615-7 Policy AB 12 34 56 Z VAT GB123456789 ` +
      `Batch 123-45-678 Card ending 1234 Date 12 10 24 Account balance 41234567.00`;
    expect(findMatches(text, "", ALL_KINDS)).toEqual([]);
  });

  test("a typed search ignores case, line breaks and how a number is spaced", () => {
    const text = "Ms Jane\nExample and O’Brien, acct 4123 4567";
    const q = (s: string) => findMatches(text, s, []).map((m) => m.text);
    expect(q("jane example")).toEqual(["Jane\nExample"]);
    expect(q("o'brien")).toEqual(["O’Brien"]);
    expect(q("41234567")).toEqual(["4123 4567"]);
    expect(q("x")).toEqual([]);
  });
});
