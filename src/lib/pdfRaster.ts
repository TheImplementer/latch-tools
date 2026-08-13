// -----------------------------------------------------------------------
// Rasterise a PDF: render every page and rebuild the document from the
// resulting images.
//
// This is the shared half of the "raster family" of PDF tools. /redact-pdf/
// uses it to bake black bars into the pixels; /flatten-pdf/ uses it verbatim,
// with no transform, because flattening *is* the rebuild. /sign-pdf/ will
// deliberately NOT use it — stamping a signature has to keep the text crisp.
//
// It lives here rather than in ./pdf.ts to keep the pdf-lib dependency edge out
// of the module every PDF tool imports. ./pdf.ts is the pdf.js wrapper; a tool
// that only reads a document (unlock-pdf, remove-pdf-metadata) has no business
// pulling the PDF *writer* into its module graph.
//
// Two rules this module exists to enforce in one place:
//
//   1. A page that fails to render aborts the whole export. There is no
//      per-page try/catch that swallows and continues — deliberately. A PDF
//      missing a page is obvious; a PDF that silently lost the content of one
//      is a leak that looks like success. Nothing is written until every page
//      has been rendered, so a throw can never produce a partial document.
//
//   2. Full-resolution canvases are released as soon as their pixels have been
//      encoded. At 300 DPI an A4 page is a ~33 MB surface — and while a
//      transform is running there are up to three of them alive at once, so a
//      long document that held on to them would run the tab out of memory.
// -----------------------------------------------------------------------

import { PDF_DPI_BASE, pageSize, renderPage, type PdfDoc } from "./pdf";
import { raf, releaseCanvas } from "./regions";

/** Output resolutions offered in the UI. 150 suits screen and most printing. */
export const DPI_STANDARD = 150;
export const DPI_HIGH = 300;

// JPEG rather than PNG: a 300 DPI A4 page is roughly 400 KB as JPEG and 5 MB as
// PNG, and rasterising already grows the file. 0.85 keeps text edges clean
// enough to read without ringing.
export const JPEG_QUALITY = 0.85;

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  q: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      type,
      q,
    );
  });
}

export interface RasteriseOptions {
  /** Output resolution. The render scale is dpi / 72. */
  dpi: number;
  /** JPEG quality for the page images. Defaults to JPEG_QUALITY. */
  quality?: number;
  /**
   * Composite something onto a page's raster before it is encoded, returning
   * the canvas to encode — either the one passed in or a new one.
   *
   * The transform owns neither canvas: rasterisePdf releases the one it handed
   * over *and* the one handed back when they differ. A transform that calls
   * releaseCanvas itself will blank the surface before it is encoded.
   *
   * This exists for one caller (/redact-pdf/'s bars). Resist growing it.
   */
  transform?(canvas: HTMLCanvasElement, index: number): HTMLCanvasElement;
  /** Called with (pagesDone, total) before each page and once at the end. */
  onProgress?(done: number, total: number): void;
  /** Checked once per page. Returning true stops without writing anything. */
  shouldCancel?(): boolean;
}

/**
 * Either a finished document or a clean stop — never a partial one.
 *
 * A discriminated union rather than an optional `bytes`, so that no call site
 * can reach the output without having handled the cancelled case first. For a
 * tool whose promise is "we never hand you a half-done file", that guarantee
 * belongs in the type.
 */
export type RasteriseResult =
  | { ok: true; bytes: Uint8Array; firstPage: Blob | null; pages: number }
  | { ok: false; reason: "cancelled" };

export async function rasterisePdf(
  doc: PdfDoc,
  opts: RasteriseOptions,
): Promise<RasteriseResult> {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  const total = doc.numPages;
  const quality = opts.quality ?? JPEG_QUALITY;
  const scale = opts.dpi / PDF_DPI_BASE;
  let firstPage: Blob | null = null;

  for (let i = 0; i < total; i++) {
    // The yield is ours, not the caller's. If it depended on onProgress being
    // async, a caller that wrote a synchronous one would starve the event loop:
    // the meter would never paint and — worse — the Stop button could never
    // receive its click, so cancelling would silently stop working. Check the
    // cancel flag after the yield, so a click that lands during it is seen on
    // this iteration rather than the next.
    opts.onProgress?.(i, total);
    await raf();
    if (opts.shouldCancel?.()) return { ok: false, reason: "cancelled" };

    const page = await doc.getPage(i + 1);
    let blob: Blob;
    let ptW: number;
    let ptH: number;
    let rendered: HTMLCanvasElement | undefined;
    let encoded: HTMLCanvasElement | undefined;
    try {
      // Read the size before cleanup(), and from the viewport so that a page
      // with a /Rotate comes out at its visual size. MediaBox would not.
      ({ ptW, ptH } = pageSize(page));
      rendered = await renderPage(page, scale);
      encoded = opts.transform ? opts.transform(rendered, i) : rendered;
      blob = await canvasToBlob(encoded, "image/jpeg", quality);
    } finally {
      // In a finally so the throw path releases too — otherwise a document that
      // fails on page 90 leaves 90 pages' worth of pdf.js page state behind.
      if (encoded && encoded !== rendered) releaseCanvas(encoded);
      if (rendered) releaseCanvas(rendered);
      page.cleanup();
    }

    if (i === 0) firstPage = blob;
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    // Size each output page from the original's points, so mixed page sizes and
    // rotated pages come out exactly as they went in.
    const outPage = out.addPage([ptW, ptH]);
    outPage.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });
  }

  opts.onProgress?.(total, total);
  return { ok: true, bytes: await out.save(), firstPage, pages: total };
}
