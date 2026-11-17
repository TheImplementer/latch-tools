// /sign-pdf/ stamps an image of a signature onto the ORIGINAL pages of a PDF.
//
// Three claims are worth proving, because each is easy to get subtly wrong:
//
//   1. The pages are not rebuilt. The text a viewer could select before is
//      still there afterwards, and nothing but the signed pages changed.
//   2. The signature lands where it was dropped, on screen, whatever the page's
//      /Rotate or CropBox, and goes down with its transparency intact.
//   3. Nothing leaves the browser, including the font behind the Type tab.
//
// The editor is driven with real pointer events (the signature pad, dragging a
// placement), and the finished file is rendered with pdf.js in the same engine
// and sampled, so a pass means a viewer would show the signature in that spot.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  PLACEMENT_LUMA,
  countImageObjects,
  countPaintedImages,
  countTextItems,
  extractText,
  makeEncryptedPdf,
  makePlacementPdf,
  makeSignaturePng,
  pageSizes,
  placementText,
} from "./fixtures";
import {
  downloadBytes,
  inset,
  openTool,
  renderSamples,
  watchOrigins,
  type NRect,
} from "./helpers";
import { toDrawArgs, visibleBox } from "../src/lib/signPlace";

// ---- Maths, with no browser involved ---------------------------------------

test.describe("signature placement maths", () => {
  const bottomRight = { x: 0.6, y: 0.8, w: 0.3, h: 0.1 };
  const page = { x: 0, y: 0, w: 600, h: 800 };

  test("each rotation sends the displayed bottom-right to the matching corner", () => {
    // The image is anchored at its bottom-left and turned counter-clockwise
    // about that point, so these are the corners of the rotated image's box.
    const at = (rotation: 0 | 90 | 180 | 270) =>
      toDrawArgs({ view: page, rotation }, bottomRight);

    expect(at(0)).toEqual({ x: 360, y: 80, width: 180, height: 80, rotate: 0 });
    // 90°: displayed bottom-right is the unrotated top-right.
    expect(at(90)).toMatchObject({ x: 540, y: 480, width: 240, height: 60 });
    // 180°: the unrotated top-left.
    expect(at(180)).toMatchObject({ x: 240, y: 720, width: 180, height: 80 });
    // 270°: the unrotated bottom-left.
    expect(at(270)).toMatchObject({ x: 60, y: 320, width: 240, height: 60 });
  });

  test("a CropBox that does not start at the origin offsets the result", () => {
    const view = visibleBox(
      { x: 0, y: 0, w: 595, h: 842 },
      { x: 50, y: 100, w: 400, h: 600 },
    );
    expect(view).toEqual({ x: 50, y: 100, w: 400, h: 600 });
    // x = 50 + 0.6 * 400, y = (100 + 600) - 0.9 * 600
    expect(toDrawArgs({ view, rotation: 0 }, bottomRight)).toMatchObject({
      x: 290,
      y: 160,
      width: 120,
      height: 60,
    });
  });

  test("a CropBox is clipped to the MediaBox, as pdf.js does", () => {
    expect(
      visibleBox(
        { x: 0, y: 0, w: 500, h: 500 },
        { x: -100, y: -100, w: 400, h: 400 },
      ),
    ).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    // No overlap at all: fall back to the MediaBox rather than an empty page.
    expect(
      visibleBox(
        { x: 0, y: 0, w: 500, h: 500 },
        { x: 900, y: 900, w: 10, h: 10 },
      ),
    ).toEqual({ x: 0, y: 0, w: 500, h: 500 });
  });
});

// ---- Driving the editor ---------------------------------------------------

async function openSigner(
  page: Page,
  bytes: Uint8Array,
  name = "contract.pdf",
) {
  await openTool(page, "/sign-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();
}

const dialog = (page: Page) => page.locator('[data-el="sig-dialog"]');
const items = (page: Page) => page.locator("[data-sign-item]");

async function openCreator(page: Page) {
  await page.locator('[data-el="create-btn"]').click();
  await expect(dialog(page)).toBeVisible();
}
async function chooseMethod(page: Page, label: "Draw" | "Type" | "Upload") {
  await page.locator(".sg-seg label", { hasText: label }).click();
}
async function useSignature(page: Page) {
  const use = page.locator('[data-el="sig-use"]');
  await expect(use).toBeEnabled();
  await use.click();
  await expect(dialog(page)).toBeHidden();
}

async function createByUpload(page: Page, png: Uint8Array) {
  await openCreator(page);
  await chooseMethod(page, "Upload");
  await page.locator('[data-el="upload-input"]').setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from(png),
  });
  await useSignature(page);
}

