// -----------------------------------------------------------------------
// pdf.js plumbing — shared by the PDF tools (redact-pdf today, flatten-pdf
// next). Rendering only: nothing here writes a PDF.
//
// Everything pdf.js needs at runtime is served from our own origin. That is
// the same rule src/lib/detect.ts follows for the ONNX runtime, and for the
// same reason: a tool whose whole promise is "your file never leaves your
// device" should not make the browser talk to a CDN to open that file. The
// worker comes through Vite as a content-hashed asset; the cmaps, fonts, ICC
// profile and decoder wasm are copied into public/pdfjs/<version>/ by
// scripts/sync-pdfjs.mjs.
//
// Note the traffic here is strictly *downloads* of static files. The document
// bytes are handed to pdf.js as an ArrayBuffer we already hold — we never give
// it a URL, so its network layer is never used for the user's file.
// -----------------------------------------------------------------------

import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
// Self-hosted worker. `?url` makes Vite emit it as a content-hashed asset in
// /_astro/ (which already carries an immutable cache header) and hands back the
// path. The pre-minified build is used because Vite copies `?url` assets
// verbatim rather than minifying them.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Must match the directory scripts/sync-pdfjs.mjs wrote. Bumping pdfjs-dist
 * means re-running that script and changing this string — the version in the
 * path is what lets the assets be cached immutably.
 */
const ASSETS = "/pdfjs/6.2.108/";

/** Points per inch in PDF user space. Scale for a DPI is dpi / 72. */
export const PDF_DPI_BASE = 72;

export type PdfDoc = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;

/**
 * An open document plus its teardown.
 *
 * `destroy()` lives on the loading task, not the document proxy, and it is what
 * actually terminates the worker and releases the file bytes it is holding. A
 * tool that opens a second PDF without it leaks a worker and a whole document
 * per file.
 */
export interface OpenedPdf {
  doc: PdfDoc;
  close(): Promise<void>;
}

/** Why opening a PDF failed, in terms the UI can act on. */
export type PdfOpenFailure = "password" | "wrong-password" | "corrupt" | "load";

export class PdfOpenError extends Error {
  constructor(readonly reason: PdfOpenFailure) {
    super(reason);
    this.name = "PdfOpenError";
  }
}

/**
 * Open a PDF from bytes.
 *
 * IMPORTANT: pdf.js transfers the buffer and leaves the caller's view
 * detached, so this copies. A password retry re-reads from the original File
 * in the caller anyway, but the copy makes the function safe to call twice on
 * the same array without a mystifying failure inside the worker port.
 */
export async function openPdf(
  bytes: Uint8Array,
  password?: string,
): Promise<OpenedPdf> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let task: PDFDocumentLoadingTask | undefined;
  try {
    const loading = pdfjs.getDocument({
      data: bytes.slice(),
      password,
      cMapUrl: ASSETS + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: ASSETS + "standard_fonts/",
      iccUrl: ASSETS + "iccs/",
      wasmUrl: ASSETS + "wasm/",
      // Note on JavaScript embedded in a PDF: executing it requires pdf.js's
      // separate scripting sandbox (build/pdf.sandbox.mjs), which is the only
      // thing that references quickjs-eval.wasm. We never import it, so that
      // code cannot run and the wasm isn't shipped — see scripts/sync-pdfjs.mjs.
      //
      // We already hold every byte, so range requests and speculative fetches
      // have nothing to do.
      disableAutoFetch: true,
      disableStream: true,
    });
    task = loading;
    const doc = await loading.promise;
    return { doc, close: () => loading.destroy() };
  } catch (e) {
    // A task that failed to resolve still owns a worker.
    void task?.destroy().catch(() => {});
    throw new PdfOpenError(classify(e));
  }
}

function classify(e: unknown): PdfOpenFailure {
  const name = e && typeof e === "object" && "name" in e ? e.name : "";
  if (name === "PasswordException") {
    // code 1 = none supplied, 2 = the one supplied was wrong. Telling these
    // apart is the difference between "this file needs a password" and "that
    // password was wrong", which is the whole content of the prompt.
    const code = e && typeof e === "object" && "code" in e ? e.code : 1;
    return code === 2 ? "wrong-password" : "password";
  }
  if (name === "InvalidPDFException") return "corrupt";
  return "load";
}

/** A page's size in PDF points, with its /Rotate already applied. */
export function pageSize(page: PdfPage): { ptW: number; ptH: number } {
  const vp = page.getViewport({ scale: 1 });
  return { ptW: vp.width, ptH: vp.height };
}

/**
 * Render one page onto a fresh canvas at `scale` (1 = 72 DPI).
 *
 * The caller owns the canvas and is expected to drop it as soon as the pixels
 * have been consumed — at 300 DPI an A4 page is a ~33 MB surface, so holding
 * more than one at a time is how a long document runs a tab out of memory.
 */
export async function renderPage(
  page: PdfPage,
  scale: number,
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  // A PDF page is transparent where nothing is drawn; a viewer paints white
  // under it. Without this, redacted output would have black "paper".
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * The scale that fits a page into `maxLongSide` pixels, never upscaling past
 * `maxScale`. Used for the editor stage and the filmstrip thumbnails.
 */
export function fitScale(
  ptW: number,
  ptH: number,
  maxLongSide: number,
  maxScale = 4,
): number {
  return Math.min(maxScale, maxLongSide / Math.max(ptW, ptH));
}
