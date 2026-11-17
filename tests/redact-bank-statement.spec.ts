// /redact-bank-statement/ is the PDF redaction engine behind a purpose-built
// page, so the thing worth proving is that the page really is wired to it: a
// statement dropped here comes out with the covered text destroyed rather than
// hidden. The engine's own behaviour (copy to all pages, quality, passwords)
// is covered in redact-pdf.spec.ts and is not repeated.

import { expect, test } from "@playwright/test";
import {
  CONTROL_RECT,
  SECRET,
  SECRET_RECT,
  countTextItems,
  extractPageImages,
  extractText,
  makeTextPdf,
} from "./fixtures";
import {
  downloadBytes,
  dragBox,
  inset,
  openTool,
  sampleRect,
  watchOrigins,
} from "./helpers";

test("a statement redacted on its own page loses the covered text", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);

  // The fixture has to contain the secret, or the checks below would pass
  // against a tool that did nothing.
  const source = await makeTextPdf(1);
  expect((await extractText(source))[0]).toContain(SECRET);

  await openTool(page, "/redact-bank-statement/");
  await expect(page.locator("h1")).toHaveText("How to redact a bank statement");

  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "statement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(source),
  });
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  await dragBox(page, page.locator('[data-el="stage"]'), SECRET_RECT);
  await expect(page.locator('[data-el="apply-btn"]')).toBeEnabled();
  // The button carries this page's own label.
  await expect(page.locator('[data-el="apply-label"]')).toHaveText(
    "Redact statement & download",
  );

  await page.locator('[data-el="apply-btn"]').click();
  await expect(page.locator('[data-panel="done"]')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-el="download-btn"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe("statement-redacted.pdf");
  const bytes = await downloadBytes(download);

  // The string is gone from the whole file, and the page holds no text at all,
  // so it did not just fail to match.
  expect((await extractText(bytes)).join(" ")).not.toContain(SECRET);
  expect(await countTextItems(bytes)).toEqual([0]);

  // The bar is there, and the rest of the page survived.
  const [img] = await extractPageImages(bytes);
  const bar = await sampleRect(page, img, "image/jpeg", inset(SECRET_RECT));
  expect(bar.max, "every pixel under the bar must be black").toBeLessThan(24);
  const control = await sampleRect(
    page,
    img,
    "image/jpeg",
    inset(CONTROL_RECT),
  );
  expect(control.mean, "the untouched content must remain").toBeGreaterThan(
    200,
  );

  origins.assertNoneOffOrigin();
});