/** A rising stroke across the pad, with real pointer events. */
async function createByDrawing(page: Page) {
  await openCreator(page);
  const pad = page.locator('[data-el="pad"]');
  const box = (await pad.boundingBox())!;
  const at = (fx: number, fy: number) =>
    [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.move(...at(0.15, 0.75));
  await page.mouse.down();
  await page.mouse.move(...at(0.35, 0.55));
  await page.mouse.move(...at(0.6, 0.38));
  await page.mouse.move(...at(0.85, 0.2));
  await page.mouse.up();
  await useSignature(page);
}

/** An item's rectangle as the editor holds it: normalised, top-left origin. */
async function itemRect(page: Page, index = 0): Promise<NRect> {
  return items(page)
    .nth(index)
    .evaluate((el) => {
      const s = (el as HTMLElement).style;
      return {
        x: parseFloat(s.left) / 100,
        y: parseFloat(s.top) / 100,
        w: parseFloat(s.width) / 100,
        h: parseFloat(s.height) / 100,
      };
    });
}

/**
 * Drag an item so its centre lands at `c` (normalised page coordinates).
 *
 * The target is worked out from the page canvas itself, not from the overlay
 * the editor places over it, so a mismatch between the two would show up as a
 * signature that does not end up where the test aimed.
 */
async function dragItemTo(
  page: Page,
  index: number,
  c: { x: number; y: number },
) {
  const pts = await page.evaluate(
    ({ index, c }) => {
      const stage = document.querySelector(
        '[data-el="stage"]',
      ) as HTMLCanvasElement;
      stage.scrollIntoView({ block: "center" });
      const b = stage.getBoundingClientRect();
      const ar = stage.width / stage.height;
      let cw = b.width;
      let ch = b.height;
      let ox = 0;
      let oy = 0;
      if (b.width / b.height > ar) {
        cw = b.height * ar;
        ox = (b.width - cw) / 2;
      } else {
        ch = b.width / ar;
        oy = (b.height - ch) / 2;
      }
      const item = document.querySelectorAll("[data-sign-item]")[
        index
      ] as HTMLElement;
      const r = item.getBoundingClientRect();
      return {
        from: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        to: { x: b.left + ox + cw * c.x, y: b.top + oy + ch * c.y },
      };
    },
    { index, c },
  );
  await page.mouse.move(pts.from.x, pts.from.y);
  await page.mouse.down();
  // WebKit wants the drag to look like one before it reports pointermove.
  await page.mouse.move(
    (pts.from.x + pts.to.x) / 2,
    (pts.from.y + pts.to.y) / 2,
  );
  await page.mouse.move(pts.to.x, pts.to.y);
  await page.mouse.up();
}

async function signAndDownload(page: Page) {
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

/** The same-sized corner patches used as "nothing was drawn here" controls. */
function corners(w: number, h: number): Record<string, NRect> {
  const m = 0.04;
  return {
    topLeft: { x: m, y: m, w, h },
    topRight: { x: 1 - m - w, y: m, w, h },
    bottomLeft: { x: m, y: 1 - m - h, w, h },
  };
}

// ---- The claims -----------------------------------------------------------

test("a signature goes on the chosen page only, and the original text is untouched", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  const source = await makePlacementPdf({ pages: 3 });
  const textBefore = await extractText(source);
  // The premise: the text is real, extractable text to begin with.
  expect(textBefore[1]).toContain(placementText(2));

  await openSigner(page, source, "lease.pdf");
  await page.locator('[data-thumb="1"]').click();
  await expect(page.locator('[data-el="widget-title"]')).toHaveText(
    "Page 2 of 3",
  );
  await createByDrawing(page);
  await expect(items(page)).toHaveCount(1);
  await dragItemTo(page, 0, { x: 0.75, y: 0.85 });
  const rect = await itemRect(page);
  // It really moved to where it was dragged, not just somewhere plausible.
  expect(rect.x + rect.w / 2).toBeCloseTo(0.75, 1);
  expect(rect.y + rect.h / 2).toBeCloseTo(0.85, 1);

  const { bytes, filename } = await signAndDownload(page);
  expect(filename).toBe("lease-signed.pdf");

  // (a) Not rasterised: same text, page by page, and the same number of text
  // runs. A rebuilt-from-images file would have none of either.
  expect(await extractText(bytes)).toEqual(textBefore);
  expect(await countTextItems(bytes)).toEqual(await countTextItems(source));

  // (b) Same pages, same sizes.
  expect(await pageSizes(bytes)).toEqual(await pageSizes(source));
  expect(await pageSizes(bytes)).toHaveLength(3);

  // (c) One image painted, on page 2 and nowhere else.
  expect(await countPaintedImages(bytes)).toEqual([0, 1, 0]);

  // ...and it is visible there, in the rendered pixels. The control is the same
  // rectangle on the other two pages, which must show only the page.
  const onPage2 = await renderSamples(page, bytes, 2, [inset(rect, 0.25)]);
  expect(onPage2.samples[0].min).toBeLessThan(90);
  for (const n of [1, 3]) {
    const other = await renderSamples(page, bytes, n, [rect]);
    expect(other.samples[0].min, `page ${n}`).toBeGreaterThan(150);
  }

  // Only that one signature's colour is dark in the other corners of page 2.
  const ctl = corners(rect.w * 0.6, rect.h * 0.6);
  const around = await renderSamples(page, bytes, 2, Object.values(ctl));
  for (const s of around.samples) expect(s.min).toBeGreaterThan(150);

  origins.assertNoneOffOrigin();
});

test("the signature keeps its transparency: no white box over the page", async ({
  page,
}) => {
  const source = await makePlacementPdf();
  await openSigner(page, source);
  await createByDrawing(page);
  const rect = await itemRect(page);
  const { bytes } = await signAndDownload(page);

  // The drawn stroke rises from bottom-left to top-right of its box, so the
  // other two corners of the box are empty. On a tinted page they must show the
  // tint; a white background would read 255.
  const topLeft = {
    x: rect.x + rect.w * 0.03,
    y: rect.y + rect.h * 0.06,
    w: rect.w * 0.12,
    h: rect.h * 0.22,
  };
  const bottomRight = {
    x: rect.x + rect.w * 0.85,
    y: rect.y + rect.h * 0.72,
    w: rect.w * 0.12,
    h: rect.h * 0.22,
  };
  const out = await renderSamples(page, bytes, 1, [
    topLeft,
    bottomRight,
    inset(rect, 0.25),
  ]);
  expect(Math.abs(out.samples[0].mean - PLACEMENT_LUMA)).toBeLessThan(8);
  expect(Math.abs(out.samples[1].mean - PLACEMENT_LUMA)).toBeLessThan(8);
  expect(out.samples[2].min).toBeLessThan(90);
});

test("an uploaded picture loses its white background by default and can keep it", async ({
  page,
}) => {
  const source = await makePlacementPdf();
  await openSigner(page, source);
  const empty = (r: NRect) => ({
    x: r.x + r.w * 0.04,
    y: r.y + r.h * 0.06,
    w: r.w * 0.14,
    h: r.h * 0.22,
  });

  // Default: the opaque white around the band becomes transparent.
  await createByUpload(page, makeSignaturePng({ opaque: true }));
  const rect = await itemRect(page);
  const first = await signAndDownload(page);
  const transparent = await renderSamples(page, first.bytes, 1, [empty(rect)]);
  expect(Math.abs(transparent.samples[0].mean - PLACEMENT_LUMA)).toBeLessThan(
    8,
  );

  // Switched off: the picture is placed as it is, white and all.
  await page.locator('[data-el="keep-editing-btn"]').click();
  await page.locator('[data-el="clear-btn"]').click();
  await openCreator(page);
  await chooseMethod(page, "Upload");
  await page.locator('[data-el="upload-bg"]').uncheck();
  await page.locator('[data-el="upload-input"]').setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from(makeSignaturePng({ opaque: true })),
  });
  await useSignature(page);
  const rect2 = await itemRect(page);
  const second = await signAndDownload(page);
  const boxed = await renderSamples(page, second.bytes, 1, [empty(rect2)]);
  expect(boxed.samples[0].mean).toBeGreaterThan(245);
});

