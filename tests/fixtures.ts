// -----------------------------------------------------------------------
// Test fixtures for the PDF tools.
//
// Nothing here is committed as a binary. Every fixture PDF is generated at
// test time, for two reasons: `.gitignore` forbids fixture blobs under
// `public/` (everything there ships to production), and a generated fixture
// lets a test assert what the INPUT contains before asserting what the output
// doesn't — which is the difference between proving redaction works and
// proving nothing at all.
// -----------------------------------------------------------------------

import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** The string the redaction tests hunt for. Must not appear in the output. */
export const SECRET = "CONFIDENTIAL-SECRET-12345";

/** Text placed at the same spot on page 2, which page 1's bar must NOT hide. */
export const PAGE2_TEXT = "PAGE-TWO-STAYS-VISIBLE";

/** A4 in PDF points. */
const PAGE_W = 595;
const PAGE_H = 842;

/**
 * Normalised (0–1, top-left origin) rect that generously encloses the secret
 * text on every page. The tests drag a box over exactly this, then sample the
 * same rect in the exported raster.
 */
export const SECRET_RECT = { x: 0.08, y: 0.12, w: 0.6, h: 0.1 };

/** A control rect low on the page that must stay untouched (light background). */
export const CONTROL_RECT = { x: 0.08, y: 0.6, w: 0.6, h: 0.1 };

/**
 * Build a multi-page PDF with real, extractable text.
 *
 * Page 1 carries SECRET, page 2 carries PAGE2_TEXT, both inside SECRET_RECT,
 * plus a line of body text inside CONTROL_RECT on each page.
 */
