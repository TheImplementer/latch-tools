// The product claim, as a test.
//
// /flatten-pdf/ ships two modes that make OPPOSITE promises, so they have to be
// asserted as a pair. Rasterising must leave no text anywhere and bake the
// field's value into the pixels; form-flattening must remove the fields while
// leaving that same value as real, extractable, still-selectable text.
//
// Asserting only one of them would miss the failure that actually matters:
// quietly rasterising both paths. That produces a file that looks flattened,
// passes a "no form fields remain" check, and has silently destroyed the text
// layer the user chose the crisp mode specifically to keep.
//
// The fixture is built so the value is NOT extractable text before flattening —
// it lives in the widget's appearance stream — which is what makes "the crisp
// mode baked it in" a real finding rather than a tautology.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  FIELD_RECT,
  FORM_VALUE,
  HIDDEN_VALUE,
  countFormFields,
  countTextItems,
  extractPageImages,
  extractText,
  makeEncryptedPdf,
  makeFormPdf,
  makeTextPdf,
  pageSizes,
} from "./fixtures";
import { downloadBytes, inset, openTool, sampleRect, watchOrigins } from "./helpers";

const PASSWORD = "hunter2";

/** Top strip of page 1, which the fixture leaves empty. */
const EMPTY_RECT = { x: 0.1, y: 0.04, w: 0.5, h: 0.06 };

async function formFile(opts: { hidden?: boolean } = {}) {
  return {
    name: "application.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await makeFormPdf(opts)),
  };
}

/** Drop a PDF and wait for the options panel. */
async function open(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await openTool(page, "/flatten-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles(file);
  await expect(page.locator('[data-panel="options"]')).toBeVisible();
}

/** Run the currently selected mode and return the downloaded bytes. */
async function flatten(page: Page) {
  await page.locator('[data-el="apply-btn"]').click();
  await expect(page.locator('[data-panel="done"]')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-el="download-btn"]').click(),
  ]);
  return { bytes: await downloadBytes(download), download };
}

test("rasterising bakes the field value into the pixels and leaves no text", async ({
  page,
}) => {
  const file = await formFile();
  const input = new Uint8Array(file.buffer);

  // The premise: the value is real (a viewer shows it) but is not page text.
  expect((await extractText(input)).join(" ")).not.toContain(FORM_VALUE);
  expect(await countFormFields(input)).toBe(1);

  await open(page, file);
  // Rasterise is the default; assert that rather than selecting it, so a
  // regression in the default is caught here.
  await expect(page.locator('[data-el="mode-raster"]')).toBeChecked();
  const { bytes, download } = await flatten(page);

  expect(download.suggestedFilename()).toBe("application-flattened.pdf");

  // Nothing is text any more — on any page.
  expect(await countTextItems(bytes)).toEqual([0, 0]);
  expect(await countFormFields(bytes)).toBe(0);

  // ...but the value is visibly there, in the pixels. With the fixture's field
  // drawn borderless on white, the only thing that can darken this rect is the
  // value's own glyphs.
  const images = await extractPageImages(bytes);
  expect(images).toHaveLength(2);
  const field = await sampleRect(
    page,
    images[0],
    "image/jpeg",
    inset(FIELD_RECT),
  );
  expect(field.min).toBeLessThan(120);

  // A control, so "there are dark pixels" isn't just true of the whole page.
  const empty = await sampleRect(page, images[0], "image/jpeg", EMPTY_RECT);
  expect(empty.min).toBeGreaterThan(200);

  // Page count, size and orientation survive the rebuild.
  expect(await pageSizes(bytes)).toEqual([
    { w: 595, h: 842 },
    { w: 842, h: 595 },
  ]);
});

test("flattening form fields keeps the text and turns the value into it", async ({
  page,
}) => {
  const file = await formFile();
  const input = new Uint8Array(file.buffer);
  expect((await extractText(input)).join(" ")).not.toContain(FORM_VALUE);

  await open(page, file);
  await page.locator('[data-el="mode-form"]').check();
  const { bytes } = await flatten(page);

  // The fields are gone — same guarantee as the raster mode.
  expect(await countFormFields(bytes)).toBe(0);

  // But the value is now REAL TEXT, and the document still has a text layer.
  // This is the assertion that stops someone quietly rasterising both paths.
  expect((await extractText(bytes)).join(" ")).toContain(FORM_VALUE);
  const items = await countTextItems(bytes);
  expect(items[0]).toBeGreaterThan(0);
  expect(items[1]).toBeGreaterThan(0);

  // Crisp mode must not rebuild the pages, so there are no full-page rasters.
  expect(await extractPageImages(bytes)).toHaveLength(0);

  expect(await pageSizes(bytes)).toEqual([
    { w: 595, h: 842 },
    { w: 842, h: 595 },
  ]);
});

