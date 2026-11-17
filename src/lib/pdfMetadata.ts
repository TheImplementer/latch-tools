// -----------------------------------------------------------------------
// What a PDF says about itself, and how to make it stop.
//
// Pure document logic: bytes in, findings or bytes out, no DOM. The widget
// (./removeMetadata) handles files, passwords and panels; this module only
// knows PDF structure, which keeps it testable and keeps the two concerns from
// tangling.
//
// The same inspect() runs twice: once on the user's file, to show what is in
// it, and once on our own output, to prove what we said we removed is gone.
// The second run is the safety net. A clean that quietly misses something is
// the one failure this tool cannot be allowed, so a non-empty re-inspection is
// an error, not a warning.
//
// Categories, and why each is here:
//
//   props        The Info dictionary and the XMP packet: author, the app and
//                the person's machine that made it, dates, and in XMP often an
//                edit history (xmpMM:History) listing every save.
//   history      Incremental updates. Most editors save by appending changes
//                to the end of the file, so the previous version of everything
//                that changed (an old title, a deleted page, text that was
//                "removed") is still in the bytes. pdf-lib reads the whole
//                body and keeps only the last definition of each object, and
//                collect() below drops anything no longer reachable, so a
//                cleaned file has exactly one version. Always on: there is no
//                way to rewrite the file and keep it.
//   comments     Markup annotations record who wrote them (/T) and when.
//                The comments themselves stay; the names and times go.
//   photos       JPEG images are stored in a PDF byte-for-byte, so a photo
//                dropped into a document keeps its camera EXIF, including GPS.
//                Only the metadata segments are removed; pixels are untouched.
//   attachments  Embedded files, including whole spreadsheets behind a chart.
//   scripts      JavaScript and automatic actions. Not metadata, but hidden
//                content that runs when the file is opened.
//   appData      /PieceInfo (an editing app's private copy of its own data,
//                which for some apps is the whole original artwork), page
//                thumbnails (which can show an earlier version of the page),
//                and per-object /Metadata and /LastModified.
//   id           The trailer /ID, a fixed identifier that links copies of the
//                same document. Replaced with a random one when the file is
//                not encrypted (an encrypted file's ID is part of its key).
// -----------------------------------------------------------------------

import type {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRef,
} from "pdf-lib";

type Lib = typeof import("pdf-lib");

export type Category =
  | "props"
  | "comments"
  | "photos"
  | "attachments"
  | "scripts"
  | "appData";

export const CATEGORIES: Category[] = [
  "props",
  "comments",
  "photos",
  "attachments",
  "scripts",
  "appData",
];

export interface Findings {
  /** Human-readable document properties, Info and XMP merged. */
  props: { label: string; value: string }[];
  /** Bytes of XMP on the catalog, 0 if none. */
  xmpBytes: number;
  /** Entries in the XMP edit history. */
  historyEntries: number;
  /** The XMP claims PDF/A conformance, which requires XMP. */
  pdfa: boolean;
  /** Saves appended on top of the original (incremental updates). */
  updates: number;
  /** Objects nothing refers to any more: leftovers of earlier versions. */
  orphans: number;
  comments: { count: number; authors: string[] };
  photos: { withDetails: number; withGps: number; cameras: string[] };
  attachments: string[];
  scripts: number;
  appData: { pieceInfo: number; thumbnails: number; objectMetadata: number };
  hasId: boolean;
  /** A certificate-based signature, which no rewritten copy can keep valid. */
  certSigned: boolean;
}

/** Is there anything at all in this category? */
export function has(f: Findings, c: Category): boolean {
  switch (c) {
    case "props":
      return f.props.length > 0 || f.xmpBytes > 0;
    case "comments":
      return f.comments.authors.length > 0;
    case "photos":
      return f.photos.withDetails > 0;
    case "attachments":
      return f.attachments.length > 0;
    case "scripts":
      return f.scripts > 0;
    case "appData":
      return (
        f.appData.pieceInfo + f.appData.thumbnails + f.appData.objectMetadata >
        0
      );
  }
}

/** Markup annotations: the ones whose /T is an author rather than a field name. */
const MARKUP = new Set([
  "Text",
  "FreeText",
  "Line",
  "Square",
  "Circle",
  "Polygon",
  "PolyLine",
  "Highlight",
  "Underline",
  "Squiggly",
  "StrikeOut",
  "Stamp",
  "Caret",
  "Ink",
  "FileAttachment",
  "Sound",
  "Redact",
]);

