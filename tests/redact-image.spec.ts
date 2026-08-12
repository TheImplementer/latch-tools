// Regression cover for the shipped image redaction tool.
//
// src/lib/regions.ts was extracted out of src/lib/redact.ts so the PDF tool
// could share the drag-a-box layer instead of forking it. Five ranking pages
// run on that code, so these tests exist to prove the extraction changed
// nothing a user can see — in both engines, because the effect maths has
// already been bitten once by a WebKit-only canvas difference.

import { expect, test } from "@playwright/test";
import { CONTROL_RECT, SECRET_RECT, makeTestPng } from "./fixtures";
import {
  downloadBytes,
  dragBox,
  inset,
  sampleRect,
  watchOrigins,
} from "./helpers";

const png = () => ({
  name: "sample.png",
  mimeType: "image/png",
  buffer: Buffer.from(makeTestPng()),
});

test("blacks out the dragged region and leaves the rest alone", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  await page.goto("/redact-image/");

  await page.locator('[data-el="file-input"]').setInputFiles(png());
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  const stage = page.locator('[data-el="stage"]');
  await dragBox(page, stage, SECRET_RECT);

  // The engine only enables export once a region exists, so this doubles as
  // proof the drag was registered as a region rather than a stray click.
  const apply = page.locator('[data-el="apply-btn"]');
  await expect(apply).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    apply.click().then(() => page.locator('[data-el="download-btn"]').click()),
  ]);

  const bytes = await downloadBytes(download);
  expect(download.suggestedFilename()).toBe("sample-redacted.png");

  const redacted = await sampleRect(
    page,
    bytes,
    "image/png",
    inset(SECRET_RECT),
  );
  expect(redacted.max, "every pixel under the bar must be black").toBeLessThan(
    8,
  );

  const control = await sampleRect(
    page,
    bytes,
    "image/png",
    inset(CONTROL_RECT),
  );
  expect(control.mean, "the untouched region must survive").toBeGreaterThan(80);

  origins.assertNoneOffOrigin();
});

test("keyboard editing still deletes a selected box", async ({ page }) => {
  await page.goto("/redact-image/");
  await page.locator('[data-el="file-input"]').setInputFiles(png());
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  const stage = page.locator('[data-el="stage"]');
  await dragBox(page, stage, SECRET_RECT);
  await expect(page.locator('[data-el="apply-btn"]')).toBeEnabled();

  // The box is selected immediately after being drawn, so Delete removes it
  // and the export gate closes again.
  await stage.press("Delete");
  await expect(page.locator('[data-el="apply-btn"]')).toBeDisabled();
});

test("a drag too small to be a box is discarded as a click", async ({
  page,
}) => {
  await page.goto("/redact-image/");
  await page.locator('[data-el="file-input"]').setInputFiles(png());
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  await dragBox(page, page.locator('[data-el="stage"]'), {
    x: 0.5,
    y: 0.5,
    w: 0.002,
    h: 0.002,
  });
  await expect(page.locator('[data-el="apply-btn"]')).toBeDisabled();
});