test("nothing leaves this origin for either mode", async ({
  page,
  baseURL,
}) => {
  const watcher = watchOrigins(page, baseURL!);
  const file = await formFile();

  await open(page, file);
  await flatten(page);

  // Round-trip through the reset, then run the other mode on the same page.
  await page.locator('[data-el="another-btn"]').click();
  await expect(page.locator('[data-panel="drop"]')).toBeVisible();
  await page.locator('[data-el="file-input"]').setInputFiles(file);
  await expect(page.locator('[data-panel="options"]')).toBeVisible();
  await page.locator('[data-el="mode-form"]').check();
  await flatten(page);

  watcher.assertNoneOffOrigin();
});

test("a PDF with no form fields says so instead of returning the same file", async ({
  page,
}) => {
  await open(page, {
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await makeTextPdf(1)),
  });

  const crisp = page.locator('[data-el="mode-form"]');
  await expect(crisp).toBeDisabled();
  const why = page.locator('[data-el="mode-form-why"]');
  await expect(why).toBeVisible();
  await expect(why).toContainText("no form fields");

  // The tool is still usable — rasterise stays selected and runnable.
  await expect(page.locator('[data-el="mode-raster"]')).toBeChecked();
  await expect(page.locator('[data-el="apply-btn"]')).toBeEnabled();
});

test("hidden form fields switch the crisp mode off rather than baking them in", async ({
  page,
}) => {
  const file = await formFile({ hidden: true });
  // pdf-lib's flatten() ignores the hidden flag, so the crisp path WOULD draw
  // this value onto the page. Rasterising, which honours it, must not.
  await open(page, file);

  const crisp = page.locator('[data-el="mode-form"]');
  await expect(crisp).toBeDisabled();
  await expect(page.locator('[data-el="mode-form-why"]')).toContainText(
    "hidden",
  );

  const { bytes } = await flatten(page);
  const images = await extractPageImages(bytes);
  // The hidden value is not in the output as text (nothing is, after raster)...
  expect((await extractText(bytes)).join(" ")).not.toContain(HIDDEN_VALUE);
  // ...and the strip of page where it would have been drawn is still blank.
  const hiddenBand = await sampleRect(page, images[0], "image/jpeg", {
    x: 0.1,
    y: 0.45,
    w: 0.5,
    h: 0.05,
  });
  expect(hiddenBand.min).toBeGreaterThan(200);
});

test("a file that isn't a PDF is refused in plain language", async ({
  page,
}) => {
  await openTool(page, "/flatten-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await expect(page.locator('[data-panel="error"]')).toBeVisible();
  await expect(page.locator('[data-el="err-title"]')).toHaveText(
    "That isn't a PDF",
  );
  await expect(page.locator('[data-el="err-message"]')).not.toContainText(
    "Error",
  );
});

test("a locked PDF asks for its password instead of failing", async ({
  page,
}) => {
  await openTool(page, "/flatten-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "locked.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makeEncryptedPdf(PASSWORD)),
  });

  // Needing a password is an ordinary state of an ordinary file, not an error.
  await expect(page.locator('[data-panel="password"]')).toBeVisible();
  await expect(page.locator('[data-panel="error"]')).toBeHidden();

  await page.locator('[data-el="pw-input"]').fill("wrong");
  await page.locator('[data-panel="password"] button[type="submit"]').click();
  await expect(page.locator('[data-el="pw-message"]')).toContainText(
    "didn't work",
  );

  await page.locator('[data-el="pw-input"]').fill(PASSWORD);
  await page.locator('[data-panel="password"] button[type="submit"]').click();
  await expect(page.locator('[data-panel="options"]')).toBeVisible();

  // pdf-lib cannot rewrite an encrypted file's contents, so crisp is off — and
  // says why rather than failing later, once the user has committed to it.
  await expect(page.locator('[data-el="mode-form"]')).toBeDisabled();
  await expect(page.locator('[data-el="mode-form-why"]')).toBeVisible();
});