// A signature dropped in the bottom-right of the preview must land in the
// bottom-right of the output however the page is turned or cropped. The
// preview comes from pdf.js and the placement from pdf-lib, which disagree
// about what "bottom" means on any page with a /Rotate.
for (const crop of [false, true]) {
  for (const rotate of [0, 90, 180, 270] as const) {
    test(`bottom-right on screen is bottom-right in the output: ${rotate}°${crop ? ", offset CropBox" : ""}`, async ({
      page,
    }) => {
      const cropBox = crop
        ? ([60, 120, 460, 720] as [number, number, number, number])
        : undefined;
      const source = await makePlacementPdf({ rotate, cropBox });
      await openSigner(page, source);
      await createByUpload(page, makeSignaturePng({ opaque: true }));
      await dragItemTo(page, 0, { x: 0.76, y: 0.88 });
      const rect = await itemRect(page);
      // Genuinely in the lower right, so the other-corner controls mean something.
      expect(rect.x + rect.w / 2).toBeGreaterThan(0.65);
      expect(rect.y + rect.h / 2).toBeGreaterThan(0.8);

      const { bytes } = await signAndDownload(page);

      // The file's own idea of the displayed page, so the test is not
      // assuming the rotation maths it is checking.
      const [size] = await pageSizes(bytes);
      const base = crop ? { w: 400, h: 600 } : { w: 595, h: 842 };
      expect(size).toEqual(
        rotate === 90 || rotate === 270
          ? { w: base.h, h: base.w }
          : { w: base.w, h: base.h },
      );

      const ctl = corners(rect.w * 0.5, rect.h * 0.5);
      const out = await renderSamples(page, bytes, 1, [
        inset(rect, 0.25),
        ...Object.values(ctl),
      ]);
      expect(out.samples[0].min, "ink where it was placed").toBeLessThan(90);
      out.samples.slice(1).forEach((s, i) => {
        expect(s.min, `${Object.keys(ctl)[i]} corner`).toBeGreaterThan(150);
      });
      // And the text on the page was not disturbed.
      expect((await extractText(bytes))[0]).toContain(placementText(1));
    });
  }
}