const INFO_LABELS: Record<string, string> = {
  Title: "Title",
  Author: "Author",
  Subject: "Subject",
  Keywords: "Keywords",
  Creator: "Made with",
  Producer: "Converted by",
  CreationDate: "Created",
  ModDate: "Last changed",
};

// ---- Small helpers ---------------------------------------------------------

function nameOf(lib: Lib, o: PDFObject | undefined): string | undefined {
  return o instanceof lib.PDFName ? o.decodeText() : undefined;
}

function textOf(lib: Lib, o: PDFObject | undefined): string | undefined {
  if (o instanceof lib.PDFString || o instanceof lib.PDFHexString) {
    try {
      return o.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function dateOf(lib: Lib, o: PDFObject | undefined): string | undefined {
  if (o instanceof lib.PDFString || o instanceof lib.PDFHexString) {
    try {
      const d = o.decodeDate();
      if (!isNaN(d.getTime())) return formatDate(d);
    } catch {
      /* fall through to the raw text */
    }
    return textOf(lib, o);
  }
  return undefined;
}

function formatDate(d: Date): string {
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dictOf(
  lib: Lib,
  ctx: PDFContext,
  o: PDFObject | undefined,
): PDFDict | undefined {
  const v = o instanceof lib.PDFRef ? ctx.lookup(o) : o;
  if (v instanceof lib.PDFDict) return v;
  if (v instanceof lib.PDFStream) return v.dict;
  return undefined;
}

function arrayOf(
  lib: Lib,
  ctx: PDFContext,
  o: PDFObject | undefined,
): PDFArray | undefined {
  const v = o instanceof lib.PDFRef ? ctx.lookup(o) : o;
  return v instanceof lib.PDFArray ? v : undefined;
}

function key(lib: Lib, k: string): PDFName {
  return lib.PDFName.of(k);
}

/**
 * Every dictionary in the document, direct or indirect, each exactly once.
 * Stream dictionaries are included and reported with their stream. With
 * `only`, indirect objects outside that set (leftovers) are skipped.
 */
function eachDict(
  lib: Lib,
  ctx: PDFContext,
  visit: (dict: PDFDict, stream?: PDFObject) => void,
  only?: Set<string>,
): void {
  const seen = new Set<PDFObject>();
  const walk = (o: PDFObject) => {
    if (seen.has(o)) return;
    seen.add(o);
    if (o instanceof lib.PDFStream) {
      visit(o.dict, o);
      for (const [, v] of o.dict.entries()) walk(v);
    } else if (o instanceof lib.PDFDict) {
      visit(o);
      for (const [, v] of o.entries()) walk(v);
    } else if (o instanceof lib.PDFArray) {
      for (let i = 0; i < o.size(); i++) walk(o.get(i));
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!only || only.has(ref.toString())) walk(obj);
  }
}

/** Objects reachable from the trailer. Everything else is a leftover. */
function reachable(lib: Lib, ctx: PDFContext): Set<string> {
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof lib.PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof lib.PDFStream) {
      for (const [, v] of o.dict.entries()) stack.push(v);
    } else if (o instanceof lib.PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof lib.PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    }
  }
  return seen;
}

/** Every unreachable object, including stale object and xref streams. */
function orphanRefs(lib: Lib, ctx: PDFContext): PDFRef[] {
  const live = reachable(lib, ctx);
  return ctx
    .enumerateIndirectObjects()
    .filter(([ref]) => !live.has(ref.toString()))
    .map(([ref]) => ref);
}

function countOrphans(lib: Lib, ctx: PDFContext): number {
  const live = reachable(lib, ctx);
  let n = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (live.has(ref.toString())) continue;
    if (obj instanceof lib.PDFStream) {
      const type = nameOf(lib, obj.dict.get(key(lib, "Type")));
      if (type === "XRef" || type === "ObjStm") continue;
    }
    n++;
  }
  return n;
}

function count(bytes: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0);
  let n = 0;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    n++;
  }
  return n;
}

/**
 * Saves appended on top of the first. Each save ends with its own startxref;
 * a linearized ("fast web view") file legitimately starts with two.
 */
