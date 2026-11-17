// /remove-metadata-from-pdf/ hands back a copy of a PDF without what it says
// about itself. The claims worth proving, each easy to get quietly wrong:
//
//   1. What the tool lists is really in the file, and none of it survives:
//      checked by searching the EXPANDED output (every stream uncompressed),
//      because a raw search of a compressed file finds nothing and proves
//      nothing.
//   2. Earlier versions go too. The fixture is saved the way editors save,
//      with an update appended, so its old title and a deleted comment are
//      still inside the input while no viewer shows them.
//   3. The pages are untouched: same text, same image, same pixels.
//   4. A locked file comes back locked exactly as it was.
//   5. Nothing leaves the browser, and qpdf isn't fetched for a plain file.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  LEAK,
  countPaintedImages,
  decryptWithQpdf,
  encryptWithQpdf,
  expandPdf,
  extractText,
  isEncryptedFile,
  makeLeakyPdf,
  makeTextPdf,
  permissionsOf,
  rawContains,
} from "./fixtures";
import {
  downloadBytes,
  openTool,
  renderSamples,
  watchOrigins,
  type NRect,
} from "./helpers";

const PATH = "/remove-metadata-from-pdf/";
/** Where makeLeakyPdf draws its photo, as a fraction of the page. */
const PHOTO: NRect = {
  x: 72 / 595,
  y: (842 - 300 - 96) / 842,
  w: 128 / 595,
  h: 96 / 842,
};
const HIDDEN = Object.entries(LEAK).filter(([k]) => k !== "body");

async function openFile(page: Page, bytes: Uint8Array, name = "plan.pdf") {
  await page.locator('[data-el="file-input"]').setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
}

const row = (page: Page, cat: string) => page.locator(`[data-row="${cat}"]`);

async function removeAndDownload(page: Page) {
  await page.locator('[data-el="apply-btn"]').click();
  await expect(page.locator('[data-panel="done"]')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-el="download-btn"]').click(),
  ]);
  return {
    bytes: await downloadBytes(download),
    filename: download.suggestedFilename(),
  };
}

test("everything the tool lists is in the file, and none of it survives", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  const qpdfFetched: string[] = [];
  page.on("request", (r) => {
    if (/qpdf/.test(r.url())) qpdfFetched.push(r.url());
  });

  const source = await makeLeakyPdf();
  // The premise: every planted string really is in the input, and the old
  // title is hidden from viewers by the appended update.
  const sourceX = await expandPdf(source);
  for (const [k, v] of HIDDEN) {
    expect(sourceX.includes(v) || rawContains(source, v), k).toBe(true);
  }
  expect(sourceX).not.toContain(LEAK.oldTitle); // a viewer's view: latest only
  expect(rawContains(source, LEAK.oldTitle)).toBe(true); // but it's in the bytes

  await openTool(page, PATH);
  await openFile(page, source);
  await expect(page.locator('[data-panel="options"]')).toBeVisible();

  // It shows what it found, in terms a person recognises.
  await expect(row(page, "props")).toContainText(LEAK.author);
  await expect(row(page, "props")).toContainText(LEAK.xmpAuthor);
  await expect(row(page, "props")).toContainText("3 recorded steps");
  await expect(row(page, "comments")).toContainText(LEAK.commentAuthor);
  await expect(row(page, "photos")).toContainText(LEAK.camera);
  await expect(row(page, "photos")).toContainText("GPS");
  await expect(row(page, "attachments")).toContainText(LEAK.attachment);
  await expect(row(page, "scripts")).toContainText("2 scripts");
  await expect(row(page, "appData")).toBeVisible();
  await expect(row(page, "history")).toContainText("saved once more");
  await expect(row(page, "id")).toBeVisible();

  const { bytes, filename } = await removeAndDownload(page);
  expect(filename).toBe("plan-clean.pdf");
  await expect(page.locator('[data-el="done-sub"]')).toContainText(
    "1 earlier version",
  );

  const outX = await expandPdf(bytes);
  for (const [k, v] of HIDDEN) expect(outX, k).not.toContain(v);
  expect(outX).not.toContain("/Producer");
  expect(outX).not.toContain("00112233445566778899aabbccddeeff"); // old ID
  // One version only: a single cross-reference section.
  expect(
    new TextDecoder("latin1").decode(bytes).match(/startxref/g),
  ).toHaveLength(1);

  // The page itself is untouched.
  expect(await extractText(bytes)).toEqual(await extractText(source));
  expect(await countPaintedImages(bytes)).toEqual([1]);
  const before = await renderSamples(page, source, 1, [PHOTO]);
  const after = await renderSamples(page, bytes, 1, [PHOTO]);
  expect(after.samples[0].mean).toBeCloseTo(before.samples[0].mean, 0);
  expect(after.samples[0].mean).toBeLessThan(200); // the photo, not blank paper

  // Opening the clean copy finds nothing left.
  await page.locator('[data-el="another-btn"]').click();
  await openFile(page, bytes, "plan-clean.pdf");
  await expect(page.locator('[data-panel="options"]')).toBeVisible();
  for (const cat of [
    "props",
    "comments",
    "photos",
    "attachments",
    "scripts",
    "appData",
    "history",
  ]) {
    await expect(row(page, cat), cat).toBeHidden();
  }
  await expect(page.locator('[data-el="options-note"]')).toContainText(
    "didn't find any metadata",
  );

  origins.assertNoneOffOrigin();
  expect(qpdfFetched, "qpdf is only for encrypted files").toEqual([]);
});

