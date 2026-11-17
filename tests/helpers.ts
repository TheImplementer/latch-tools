// Shared Playwright helpers for the redaction tools.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  expect,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Load a tool page and wait until its widget is wired. The controller arrives
 * through a lazy import(), so a file set (or a drop fired) straight after
 * goto can land before any listener exists, and the panel never opens. That
 * race only shows under load, as one random PDF/image test failing per run.
 */
export async function openTool(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page
    .locator('[data-ready="true"]')
    .first()
    .waitFor({ state: "attached" });
}

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

// ---- Rendering a finished PDF in the browser -----------------------------
//
// To check what a viewer would show, the output is rendered with pdf.js in the
// same engine the test runs in. The library and its worker are served by the
// test itself from node_modules under a path the site does not use, so the page
// still talks only to its own origin; the self-hosted cmaps and fonts come from
// the site's own /pdfjs/<version>/ directory, exactly as the app gets them.

const PDFJS_DIR = fileURLToPath(
  new URL("../node_modules/pdfjs-dist/", import.meta.url),
);
const PDFJS_VERSION: string = JSON.parse(
  readFileSync(PDFJS_DIR + "package.json", "utf8"),
).version;
const served = new WeakSet<Page>();

async function servePdfJs(page: Page): Promise<void> {
  if (served.has(page)) return;
  served.add(page);
  await page.route("**/__test-pdfjs/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({
      path: PDFJS_DIR + "build/" + name,
      contentType: "text/javascript",
    });
  });
}

/**
 * Render page `pageNo` of `bytes` and measure luminance inside each
 * normalised rect of the rendered page. The page is drawn the way a viewer
 * draws it, so /Rotate and the CropBox are already applied: a rect's top-left
 * is the top-left of what a person sees.
 */
export async function renderSamples(
  page: Page,
  bytes: Uint8Array,
  pageNo: number,
  rects: NRect[],
  scale = 1.5,
): Promise<{ width: number; height: number; samples: Luminance[] }> {
  await servePdfJs(page);
  return page.evaluate(
    async ({ b64, pageNo, rects, scale, assets }) => {
      // new Function keeps the bundler/transpiler from rewriting import().
      const load = new Function("u", "return import(u)") as (
        u: string,
      ) => Promise<any>;
      const pdfjs = await load("/__test-pdfjs/pdf.mjs");
      // A blob URL for the worker, so no worker-level request interception is
      // needed and the worker needs no network of its own.
      const src = await (await fetch("/__test-pdfjs/pdf.worker.mjs")).text();
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([src], { type: "text/javascript" }),
      );
      const bin = atob(b64);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const task = pdfjs.getDocument({
        data,
        standardFontDataUrl: assets + "standard_fonts/",
        cMapUrl: assets + "cmaps/",
        cMapPacked: true,
        wasmUrl: assets + "wasm/",
        iccUrl: assets + "iccs/",
      });
      const doc = await task.promise;
      const pg = await doc.getPage(pageNo);
      const viewport = pg.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, canvas, viewport }).promise;
      const samples = rects.map((r) => {
        const x = Math.round(r.x * canvas.width);
        const y = Math.round(r.y * canvas.height);
        const w = Math.max(1, Math.round(r.w * canvas.width));
        const h = Math.max(1, Math.round(r.h * canvas.height));
        const { data } = ctx.getImageData(x, y, w, h);
        let sum = 0;
        let max = 0;
        let min = 255;
        for (let i = 0; i < data.length; i += 4) {
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += l;
          if (l > max) max = l;
          if (l < min) min = l;
        }
        return { mean: sum / (data.length / 4), max, min };
      });
      const out = { width: canvas.width, height: canvas.height, samples };
      await task.destroy();
      return out;
    },
    {
      b64: Buffer.from(bytes).toString("base64"),
      pageNo,
      rects,
      scale,
      assets: `/pdfjs/${PDFJS_VERSION}/`,
    },
  );
}