function countUpdates(bytes: Uint8Array): number {
  const sections = count(bytes, "startxref");
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const base = /\/Linearized\b/.test(head) ? 2 : 1;
  return Math.max(0, sections - base);
}

// ---- XMP --------------------------------------------------------------------

function streamText(lib: Lib, stream: PDFObject): string {
  if (!(stream instanceof lib.PDFRawStream)) return "";
  try {
    const decoded = lib.decodePDFRawStream(stream).decode();
    return new TextDecoder("utf-8").decode(decoded);
  } catch {
    return "";
  }
}

/** The handful of XMP fields a person would recognise, plus the history size. */
function readXmp(xml: string) {
  const one = (tag: string): string | undefined => {
    // Either an element <tag>value</tag> (possibly wrapping an rdf list) or an
    // attribute tag="value" on rdf:Description.
    const el = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(
      xml,
    );
    if (el) {
      const li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(el[1]);
      const v = (li ? li[1] : el[1]).replace(/<[^>]+>/g, "").trim();
      if (v) return decodeEntities(v);
    }
    const at = new RegExp(`\\s${tag}="([^"]*)"`).exec(xml);
    return at && at[1].trim() ? decodeEntities(at[1].trim()) : undefined;
  };
  const history = /<xmpMM:History[\s\S]*?<\/xmpMM:History>/.exec(xml);
  const historyEntries = history
    ? (history[0].match(/<rdf:li[\s>]/g) ?? []).length
    : 0;
  return {
    title: one("dc:title"),
    author: one("dc:creator"),
    tool: one("xmp:CreatorTool"),
    producer: one("pdf:Producer"),
    created: one("xmp:CreateDate"),
    modified: one("xmp:ModifyDate"),
    historyEntries,
    pdfa: /pdfaid:part/.test(xml),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmpDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : formatDate(d);
}

// ---- JPEG -------------------------------------------------------------------

interface JpegMeta {
  /** Any segment we would strip: EXIF, XMP, IPTC, comments, maker data. */
  details: boolean;
  gps: boolean;
  camera?: string;
}

/** Segments that are pure metadata. ICC (in APP2) and Adobe (APP14) are not. */
function isMetaSegment(bytes: Uint8Array, at: number, marker: number): boolean {
  if (marker === 0xfe) return true; // COM
  if (marker === 0xe0 || marker === 0xee) return false; // JFIF, Adobe transform
  if (marker === 0xe2) {
    // APP2 carries the ICC colour profile, which changes how the image looks.
    // Other APP2 payloads (FlashPix, MPF) are camera extras.
    const sig = String.fromCharCode(...bytes.subarray(at + 4, at + 15));
    return sig !== "ICC_PROFILE";
  }
  return marker >= 0xe1 && marker <= 0xef;
}

/** Walk a JPEG's header segments up to the image data. */
function jpegSegments(
  bytes: Uint8Array,
): { at: number; end: number; marker: number }[] | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const segs: { at: number; end: number; marker: number }[] = [];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    let m = bytes[i + 1];
    // Fill bytes before a marker are legal.
    while (m === 0xff && i + 2 < bytes.length) {
      i++;
      m = bytes[i + 1];
    }
    if (m === 0xda || m === 0xd9) break; // start of scan / end of image
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > bytes.length) return null;
    segs.push({ at: i, end, marker: m });
    i = end;
  }
  return segs;
}

function readExif(bytes: Uint8Array, at: number, end: number) {
  // APP1: marker(2) len(2) "Exif\0\0"(6), then a TIFF structure.
  const tiff = at + 10;
  if (end - tiff < 8) return { gps: false };
  const sig = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  if (sig !== "Exif") return { gps: false };
  const le = bytes[tiff] === 0x49;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + tiff, end - tiff);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    let gps = false;
    const strings: Record<number, string> = {};
    for (let e = 0; e < n; e++) {
      const p = ifd + 2 + e * 12;
      const tag = u16(p);
      if (tag === 0x8825) {
        const g = u32(p + 8);
        gps = g > 0 && g + 2 <= dv.byteLength && u16(g) > 0;
      } else if (tag === 0x010f || tag === 0x0110) {
        const cnt = u32(p + 4);
        const off = cnt <= 4 ? p + 8 : u32(p + 8);
        if (off + cnt <= dv.byteLength) {
          strings[tag] = String.fromCharCode(
            ...new Uint8Array(dv.buffer, dv.byteOffset + off, cnt),
          )
            .replace(/\0+$/, "")
            .trim();
        }
      }
    }
    const make = strings[0x010f] ?? "";
    const model = strings[0x0110] ?? "";
    const camera = model.startsWith(make) ? model : `${make} ${model}`.trim();
    return { gps, camera: camera || undefined };
  } catch {
    return { gps: false };
  }
}

