// Shared Playwright helpers for the redaction tools.

import {
  expect,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";

/** Normalised (0–1) rectangle, matching the engine's own coordinate space. */
export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Read a completed download into memory. */
export async function downloadBytes(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Drag a redaction box over a normalised rect of a canvas.
 *
 * Deliberately a real pointer drag rather than a scripted state mutation:
 * pointer capture, the MIN_REGION floor and the WebKit pointer-event
 * differences are exactly the things worth exercising.
 */
export async function dragBox(
  page: Page,
  canvas: Locator,
  rect: NRect,
): Promise<void> {
  // Scroll and measure inside one evaluate, so nothing can move in between.
  //
  // `scrollIntoViewIfNeeded` is not enough: it counts a partially visible
  // element as fine, so after clicking a page thumbnail the top of the canvas
  // can sit above the viewport and the drag starts at a negative y, where it
  // silently does nothing. Centring is unambiguous. The engine also calls
  // stage.focus() on pointerdown, which would otherwise scroll mid-drag.
  //
  // Measure the painted area, not the element box: the stage is `object-fit:
  // contain` under a max-height, so a portrait page is pillarboxed inside a
  // wider element and the two rects genuinely differ.
  const pts = await canvas.evaluate((el: HTMLCanvasElement, r: NRect) => {
    el.scrollIntoView({ block: "center", inline: "center" });
    const b = el.getBoundingClientRect();
    const bitmapAR = el.width / el.height;
    const boxAR = b.width / b.height;
    let cw = b.width;
    let ch = b.height;
    let ox = 0;
    let oy = 0;
    if (boxAR > bitmapAR) {
      cw = b.height * bitmapAR;
      ox = (b.width - cw) / 2;
    } else {
      ch = b.width / bitmapAR;
      oy = (b.height - ch) / 2;
    }
    const left = b.left + ox;
    const top = b.top + oy;
    return {
      from: { x: left + cw * r.x, y: top + ch * r.y },
      to: { x: left + cw * (r.x + r.w), y: top + ch * (r.y + r.h) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }, rect);

  // A drag that starts or ends outside the viewport does nothing at all, and
  // the failure it produces ("the export button never enabled") points nowhere
  // near the cause. Fail with the reason instead.
  for (const [name, pt] of [
    ["start", pts.from],
    ["end", pts.to],
  ] as const) {
    if (
      pt.x < 0 ||
      pt.y < 0 ||
      pt.x > pts.viewport.w ||
      pt.y > pts.viewport.h
    ) {
      throw new Error(
        `drag ${name} (${Math.round(pt.x)}, ${Math.round(pt.y)}) falls outside ` +
          `the ${pts.viewport.w}x${pts.viewport.h} viewport`,
      );
    }
  }

  await page.mouse.move(pts.from.x, pts.from.y);
  await page.mouse.down();
  // Two intermediate moves: one is enough for Chromium, but WebKit needs the
  // drag to look like a drag before it reports pointermove reliably.
  await page.mouse.move(
    (pts.from.x + pts.to.x) / 2,
    (pts.from.y + pts.to.y) / 2,
  );
  await page.mouse.move(pts.to.x, pts.to.y);
  await page.mouse.up();
}

/**
 * Shrink a rect towards its centre.
 *
 * Assertions sample the inside of a region, never its exact border. Chromium
 * and WebKit disagree by about a pixel on sub-pixel layout, so a bar drawn at
 * the same place lands one pixel apart between engines — irrelevant to a
 * hand-drawn box, but enough to leave a one-pixel sliver of the original
 * inside a pixel-exact sample.
 */
export function inset(r: NRect, by = 0.02): NRect {
  return {
    x: r.x + r.w * by,
    y: r.y + r.h * by,
    w: r.w * (1 - by * 2),
    h: r.h * (1 - by * 2),
  };
}

export interface Luminance {
  mean: number;
  max: number;
  min: number;
}

/**
 * Decode an image in the browser and measure luminance inside a normalised
 * rect.
 *
 * Done browser-side on purpose: the page already has a JPEG/PNG decoder and a
 * canvas, so the tests need no image library of their own.
 */
export async function sampleRect(
  page: Page,
  bytes: Uint8Array,
  mimeType: string,
  rect: NRect,
): Promise<Luminance> {
  return page.evaluate(
    async ({ b64, mimeType, rect }) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([buf], { type: mimeType }));
      // Read the dimensions before closing: a closed ImageBitmap reports 0×0,
      // which silently collapses the sample to a single corner pixel.
      const iw = bmp.width;
      const ih = bmp.height;
      const canvas = document.createElement("canvas");
      canvas.width = iw;
      canvas.height = ih;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const x = Math.round(rect.x * iw);
      const y = Math.round(rect.y * ih);
      const w = Math.max(1, Math.round(rect.w * iw));
      const h = Math.max(1, Math.round(rect.h * ih));
      const { data } = ctx.getImageData(x, y, w, h);
      let sum = 0;
      let max = 0;
      let min = 255;
      for (let i = 0; i < data.length; i += 4) {
        // Rec. 601 luma, which is close enough for "is this black?".
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += l;
        if (l > max) max = l;
        if (l < min) min = l;
      }
      return { mean: sum / (data.length / 4), max, min };
    },
    { b64: Buffer.from(bytes).toString("base64"), mimeType, rect },
  );
}

/**
 * Record every request the page makes and assert, at the end, that none of
 * them left this origin.
 *
 * This is the automated form of the promise the README asks people to verify
 * by grepping: no file bytes go anywhere, and no third party is contacted even
 * to fetch a library.
 */
export function watchOrigins(page: Page, baseURL: string) {
  const offOrigin: string[] = [];
  const expected = new URL(baseURL).origin;
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== expected) offOrigin.push(url);
  });
  return {
    assertNoneOffOrigin() {
      expect(offOrigin, `off-origin requests: ${offOrigin.join(", ")}`).toEqual(
        [],
      );
    },
  };
}