export async function makeTextPdf(pages = 2): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(i === 0 ? SECRET : PAGE2_TEXT, {
      x: 72,
      // Baseline chosen so the glyphs sit inside SECRET_RECT once the page is
      // flipped to top-left normalised coordinates.
      y: PAGE_H - 0.17 * PAGE_H,
      size: 18,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(`Body text on page ${i + 1}. Nothing sensitive here.`, {
      x: 72,
      y: PAGE_H - 0.65 * PAGE_H,
      size: 12,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
  return doc.save();
}

// ---- Encrypted fixture -------------------------------------------------
//
// pdf-lib cannot write encrypted PDFs and no qpdf/mutool exists on this
// machine, so the password fixture is assembled by hand against the PDF
// standard security handler (revision 2, RC4-40). It only has to be correct
// enough that pdf.js demands a password and then opens with the right one —
// which is exactly the code path the widget's password panel drives.

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** RC4. Node's OpenSSL 3 build no longer exposes it, so: 15 lines. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function md5(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Pad or truncate a password to the 32 bytes the handler expects. */
function padPassword(pw: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const raw = new TextEncoder().encode(pw).slice(0, 32);
  bytes.set(raw);
  bytes.set(PAD.slice(0, 32 - raw.length), raw.length);
  return bytes;
}

const KEY_LEN = 5; // 40-bit
const PERMS = -4; // all operations allowed; bits 1–2 reserved and clear

function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

/** Per-object key: Algorithm 1. */
function objectKey(key: Uint8Array, obj: number, gen: number): Uint8Array {
  const extra = Uint8Array.from([
    obj & 0xff,
    (obj >> 8) & 0xff,
    (obj >> 16) & 0xff,
    gen & 0xff,
    (gen >> 8) & 0xff,
  ]);
  return md5(key, extra).slice(0, Math.min(KEY_LEN + 5, 16));
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const hex = (b: Uint8Array) =>
  [...b].map((n) => n.toString(16).padStart(2, "0")).join("");

/**
 * A one-page, RC4-40 encrypted PDF whose visible text is SECRET.
 * Opens with `password`; pdf.js raises PasswordException without it.
 */
export function makeEncryptedPdf(password: string): Uint8Array {
  const fileId = md5(latin1("latch-tools-fixture")); // any stable 16 bytes

  // Algorithm 3 — /O. With no separate owner password the user password is
  // used for both, which is the common single-password case.
  const oKey = md5(padPassword(password)).slice(0, KEY_LEN);
  const O = rc4(oKey, padPassword(password));

  // Algorithm 2 — the file encryption key. Derived from the USER password: get
  // this wrong and the file opens with an empty password instead.
  const key = md5(padPassword(password), O, le32(PERMS), fileId).slice(
    0,
    KEY_LEN,
  );
  // Algorithm 4 — /U for revision 2.
  const U = rc4(key, PAD);

  // The single content stream, encrypted under object 4's key.
  const content = latin1(
    `BT /F1 18 Tf 72 ${PAGE_H - 0.17 * PAGE_H} Td (${SECRET}) Tj ET\n`,
  );
  const encContent = rc4(objectKey(key, 4, 0), content);

  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objs[5] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[6] =
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${PERMS} ` +
    `/O <${hex(O)}> /U <${hex(U)}> >>`;

  // Assemble with byte-accurate xref offsets.
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    pos += b.length;
  };

  push(latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
  for (const n of [1, 2, 3, 4, 5, 6]) {
    offsets[n] = pos;
    if (n === 4) {
      push(latin1(`4 0 obj\n<< /Length ${encContent.length} >>\nstream\n`));
      push(encContent);
      push(latin1("\nendstream\nendobj\n"));
    } else {
      push(latin1(`${n} 0 obj\n${objs[n]}\nendobj\n`));
    }
  }

  const xrefPos = pos;
  let xref = "xref\n0 7\n0000000000 65535 f \n";
  for (const n of [1, 2, 3, 4, 5, 6]) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  push(latin1(xref));
  push(
    latin1(
      `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R ` +
        `/ID [<${hex(fileId)}> <${hex(fileId)}>] >>\n` +
        `startxref\n${xrefPos}\n%%EOF\n`,
    ),
  );

  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---- Output inspection -------------------------------------------------

/**
 * Open a PDF with pdf.js under Node, using the same self-hosted asset set the
 * browser gets. Returns the loading task so callers can destroy it — the
 * document proxy alone has no teardown.
 */
async function openInNode(bytes: Uint8Array, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const base = fileURLToPath(
    new URL("../node_modules/pdfjs-dist/", import.meta.url),
  );
  const task = pdfjs.getDocument({
    // A copy every time: getDocument transfers the buffer and leaves the
    // caller's view detached, so a second inspection of the same PDF would
    // otherwise blow up inside the worker port.
    data: bytes.slice(),
    password,
    useSystemFonts: false,
    standardFontDataUrl: base + "standard_fonts/",
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
  });
  return { task, doc: await task.promise };
}

/**
 * Extract text per page with pdf.js, exactly as a viewer or `pdftotext` would.
 * This is the assertion the product claim rests on: after redaction there must
 * be nothing here to find.
 */
export async function extractText(bytes: Uint8Array): Promise<string[]> {
  const { task, doc } = await openInNode(bytes);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join("")
        .trim(),
    );
  }
  await task.destroy();
  return pages;
}

/** How many text-drawing items each page holds. Zero proves rasterisation. */
export async function countTextItems(bytes: Uint8Array): Promise<number[]> {
  const { task, doc } = await openInNode(bytes);
  const counts: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    counts.push((await (await doc.getPage(i)).getTextContent()).items.length);
  }
  await task.destroy();
  return counts;
}

/**
 * Pull the embedded page rasters back out of an exported PDF, in page order.
 *
 * Decoding them is left to the browser (see sampleRect in the specs) — it has
 * a JPEG decoder and a canvas already, which keeps this dependency-free.
 */
export async function extractPageImages(
  bytes: Uint8Array,
): Promise<Uint8Array[]> {
  const { PDFDocument, PDFName, PDFDict, PDFRawStream } =
    await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const images: Uint8Array[] = [];
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) continue;
    for (const [, ref] of xobjects.entries()) {
      const stream = doc.context.lookup(ref);
      if (
        stream instanceof PDFRawStream &&
        stream.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")
      ) {
        images.push(stream.getContents());
        break; // one full-bleed raster per page
      }
    }
  }
  return images;
}

// ---- Image fixture -----------------------------------------------------

/**
 * A minimal RGBA PNG, written by hand so the tests can assert on exact pixel
 * values without pulling in an image library.
 *
 * The canvas is white, with a saturated block filling SECRET_RECT (which the
 * redaction must turn black) and another filling CONTROL_RECT (which it must
 * leave alone).
 */
export function makeTestPng(width = 800, height = 1000): Uint8Array {
  const px = new Uint8Array(width * height * 4).fill(255); // opaque white
  const fill = (
    r: { x: number; y: number; w: number; h: number },
    rgb: [number, number, number],
  ) => {
    for (
      let y = Math.round(r.y * height);
      y < Math.round((r.y + r.h) * height);
      y++
    ) {
      for (
        let x = Math.round(r.x * width);
        x < Math.round((r.x + r.w) * width);
        x++
      ) {
        const i = (y * width + x) * 4;
        px[i] = rgb[0];
        px[i + 1] = rgb[1];
        px[i + 2] = rgb[2];
      }
    }
  };
  fill(SECRET_RECT, [255, 235, 0]); // bright yellow — must end up black
  fill(CONTROL_RECT, [0, 200, 255]); // bright cyan — must survive untouched

  // Scanlines, each prefixed with filter type 0 (None).
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      px.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }

  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + type.length + data.length + 4);
    const view = new DataView(body.buffer);
    view.setUint32(0, data.length);
    body.set(latin1(type), 4);
    body.set(data, 8);
    view.setUint32(
      body.length - 4,
      crc32(Buffer.from(body.subarray(4, body.length - 4))),
    );
    return body;
  };

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// -----------------------------------------------------------------------
// Form fixtures, for /flatten-pdf/.
//
// The two flatten modes make opposite promises, so the fixture has to make both
// checkable from one document: rasterising must turn the field's VALUE into
// pixels and leave no text at all, while form-flattening must turn that same
// value into real extractable text.
//
// Note the value deliberately does NOT appear in the page's text content before
// flattening — it lives in the widget's appearance stream. That is what lets a
// test prove the crisp mode actually baked something in, rather than the value
// having been ordinary page text all along.
// -----------------------------------------------------------------------

/** The value typed into makeFormPdf's visible field. */
export const FORM_VALUE = "FORM-VALUE-98765";

/** The value in the field makeFormPdf hides when asked to. */
export const HIDDEN_VALUE = "HIDDEN-FIELD-54321";

/** Where the visible field sits, normalised (0–1, top-left origin). */
export const FIELD_RECT = { x: 0.1, y: 0.3, w: 0.5, h: 0.05 };

/**
 * Build a two-page PDF carrying a filled-in form field.
 *
 * Page 1 is A4 portrait and holds the field; page 2 is A4 landscape, so that
 * "page sizes and orientation are preserved" is a real assertion rather than a
 * tautology about a document where every page is the same shape.
 *
 * The field is drawn with no border and a white background on purpose: the only
 * dark pixels inside FIELD_RECT are then the value's own glyphs, so sampling
 * that rect in a rasterised page tests that the VALUE was baked in rather than
 * that a widget border was.
 */
export async function makeFormPdf(
  opts: { hidden?: boolean } = {},
): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFNumber, StandardFonts, rgb } =
    await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Application form. Body text, nothing sensitive.", {
    x: 72,
    y: PAGE_H - 0.65 * PAGE_H,
    size: 12,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  // Landscape, to catch an export that normalises every page to portrait.
  const landscape = doc.addPage([PAGE_H, PAGE_W]);
  landscape.drawText("Continuation page, landscape.", {
    x: 72,
    y: PAGE_W - 0.5 * PAGE_W,
    size: 12,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });

  const form = doc.getForm();
  const field = form.createTextField("applicant.name");
  field.setText(FORM_VALUE);
  field.addToPage(page, {
    x: FIELD_RECT.x * PAGE_W,
    // pdf-lib measures from the bottom-left; FIELD_RECT is top-left.
    y: PAGE_H * (1 - FIELD_RECT.y - FIELD_RECT.h),
    width: FIELD_RECT.w * PAGE_W,
    height: FIELD_RECT.h * PAGE_H,
    borderWidth: 0,
    borderColor: rgb(1, 1, 1),
    backgroundColor: rgb(1, 1, 1),
    font,
  });
  // After addToPage, which is what creates the /DA entry this needs. Saving
  // regenerates the appearance stream at the new size.
  field.setFontSize(16);

  if (opts.hidden) {
    // A field flagged HIDDEN (/F bit 2). pdf.js honours the flag and leaves it
    // off the rendered page; pdf-lib's flatten() ignores it and would draw the
    // value in. /flatten-pdf/ has to refuse crisp mode rather than leak it.
    const secret = form.createTextField("applicant.hidden");
    secret.setText(HIDDEN_VALUE);
    secret.addToPage(page, {
      x: FIELD_RECT.x * PAGE_W,
      y: PAGE_H * 0.5,
      width: FIELD_RECT.w * PAGE_W,
      height: FIELD_RECT.h * PAGE_H,
      borderWidth: 0,
      borderColor: rgb(1, 1, 1),
      backgroundColor: rgb(1, 1, 1),
      font,
    });
    for (const widget of secret.acroField.getWidgets()) {
      widget.dict.set(PDFName.of("F"), PDFNumber.of(2));
    }
  }

  return doc.save();
}

/**
 * Count the terminal form fields in a PDF — the ones a flatten would act on.
 *
 * Entries without a type are the non-terminal parents of a dotted field name
 * ("applicant" for "applicant.name"); counting them would overstate the total.
 */
export async function countFormFields(bytes: Uint8Array): Promise<number> {
  const { task, doc } = await openInNode(bytes);
  const objects = (await doc.getFieldObjects()) as Record<
    string,
    { type?: string }[]
  > | null;
  let n = 0;
  if (objects) {
    for (const list of Object.values(objects)) {
      for (const f of list) if (f.type) n++;
    }
  }
  await task.destroy();
  return n;
}

/** Each page's size in points, with /Rotate applied — i.e. as displayed. */
export async function pageSizes(
  bytes: Uint8Array,
): Promise<{ w: number; h: number }[]> {
  const { task, doc } = await openInNode(bytes);
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: Math.round(vp.width), h: Math.round(vp.height) });
  }
  await task.destroy();
  return sizes;
}

// -----------------------------------------------------------------------
// Fixtures for /sign-pdf/.
//
// The thing to prove is WHERE a signature lands and that the page underneath is
// untouched, on the documents where getting that wrong is easiest: rotated
// pages and pages whose visible area does not start at the origin. So the page
// is tinted edge to edge (a stamp with a white box around it would show against
// it), carries one line of real text in the middle (so "the text survived" is a
// real assertion, and nothing but the signature can be dark in a corner), and
// can be rotated, cropped, or left with an unbalanced graphics state.
// -----------------------------------------------------------------------

/** The page tint's luma (Rec. 601), which sampled blank page should match. */
export const PLACEMENT_LUMA = 198;

export interface PlacementPdfOptions {
  pages?: number;
  /** /Rotate, clockwise, as a viewer displays it. */
  rotate?: 0 | 90 | 180 | 270;
  /** [x0, y0, x1, y1] in user space; the MediaBox stays the full A4. */
  cropBox?: [number, number, number, number];
  /** Leave a stray `q` and a translate open at the end of the page content. */
  unbalanced?: boolean;
}

/** Text in the middle of page n, for extraction checks. */
export const placementText = (n: number) => `PLACEMENT-TEXT-PAGE-${n}`;

export async function makePlacementPdf(
  opts: PlacementPdfOptions = {},
): Promise<Uint8Array> {
  const {
    PDFDocument,
    StandardFonts,
    degrees,
    rgb,
    pushGraphicsState,
    concatTransformationMatrix,
  } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 1); i++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_W,
      height: PAGE_H,
      color: rgb(1, 0.745, 0.353),
    });
    page.drawText(placementText(i + 1), {
      x: 215,
      y: 420,
      size: 16,
      font,
      color: rgb(0, 0, 0),
    });
    if (opts.cropBox) {
      const [x0, y0, x1, y1] = opts.cropBox;
      page.setCropBox(x0, y0, x1 - x0, y1 - y0);
    }
    if (opts.rotate) page.setRotation(degrees(opts.rotate));
    if (opts.unbalanced) {
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(1, 0, 0, 1, 120, -90),
      );
    }
  }
  return doc.save();
}

/**
 * A 400×160 signature stand-in: a black diagonal band from bottom-left to
 * top-right, so the other two corners of its bounding box are empty. Placed on
 * a tinted page, those empty corners must show the tint, which is what proves
 * the image went down with its transparency intact.
 *
 * `opaque` paints the empty area white instead of leaving it transparent, which
 * is what a photographed signature looks like before "remove white background".
 */
export function makeSignaturePng(opts: { opaque?: boolean } = {}): Uint8Array {
  const w = 400;
  const h = 160;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const onBand = Math.abs(y - h * (1 - x / w)) < 9;
      if (onBand) {
        px[i + 3] = 255; // opaque black
      } else if (opts.opaque) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255;
      }
    }
  }
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + type.length + data.length + 4);
    const view = new DataView(body.buffer);
    view.setUint32(0, data.length);
    body.set(latin1(type), 4);
    body.set(data, 8);
    view.setUint32(
      body.length - 4,
      crc32(Buffer.from(body.subarray(4, body.length - 4))),
    );
    return body;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * How many images each page paints, from pdf.js's operator list. This counts
 * placements (a signature stamped twice paints twice), where the number of
 * image objects in the file counts how many times the picture is STORED.
 */
export async function countPaintedImages(bytes: Uint8Array): Promise<number[]> {
  const { task, doc } = await openInNode(bytes);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const painted = new Set<number>([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
  ]);
  const counts: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const ops = await (await doc.getPage(i)).getOperatorList();
    counts.push(ops.fnArray.filter((fn: number) => painted.has(fn)).length);
  }
  await task.destroy();
  return counts;
}

/** Image objects stored in the file (a PNG with transparency is two: image + mask). */
export async function countImageObjects(bytes: Uint8Array): Promise<number> {
  const { PDFDocument, PDFName, PDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")
    )
      n++;
  }
  return n;
}

// ---- Real encryption, via qpdf --------------------------------------------
//
// makeEncryptedPdf() above is hand-rolled RC4-40, the oldest scheme. Real
// files mostly use AES, and editing restrictions need an owner password that
// differs from the user's. The app itself ships qpdf for /sign-pdf/, so the
// tests use that same build to make (and inspect) such files.

type QpdfNode = {
  callMain(args: string[]): number;
  FS: {
    writeFile(p: string, d: Uint8Array): void;
    readFile(p: string): Uint8Array;
  };
};
let qpdfNode: Promise<QpdfNode> | null = null;
let qpdfSeq = 0;

async function qpdf(args: string[], input: Uint8Array) {
  qpdfNode ??= (async () => {
    const require = createRequire(import.meta.url);
    const create = require("@neslinesli93/qpdf-wasm") as (
      o: object,
    ) => Promise<QpdfNode>;
    const wasm = require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm");
    return create({
      locateFile: () => wasm,
      print: () => {},
      printErr: () => {},
    });
  })();
  const q = await qpdfNode;
  const n = ++qpdfSeq;
  q.FS.writeFile(`/in${n}.pdf`, input);
  const code = q.callMain(
    args.map((a) =>
      a.replace("$IN", `/in${n}.pdf`).replace("$OUT", `/out${n}.pdf`),
    ),
  );
  let out: Uint8Array | null = null;
  try {
    out = q.FS.readFile(`/out${n}.pdf`);
  } catch {
    /* no output for --check-style runs or failures */
  }
  return { code, out };
}

/**
 * AES-256 encrypt `bytes`. `user` "" makes a file that opens without a
 * password; `restrictEditing` turns off changing the page, annotating and
 * filling forms, which is what "Restrict editing" in a PDF editor sets.
 */
export async function encryptWithQpdf(
  bytes: Uint8Array,
  opts: { user: string; owner: string; restrictEditing?: boolean },
): Promise<Uint8Array> {
  const { code, out } = await qpdf(
    [
      "$IN",
      "--encrypt",
      `--user-password=${opts.user}`,
      `--owner-password=${opts.owner}`,
      "--bits=256",
      ...(opts.restrictEditing
        ? ["--modify=none", "--annotate=n", "--form=n"]
        : []),
      "--",
      "$OUT",
    ],
    bytes,
  );
  if (code !== 0 || !out) throw new Error(`qpdf --encrypt exit ${code}`);
  return out;
}

/** Decrypt with qpdf, or null if `password` doesn't open it. */
export async function decryptWithQpdf(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  const { code, out } = await qpdf(
    [`--password=${password}`, "--decrypt", "$IN", "$OUT"],
    bytes,
  );
  return code === 0 || code === 3 ? out : null;
}

/**
 * Is the file encrypted, whether or not it needs a password to open? Asked of
 * pdf.js, not qpdf: this qpdf build's --is-encrypted exits 2 ("not encrypted")
 * when the file needs a password it wasn't given.
 */
export async function isEncryptedFile(bytes: Uint8Array): Promise<boolean> {
  let opened: Awaited<ReturnType<typeof openInNode>>;
  try {
    opened = await openInNode(bytes);
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") return true;
    throw e;
  }
  const info = (await opened.doc.getMetadata()).info as {
    EncryptFilterName?: string | null;
  };
  await opened.task.destroy();
  return !!info?.EncryptFilterName;
}