test("a page whose own content leaves the graphics state altered still gets the signature where it was placed", async ({
  page,
}) => {
  const source = await makePlacementPdf({ unbalanced: true });
  await openSigner(page, source);
  await createByUpload(page, makeSignaturePng({ opaque: true }));
  await dragItemTo(page, 0, { x: 0.76, y: 0.88 });
  const rect = await itemRect(page);
  const { bytes } = await signAndDownload(page);
  const ctl = corners(rect.w * 0.5, rect.h * 0.5);
  const out = await renderSamples(page, bytes, 1, [
    inset(rect, 0.25),
    ...Object.values(ctl),
  ]);
  // A stray translate carried into our image would have moved it off this spot.
  expect(out.samples[0].min).toBeLessThan(90);
  out.samples.slice(1).forEach((s) => expect(s.min).toBeGreaterThan(150));
});

test("one signature can be placed several times and on several pages, and is stored once", async ({
  page,
}) => {
  const source = await makePlacementPdf({ pages: 3 });
  await openSigner(page, source);
  await createByUpload(page, makeSignaturePng());
  await expect(items(page)).toHaveCount(1);
  await page.locator('[data-el="add-sig-btn"]').click();
  await page.locator('[data-el="add-sig-btn"]').click();
  await expect(items(page)).toHaveCount(3);

  // The copies must not stack exactly on top of each other.
  const ys = new Set<string>();
  for (let i = 0; i < 3; i++) ys.add((await itemRect(page, i)).y.toFixed(2));
  expect(ys.size).toBe(3);

  // Copy the selected one onto the other pages.
  await page.locator('[data-el="copy-all-btn"]').click();
  await expect(page.locator('[data-el="apply-label"]')).toHaveText(
    "Sign & download (3/3)",
  );

  const { bytes } = await signAndDownload(page);
  expect(await countPaintedImages(bytes)).toEqual([3, 1, 1]);
  // Painted five times, stored once: one PNG is an image plus its alpha mask.
  expect(await countImageObjects(bytes)).toBe(2);
  expect(await extractText(bytes)).toEqual(await extractText(source));
});