export function jpegMeta(bytes: Uint8Array): JpegMeta {
  const segs = jpegSegments(bytes);
  if (!segs) return { details: false, gps: false };
  let details = false;
  let gps = false;
  let camera: string | undefined;
  for (const s of segs) {
    if (!isMetaSegment(bytes, s.at, s.marker)) continue;
    details = true;
    if (s.marker === 0xe1) {
      const x = readExif(bytes, s.at, s.end);
      gps ||= x.gps;
      camera ??= x.camera;
    }
  }
  return { details, gps, camera };
}

/** The same JPEG without its metadata segments. Image data is copied as is. */
export function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const segs = jpegSegments(bytes);
  if (!segs) return null;
  const drop = segs.filter((s) => isMetaSegment(bytes, s.at, s.marker));
  if (!drop.length) return null;
  const removed = drop.reduce((n, s) => n + (s.end - s.at), 0);
  const out = new Uint8Array(bytes.length - removed);
  let w = 0;
  let r = 0;
  for (const s of drop) {
    out.set(bytes.subarray(r, s.at), w);
    w += s.at - r;
    r = s.end;
  }
  out.set(bytes.subarray(r), w);
  return out;
}

function isPlainJpeg(lib: Lib, ctx: PDFContext, dict: PDFDict): boolean {
  if (nameOf(lib, dict.get(key(lib, "Subtype"))) !== "Image") return false;
  const f = dict.get(key(lib, "Filter"));
  if (nameOf(lib, f) === "DCTDecode") return true;
  const arr = arrayOf(lib, ctx, f);
  return !!arr && arr.size() === 1 && nameOf(lib, arr.get(0)) === "DCTDecode";
}

// ---- Name trees -------------------------------------------------------------

function nameTreeLeaves(
  lib: Lib,
  ctx: PDFContext,
  root: PDFObject | undefined,
): { name: string; value: PDFObject }[] {
  const out: { name: string; value: PDFObject }[] = [];
  const seen = new Set<PDFDict>();
  const walk = (o: PDFObject | undefined) => {
    const d = dictOf(lib, ctx, o);
    if (!d || seen.has(d)) return;
    seen.add(d);
    const names = arrayOf(lib, ctx, d.get(key(lib, "Names")));
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        out.push({
          name: textOf(lib, names.get(i)) ?? "",
          value: names.get(i + 1),
        });
      }
    }
    const kids = arrayOf(lib, ctx, d.get(key(lib, "Kids")));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i));
  };
  walk(root);
  return out;
}

function fileSpecName(
  lib: Lib,
  ctx: PDFContext,
  spec: PDFObject | undefined,
  fallback: string,
): string {
  const d = dictOf(lib, ctx, spec);
  if (!d) return textOf(lib, spec) ?? fallback;
  return (
    textOf(lib, d.get(key(lib, "UF"))) ??
    textOf(lib, d.get(key(lib, "F"))) ??
    fallback
  );
}

function isJsAction(lib: Lib, ctx: PDFContext, o: PDFObject | undefined) {
  const d = dictOf(lib, ctx, o);
  return !!d && nameOf(lib, d.get(key(lib, "S"))) === "JavaScript";
}

// ---- Inspect ----------------------------------------------------------------

/**
 * What this document carries. `bytes` must be the file pdf-lib will read,
 * i.e. already decrypted.
 */
export async function inspect(bytes: Uint8Array): Promise<Findings> {
  const lib = await import("pdf-lib");
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  return inspectDoc(lib, doc, bytes);
}