test("anything unticked is kept", async ({ page }) => {
  const source = await makeLeakyPdf();
  await openTool(page, PATH);
  await openFile(page, source);
  await expect(page.locator('[data-panel="options"]')).toBeVisible();
  await row(page, "props").locator("input").uncheck();
  await row(page, "attachments").locator("input").uncheck();

  const { bytes } = await removeAndDownload(page);
  const outX = await expandPdf(bytes);
  // Kept: the current properties and the attachment.
  expect(outX).toContain(LEAK.title);
  expect(outX).toContain(LEAK.author);
  expect(outX).toContain(LEAK.attachmentBody);
  // Still removed: the rest, and the earlier version, which is never optional.
  expect(outX).not.toContain(LEAK.oldTitle);
  expect(outX).not.toContain(LEAK.deletedComment);
  expect(outX).not.toContain(LEAK.camera);
  expect(outX).not.toContain(LEAK.commentAuthor);
  expect(outX).not.toContain(LEAK.script);
});

for (const [label, user] of [
  ["a password-protected PDF", "hunter2"],
  ["a PDF that restricts editing without a password", ""],
] as const) {
  test(`${label} comes back clean and locked exactly as it was`, async ({
    page,
  }) => {
    const source = await encryptWithQpdf(await makeLeakyPdf(), {
      user,
      owner: "author-only",
      restrictEditing: true,
    });
    expect(await isEncryptedFile(source)).toBe(true);
    const sourcePerms = await permissionsOf(source, user);
    expect(sourcePerms).not.toBeNull(); // the restrictions are real

    await openTool(page, PATH);
    await openFile(page, source, "locked.pdf");
    if (user) {
      await expect(page.locator('[data-panel="password"]')).toBeVisible();
      await page.locator('[data-el="pw-input"]').fill(user);
      await page
        .locator('[data-panel="password"] button[type="submit"]')
        .click();
    }
    await expect(page.locator('[data-panel="options"]')).toBeVisible();
    await expect(row(page, "props")).toContainText(LEAK.author);
    // An encrypted file's ID is part of its key: kept, so not offered.
    await expect(row(page, "id")).toBeHidden();

    const { bytes } = await removeAndDownload(page);
    await expect(page.locator('[data-el="done-sub"]')).toContainText(
      user ? "same password" : "restrictions are kept",
    );

    expect(await isEncryptedFile(bytes)).toBe(true);
    if (user) expect(await decryptWithQpdf(bytes, "")).toBeNull();
    expect(await decryptWithQpdf(bytes, "nope")).toBeNull();
    expect(await permissionsOf(bytes, user)).toEqual(sourcePerms);

    const outX = await expandPdf(bytes, user);
    for (const [k, v] of HIDDEN) expect(outX, k).not.toContain(v);
    const plain = (await decryptWithQpdf(bytes, user))!;
    expect(await extractText(plain)).toEqual([LEAK.body]);
  });
}

test("a file that isn't a PDF is refused in plain language", async ({
  page,
}) => {
  await openTool(page, PATH);
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await expect(page.locator('[data-el="err-title"]')).toHaveText(
    "That isn't a PDF",
  );
});

test("a PDF with nothing to remove still gets a fresh copy", async ({
  page,
}) => {
  const { PDFDocument } = await import("pdf-lib");
  // makeTextPdf sets pdf-lib's default Producer/Creator; strip to bare.
  const doc = await PDFDocument.load(await makeTextPdf(1), {
    updateMetadata: false,
  });
  doc.context.trailerInfo.Info = undefined;
  const bare = await doc.save();

  await openTool(page, PATH);
  await openFile(page, bare);
  await expect(page.locator('[data-panel="options"]')).toBeVisible();
  await expect(row(page, "props")).toBeHidden();
  await expect(page.locator('[data-el="apply-btn"]')).toBeEnabled();
  const { bytes } = await removeAndDownload(page);
  expect(await extractText(bytes)).toEqual(await extractText(bare));
});