test("a typed name uses the handwriting font, fetched only then and only from this origin", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  const fonts: string[] = [];
  page.on("request", (r) => {
    if (/\.woff2(\?|$)/.test(r.url())) fonts.push(r.url());
  });

  const source = await makePlacementPdf();
  await openSigner(page, source);
  await openCreator(page);
  // Opening the maker, and drawing, cost no font.
  expect(fonts).toEqual([]);

  await chooseMethod(page, "Type");
  await page.locator('[data-el="type-input"]').fill("Anna Kowalska");
  await expect.poll(() => fonts.length).toBeGreaterThan(0);
  // Latin text needs the latin face only.
  expect(fonts.some((u) => /latin-ext/.test(u))).toBe(false);
  // Each style row has drawn something.
  await expect
    .poll(() =>
      page
        .locator('[data-el="type-row"] canvas')
        .first()
        .evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(50);

  // A name with a letter outside Latin-1 pulls in the extended face as well.
  await page.locator('[data-el="type-input"]').fill("Łukasz");
  await expect.poll(() => fonts.some((u) => /latin-ext/.test(u))).toBe(true);

  await page.locator('[data-el="type-input"]').fill("Anna Kowalska");
  await useSignature(page);
  const rect = await itemRect(page);
  const { bytes } = await signAndDownload(page);
  const out = await renderSamples(page, bytes, 1, [inset(rect, 0.1)]);
  expect(out.samples[0].min).toBeLessThan(90);

  origins.assertNoneOffOrigin();
});

test("nothing heavy loads before the page is used", async ({ page }) => {
  const sizes: { url: string; bytes: number }[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (r) => {
    const url = r.url();
    if (r.request().resourceType() !== "script" && !/\.(woff2?|mjs)$/.test(url))
      return;
    pending.push(
      r
        .body()
        .then((b) => void sizes.push({ url, bytes: b.length }))
        .catch(() => {}),
    );
  });
  await openTool(page, "/sign-pdf/");
  await Promise.all(pending);

  // pdf.js, pdf-lib and each font are hundreds of KB; the page itself should
  // only need its small controller.
  expect(
    sizes.map((s) => s.url).filter((u) => /woff2?$|worker/.test(u)),
  ).toEqual([]);
  expect(Math.max(...sizes.map((s) => s.bytes))).toBeLessThan(60_000);
  expect(sizes.reduce((n, s) => n + s.bytes, 0)).toBeLessThan(110_000);
});

// ---- Files that cannot be signed -------------------------------------------

for (const [name, password] of [
  ["a password-protected PDF", "hunter2"],
  ["a PDF locked by an owner password only", ""],
] as const) {
  test(`${name} gets a plain-language message instead of a broken file`, async ({
    page,
  }) => {
    let downloads = 0;
    page.on("download", () => downloads++);
    await openTool(page, "/sign-pdf/");
    await page.locator('[data-el="file-input"]').setInputFiles({
      name: "locked.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(makeEncryptedPdf(password)),
    });

    await expect(page.locator('[data-panel="error"]')).toBeVisible();
    await expect(page.locator('[data-el="err-title"]')).toHaveText(
      "This PDF is protected",
    );
    const message = page.locator('[data-el="err-message"]');
    await expect(message).toContainText("can't be signed here yet");
    await expect(message).not.toContainText(/error|encrypt/i);
    // Not an editor with a signature button that would fail later.
    await expect(page.locator('[data-panel="editor"]')).toBeHidden();
    expect(downloads).toBe(0);

    // The way out works.
    await page
      .locator('[data-panel="error"] [data-el="try-another-btn"]')
      .click();
    await expect(page.locator('[data-panel="drop"]')).toBeVisible();
  });
}

test("a file that isn't a PDF is refused in plain language", async ({
  page,
}) => {
  await openTool(page, "/sign-pdf/");
  await page.locator('[data-el="file-input"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await expect(page.locator('[data-el="err-title"]')).toHaveText(
    "That isn't a PDF",
  );
  await expect(page.locator('[data-el="err-message"]')).not.toContainText(
    "Error",
  );
});

test("a PDF that already carries a certificate-based signature warns before it is overwritten", async ({
  page,
}) => {
  // Not a valid signature: just the dictionary entry a real one always has,
  // stored uncompressed, which is what the check looks for.
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await makePlacementPdf());
  doc.context.register(
    doc.context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      ByteRange: [0, 10, 20, 30],
    }),
  );
  const signed = await doc.save({ useObjectStreams: false });

  await openSigner(page, signed);
  await expect(page.locator('[data-el="cert-note"]')).toBeVisible();
  await expect(page.locator('[data-el="cert-note"]')).toContainText(
    "won't validate any more",
  );

  // A document without one shows nothing.
  await openSigner(page, await makePlacementPdf());
  await expect(page.locator('[data-el="cert-note"]')).toBeHidden();
});

// ---- Editing --------------------------------------------------------------