function inspectDoc(lib: Lib, doc: PDFDocument, bytes: Uint8Array): Findings {
  const ctx = doc.context;
  const catalog = doc.catalog;

  // Properties: the Info dictionary first, then anything XMP adds.
  const props: { label: string; value: string }[] = [];
  const add = (label: string, value: string | undefined) => {
    if (!value) return;
    const v = value.length > 140 ? value.slice(0, 137) + "…" : value;
    if (props.some((p) => p.label === label && p.value === v)) return;
    props.push({ label, value: v });
  };
  const info = dictOf(lib, ctx, ctx.trailerInfo.Info);
  if (info) {
    for (const [k, v] of info.entries()) {
      const name = k.decodeText();
      const label = INFO_LABELS[name] ?? name;
      const value =
        name === "CreationDate" || name === "ModDate"
          ? dateOf(lib, v)
          : (textOf(lib, v) ?? nameOf(lib, v));
      add(label, value);
    }
  }
  let xmpBytes = 0;
  let historyEntries = 0;
  let pdfa = false;
  const xmpStream = (() => {
    const m = catalog.get(key(lib, "Metadata"));
    return m instanceof lib.PDFRef ? ctx.lookup(m) : m;
  })();
  if (xmpStream instanceof lib.PDFStream) {
    xmpBytes = xmpStream.getContentsSize();
    const x = readXmp(streamText(lib, xmpStream));
    add("Title", x.title);
    add("Author", x.author);
    add("Made with", x.tool);
    add("Converted by", x.producer);
    add("Created", xmpDate(x.created));
    add("Last changed", xmpDate(x.modified));
    historyEntries = x.historyEntries;
    pdfa = x.pdfa;
    if (historyEntries)
      add(
        "Edit history",
        `${historyEntries} recorded ${historyEntries === 1 ? "step" : "steps"}`,
      );
  }

  const comments = { count: 0, authors: [] as string[] };
  const photos = { withDetails: 0, withGps: 0, cameras: [] as string[] };
  const attachments: string[] = [];
  const appData = { pieceInfo: 0, thumbnails: 0, objectMetadata: 0 };
  let scripts = 0;

  const names = dictOf(lib, ctx, catalog.get(key(lib, "Names")));
  for (const leaf of nameTreeLeaves(
    lib,
    ctx,
    names?.get(key(lib, "EmbeddedFiles")),
  )) {
    attachments.push(fileSpecName(lib, ctx, leaf.value, leaf.name || "file"));
  }

  eachDict(
    lib,
    ctx,
    (d, stream) => {
      const subtype = nameOf(lib, d.get(key(lib, "Subtype")));
      // Comment authorship.
      if (subtype && MARKUP.has(subtype) && d.has(key(lib, "Rect"))) {
        const who = textOf(lib, d.get(key(lib, "T")));
        if (who !== undefined || d.has(key(lib, "M"))) comments.count++;
        if (who && !comments.authors.includes(who)) comments.authors.push(who);
        if (subtype === "FileAttachment")
          attachments.push(
            fileSpecName(lib, ctx, d.get(key(lib, "FS")), "attached file"),
          );
      }
      // Scripts: every JavaScript action, wherever it hangs (document-level name
      // tree values, OpenAction, links, form-field and page actions).
      if (nameOf(lib, d.get(key(lib, "S"))) === "JavaScript") scripts++;
      // Hidden app data.
      if (d.has(key(lib, "PieceInfo"))) appData.pieceInfo++;
      if (d.has(key(lib, "Thumb"))) appData.thumbnails++;
      if (d !== catalog && d.has(key(lib, "Metadata")))
        appData.objectMetadata++;
      // Photos.
      if (stream instanceof lib.PDFRawStream && isPlainJpeg(lib, ctx, d)) {
        const m = jpegMeta(stream.getContents());
        if (m.details) photos.withDetails++;
        if (m.gps) photos.withGps++;
        if (m.camera && !photos.cameras.includes(m.camera))
          photos.cameras.push(m.camera);
      }
      // Leftovers of earlier versions are reported as history, not here: the
      // counts describe the document as a viewer would show it.
    },
    reachable(lib, ctx),
  );

  return {
    props,
    xmpBytes,
    historyEntries,
    pdfa,
    updates: countUpdates(bytes),
    orphans: countOrphans(lib, ctx),
    comments,
    photos,
    attachments,
    scripts,
    appData,
    hasId: !!ctx.trailerInfo.ID,
    certSigned: count(bytes, "/ByteRange") > 0,
  };
}

// ---- Clean ------------------------------------------------------------------

export interface CleanOptions {
  remove: Set<Category>;
  /** Replace the trailer /ID. Off for files that will be re-encrypted. */
  newId: boolean;
}

