// The product claim, as a test.
//
// "Redaction that actually removes the text" is the entire reason this tool
// exists, so the headline test proves it the way a sceptic would: it checks
// that the INPUT really does contain the secret, redacts it, and then goes
// looking for that string in the output with the same text extractor a viewer
// or `pdftotext` would use. A test that only asserted the string was absent
// would pass just as happily against a tool that produced a blank file.

import { expect, test } from "@playwright/test";
import {
  CONTROL_RECT,
  PAGE2_TEXT,
  SECRET,
  SECRET_RECT,
  countTextItems,
  extractPageImages,
  extractText,
  makeEncryptedPdf,
  makeTextPdf,
} from "./fixtures";
import {
  downloadBytes,
  dragBox,
  inset,
  sampleRect,
  watchOrigins,
} from "./helpers";

const PASSWORD = "hunter2";

async function pdfFile(pages = 2) {
  return {
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await makeTextPdf(pages)),
  };
}

/** Drop a PDF and wait for the editor. */
async function open(page: import("@playwright/test").Page, pages = 2) {
  await page.goto("/redact-pdf/");
  await page
    .locator('[data-el="file-input"]')
    .setInputFiles(await pdfFile(pages));
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();
}

/** Export and return the finished PDF's bytes. */
async function exportPdf(page: import("@playwright/test").Page) {
  await page.locator('[data-el="apply-btn"]').click();
  await expect(page.locator('[data-panel="done"]')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-el="download-btn"]').click(),
  ]);
  return { bytes: await downloadBytes(download), download };
}

test("the redacted text is destroyed, not covered", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);

  // 1. The fixture really does contain the secret. Without this the rest of
  //    the test would pass against a tool that did nothing at all.
  const source = await makeTextPdf(2);
  expect((await extractText(source))[0]).toContain(SECRET);

  await open(page);
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  await expect(page.locator('[data-el="apply-btn"]')).toBeEnabled();

  const { bytes, download } = await exportPdf(page);
  expect(download.suggestedFilename()).toBe("report-redacted.pdf");
  await expect(page.locator('[data-el="widget-title"]')).toHaveText(
    "Ready to download",
  );

  // 2. The string is gone, everywhere in the file.
  const text = (await extractText(bytes)).join(" ");
  expect(text).not.toContain(SECRET);

  // 3. And it is gone because the page is no longer made of text — not
  //    because some string happened not to match.
  expect(await countTextItems(bytes)).toEqual([0, 0]);

  // 4. The bar is actually there. Without this a tool that rasterised the page
  //    and drew nothing would sail through every check above.
  const images = await extractPageImages(bytes);
  expect(images).toHaveLength(2);
  const bar = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(SECRET_RECT),
  );
  expect(bar.max, "every pixel under the bar must be black").toBeLessThan(24);

  // 5. And the rest of the page survived it.
  const control = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(CONTROL_RECT),
  );
  expect(
    control.mean,
    "the untouched page content must remain",
  ).toBeGreaterThan(200);

  origins.assertNoneOffOrigin();
});

test("nothing leaves this origin for the whole flow", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  await open(page);
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  await exportPdf(page);
  // pdf.js pulls a worker, wasm decoders and font data while it renders. All of
  // it has to come from us — the point of self-hosting them.
  origins.assertNoneOffOrigin();
});

test("a box applies to its own page only", async ({ page }) => {
  await open(page);
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  const { bytes } = await exportPdf(page);

  const images = await extractPageImages(bytes);
  const p1 = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(SECRET_RECT),
  );
  const p2 = await sampleRect(
    page,
    images[1],
    "image/jpeg",
    inset(SECRET_RECT),
  );
  expect(p1.max).toBeLessThan(24);
  expect(p2.mean, "page 2 must be untouched").toBeGreaterThan(200);
});

test("copy boxes to all pages covers every page", async ({ page }) => {
  await open(page);
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  await page.locator('[data-el="apply-all-btn"]').click();

  const { bytes } = await exportPdf(page);
  expect((await extractText(bytes)).join(" ")).not.toContain(PAGE2_TEXT);

  const images = await extractPageImages(bytes);
  for (const img of images) {
    const bar = await sampleRect(page, img, "image/jpeg", inset(SECRET_RECT));
    expect(bar.max).toBeLessThan(24);
  }
});

test("the page strip lets you edit a later page", async ({ page }) => {
  await open(page, 3);
  const strip = page.locator('[data-el="filmstrip"]');
  await expect(strip).toBeVisible();
  await expect(strip.locator("[data-thumb]")).toHaveCount(3);

  await strip.locator('[data-thumb="2"]').click();
  await expect(page.locator('[data-el="widget-title"]')).toHaveText(
    "Page 3 of 3",
  );
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);

  const { bytes } = await exportPdf(page);
  const images = await extractPageImages(bytes);
  expect(images).toHaveLength(3);
  const p1 = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(SECRET_RECT),
  );
  const p3 = await sampleRect(
    page,
    images[2],
    "image/jpeg",
    inset(SECRET_RECT),
  );
  expect(p1.mean, "page 1 was never marked").toBeGreaterThan(200);
  expect(p3.max, "page 3 was").toBeLessThan(24);
});

test("a file that isn't a PDF is refused in plain language", async ({
  page,
}) => {
  await page.goto("/redact-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("just some text"),
  });
  await expect(page.locator('[data-panel="error"]')).toBeVisible();
  await expect(page.locator('[data-el="err-title"]')).toHaveText(
    "That isn't a PDF",
  );
  // Plain language, never a stack trace.
  await expect(page.locator('[data-el="err-message"]')).not.toContainText(
    "Error",
  );
});

test("a locked PDF asks for its password instead of failing", async ({
  page,
}) => {
  await page.goto("/redact-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "locked.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makeEncryptedPdf(PASSWORD)),
  });

  // The password panel, NOT the error panel: needing a password is an ordinary
  // state of an ordinary file, and the error panel's only exit discards it.
  await expect(page.locator('[data-panel="password"]')).toBeVisible();
  await expect(page.locator('[data-panel="error"]')).toBeHidden();

  // A wrong password says so and stays put.
  await page.locator('[data-el="pw-input"]').fill("wrong");
  await page.locator('[data-panel="password"] button[type="submit"]').click();
  await expect(page.locator('[data-el="pw-message"]')).toContainText(
    "didn't work",
  );
  await expect(page.locator('[data-panel="password"]')).toBeVisible();

  // The right one opens it.
  await page.locator('[data-el="pw-input"]').fill(PASSWORD);
  await page.locator('[data-panel="password"] button[type="submit"]').click();
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  // And it redacts like any other document.
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  const { bytes } = await exportPdf(page);
  expect((await extractText(bytes)).join(" ")).not.toContain(SECRET);
});

test("high quality renders at a higher resolution", async ({ page }) => {
  await open(page, 1);
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  const standard = await exportPdf(page);
  const stdImages = await extractPageImages(standard.bytes);

  await page.locator('[data-el="another-btn"]').click();
  await open(page, 1);
  await page.locator('[data-el="quality"]').selectOption("high");
  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  const high = await exportPdf(page);
  const highImages = await extractPageImages(high.bytes);

  // 300 DPI against 150 DPI: four times the pixels, so comfortably larger.
  expect(highImages[0].length).toBeGreaterThan(stdImages[0].length);
});