test("a placement can be resized without distortion, nudged from the keyboard and removed", async ({
  page,
}) => {
  await openSigner(page, await makePlacementPdf());
  await createByUpload(page, makeSignaturePng());
  const item = items(page).first();

  // Resize from a corner: bigger, same shape.
  const before = (await item.boundingBox())!;
  const handle = page.locator("[data-sign-item] .sg-se");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 20, hb.y - 10);
  await page.mouse.move(hb.x - 50, hb.y - 24);
  await page.mouse.up();
  const after = (await item.boundingBox())!;
  expect(after.width).toBeLessThan(before.width);
  expect(
    Math.abs(after.width / after.height - before.width / before.height),
  ).toBeLessThan(0.04);

  // It cannot be dragged off the page.
  await dragItemTo(page, 0, { x: 1.0, y: 1.0 });
  const edge = await itemRect(page);
  expect(edge.x + edge.w).toBeLessThanOrEqual(1.0001);
  expect(edge.y + edge.h).toBeLessThanOrEqual(1.0001);

  // Keyboard: arrows nudge by 1%, + and - resize.
  await item.focus();
  const k0 = await itemRect(page);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const k1 = await itemRect(page);
  expect(k0.x - k1.x).toBeCloseTo(0.03, 3);
  await page.keyboard.press("-");
  expect((await itemRect(page)).w).toBeLessThan(k1.w);

  // Delete removes it, and with nothing placed there is nothing to export.
  await page.keyboard.press("Delete");
  await expect(items(page)).toHaveCount(0);
  await expect(page.locator('[data-el="apply-btn"]')).toBeDisabled();

  // The on-item remove button does the same, and a press on the picture itself
  // never lands on it.
  await page.locator('[data-el="add-sig-btn"]').click();
  await expect(items(page)).toHaveCount(1);
  await dragItemTo(page, 0, { x: 0.5, y: 0.5 });
  await expect(items(page)).toHaveCount(1);
  await page.locator("[data-sign-item] .sg-del").click();
  await expect(items(page)).toHaveCount(0);
});

test("typed text can be added to the page, including today's date", async ({
  page,
}) => {
  const source = await makePlacementPdf();
  await openSigner(page, source);
  await expect(page.locator('[data-el="add-text-btn"]')).toBeDisabled();
  await page.locator('[data-el="text-input"]').fill("A. Kowalska, tenant");
  await page.locator('[data-el="add-text-btn"]').click();
  await expect(items(page)).toHaveCount(1);
  await page.locator('[data-el="date-btn"]').click();
  await expect(items(page)).toHaveCount(2);

  const { bytes } = await signAndDownload(page);
  expect(await countPaintedImages(bytes)).toEqual([2]);
  // The text stamps sit as images, beside text that is still text.
  expect((await extractText(bytes))[0]).toContain(placementText(1));
});

test("the whole flow, with all three ways to sign, never leaves this origin", async ({
  page,
  baseURL,
}) => {
  const origins = watchOrigins(page, baseURL!);
  await openSigner(page, await makePlacementPdf({ pages: 2 }));
  await createByDrawing(page);
  await openCreator(page);
  await chooseMethod(page, "Type");
  await page.locator('[data-el="type-input"]').fill("Anna");
  await useSignature(page);
  await createByUpload(page, makeSignaturePng({ opaque: true }));
  await page.locator('[data-el="copy-all-btn"]').click();
  const { bytes } = await signAndDownload(page);
  expect(await countPaintedImages(bytes)).toEqual([3, 1]);
  await renderSamples(page, bytes, 1, [{ x: 0, y: 0, w: 1, h: 1 }]);
  origins.assertNoneOffOrigin();
});

// ---- Small screens --------------------------------------------------------

test("nothing forces sideways scrolling at 375px, in the editor or the signature maker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

  await openTool(page, "/sign-pdf/");
  expect(await overflow()).toBeLessThanOrEqual(0);

  await openSigner(page, await makePlacementPdf({ pages: 3 }));
  expect(await overflow()).toBeLessThanOrEqual(0);
  await createByUpload(page, makeSignaturePng());
  expect(await overflow()).toBeLessThanOrEqual(0);

  await openCreator(page);
  for (const method of ["Draw", "Type", "Upload"] as const) {
    await chooseMethod(page, method);
    expect(await overflow(), method).toBeLessThanOrEqual(0);
    const right = await dialog(page).evaluate(
      (d) => d.getBoundingClientRect().right,
    );
    expect(right, `${method} dialog right edge`).toBeLessThanOrEqual(375);
  }
});