export interface CleanResult {
  bytes: Uint8Array;
  /** Re-inspection of the output. */
  after: Findings;
}

/** Thrown when the output still holds something it was asked to lose. */
export class CleanIncompleteError extends Error {
  readonly left: string[];
  constructor(left: string[]) {
    super(`not removed: ${left.join(", ")}`);
    this.left = left;
    this.name = "CleanIncompleteError";
  }
}

export async function clean(
  bytes: Uint8Array,
  opts: CleanOptions,
): Promise<CleanResult> {
  const lib = await import("pdf-lib");
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const catalog = doc.catalog;
  const k = (s: string) => key(lib, s);
  const on = (c: Category) => opts.remove.has(c);

  if (on("props")) {
    ctx.trailerInfo.Info = undefined;
    catalog.delete(k("Metadata"));
  }

  if (on("attachments") || on("scripts")) {
    const names = dictOf(lib, ctx, catalog.get(k("Names")));
    if (names) {
      if (on("attachments")) names.delete(k("EmbeddedFiles"));
      if (on("scripts")) names.delete(k("JavaScript"));
    }
  }
  if (on("attachments")) {
    // PDF 2.0 / PDF/A-3 "associated files" hang off the catalog and pages.
    catalog.delete(k("AF"));
  }
  if (on("scripts") && isJsAction(lib, ctx, catalog.get(k("OpenAction")))) {
    catalog.delete(k("OpenAction"));
  }

  // Page /Annots arrays lose their FileAttachment annotations.
  if (on("attachments")) {
    for (const page of doc.getPages()) {
      const annots = arrayOf(lib, ctx, page.node.get(k("Annots")));
      if (!annots) continue;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const a = dictOf(lib, ctx, annots.get(i));
        if (a && nameOf(lib, a.get(k("Subtype"))) === "FileAttachment") {
          annots.remove(i);
        }
      }
      page.node.delete(k("AF"));
    }
  }

  const replacements: { ref: PDFRef; dict: PDFDict; bytes: Uint8Array }[] = [];
  const refOf = new Map<PDFObject, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) refOf.set(obj, ref);

  eachDict(lib, ctx, (d, stream) => {
    const subtype = nameOf(lib, d.get(k("Subtype")));
    if (on("comments") && subtype && MARKUP.has(subtype) && d.has(k("Rect"))) {
      d.delete(k("T"));
      d.delete(k("M"));
      d.delete(k("CreationDate"));
    }
    if (on("scripts")) {
      d.delete(k("AA"));
      if (isJsAction(lib, ctx, d.get(k("A")))) d.delete(k("A"));
    }
    if (on("attachments")) d.delete(k("AF"));
    if (on("appData")) {
      d.delete(k("PieceInfo"));
      d.delete(k("Thumb"));
      d.delete(k("LastModified"));
      if (d !== catalog) d.delete(k("Metadata"));
    }
    if (
      on("photos") &&
      stream instanceof lib.PDFRawStream &&
      isPlainJpeg(lib, ctx, d)
    ) {
      const stripped = stripJpeg(stream.getContents());
      const ref = refOf.get(stream);
      if (stripped && ref) replacements.push({ ref, dict: d, bytes: stripped });
    }
  });
  for (const r of replacements) {
    // A new stream object: PDFRawStream's contents are fixed at construction.
    // /Length is recomputed from the contents when the file is written.
    ctx.assign(r.ref, lib.PDFRawStream.of(r.dict, r.bytes));
  }

  // Drop everything nothing points at any more: old versions, removed
  // attachments' streams, the XMP we just unhooked.
  for (const ref of orphanRefs(lib, ctx)) ctx.delete(ref);

  if (opts.newId) {
    const rnd = () => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    };
    const id = rnd();
    // Both halves equal: by the spec's convention, a file never modified since
    // it was created. Nothing ties it to the file it came from.
    ctx.trailerInfo.ID = ctx.obj([
      lib.PDFHexString.of(id),
      lib.PDFHexString.of(id),
    ]);
  }

  const out = await doc.save({ updateFieldAppearances: false });
  const after = await inspect(out);

  const left: string[] = [];
  for (const c of opts.remove) if (has(after, c)) left.push(c);
  if (after.updates > 0) left.push("history");
  if (after.orphans > 0) left.push("orphans");
  if (left.length) throw new CleanIncompleteError(left);

  return { bytes: out, after };
}
