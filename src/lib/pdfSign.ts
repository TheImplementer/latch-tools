// -----------------------------------------------------------------------
// Sign a PDF: one document in, one document out, with images stamped on it.
//
// The promise that shapes everything here is that the pages are NOT rebuilt.
// /redact-pdf/ and /flatten-pdf/'s thorough mode render every page to pixels,
// which is right for destroying text and wrong for a signed contract: the
// recipient wants text they can search and copy, at full sharpness. So export
// loads the original with pdf-lib and appends one image per signature to each
// page's own content, which leaves everything already on the page exactly as
// it was.
//
// pdf.js is used only to show the user the page they are signing. What they
// place on that preview is converted to PDF coordinates by ./signPlace, which
// knows about /Rotate and offset CropBoxes.
//
// What this is not: a certificate-based digital signature. It is a picture of
// a signature placed on a page, and the page and its copy say so.
//
// Weight: this controller loads on page ready, but pdf.js, pdf-lib, the
// signature maker and the handwriting fonts all arrive on demand: pdf.js when
// a file is opened, the signature maker when "Create signature" is pressed,
// the fonts when the Type tab opens, pdf-lib when the signed copy is built,
// and qpdf (./qpdf, ~440 KB of wasm) only when an encrypted file is opened.
//
// Encrypted files: pdf-lib can't read them, so qpdf removes the encryption as
// soon as the file is opened (failing at the door, not after the user has
// placed a signature), the signing works on that plain copy, and a file that
// needed a password to open is locked again with the same password on export.
// A file whose author restricted editing gets a warning the user must answer,
// then is signed anyway: the restriction is not carried over, and the warning
// and the done panel both say so.
// -----------------------------------------------------------------------

import type { PDFImage } from "pdf-lib";

import { createDropzone } from "./dropzone";
import {
  PdfOpenError,
  fitScale,
  openPdf,
  pageSize,
  renderPage,
  type OpenedPdf,
  type PdfDoc,
} from "./pdf";
import {
  MIN_W,
  createPlacementLayer,
  type Placed,
  type PlacementLayer,
  type SignAsset,
} from "./placement";
import {
  MAX_STAGE,
  THUMB,
  clamp,
  plural,
  raf,
  releaseCanvas,
  setFocus,
  type Rect,
} from "./regions";
import {
  heightFor,
  normaliseRotation,
  toDrawArgs,
  visibleBox,
} from "./signPlace";
import type { PngAsset, SignatureDialog } from "./signature";

/** One page of the loaded document. Holds no full-resolution pixels. */
interface Page {
  /** 1-based, as pdf.js numbers them. */
  n: number;
  /** Size in PDF points, with /Rotate already applied. */
  ptW: number;
  ptH: number;
  thumbUrl: string;
  items: Placed[];
}

type Panel =
  | "drop"
  | "password"
  | "restricted"
  | "editor"
  | "processing"
  | "done"
  | "error";

const MAX_SIZE_MB = 100;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
// Thumbnails for every page are rendered up front, and the whole file is held
// in memory, so this is a real ceiling. Stated in the drop-zone copy.
const MAX_PAGES = 150;
/** Longest side of the finished-document preview. */
const PREVIEW_PX = 520;

function formatBytes(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  q: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      type,
      q,
    );
  });
}

/**
 * Does the file contain a certificate-based digital signature?
 *
 * A signed PDF's signature dictionary carries a /ByteRange entry, which names
 * the exact byte spans of the file the signature covers. Saving a new copy
 * rewrites those bytes, so the old signature cannot verify afterwards, and it
 * is better to say so before the user signs than after. The dictionary has to
 * be stored uncompressed for the byte range to mean anything, so a plain scan
 * finds it. A false positive costs one extra sentence of warning.
 */
function hasCertificateSignature(bytes: Uint8Array): boolean {
  const needle = "/ByteRange";
  const first = needle.charCodeAt(0);
  const limit = bytes.length - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/** pdf-lib spells a rectangle {width, height}; signPlace.ts says {w, h}. */
function box(r: { x: number; y: number; width: number; height: number }) {
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/** pdf.js reports an encryption filter for any encrypted file, locked or not. */
async function isEncrypted(doc: PdfDoc): Promise<boolean> {
  try {
    const info = (await doc.getMetadata()).info as {
      EncryptFilterName?: string | null;
    };
    return !!info?.EncryptFilterName;
  } catch {
    // A metadata read that fails is not evidence of encryption. If the file
    // really is encrypted, building the signed copy fails and says so.
    return false;
  }
}

/**
 * Did the file's author turn off changing the page? pdf.js returns null when
 * nothing is restricted, otherwise the list of operations that ARE allowed.
 * Stamping a signature writes to the page's content, so MODIFY_CONTENTS is
 * the flag that matters; "fill in forms and sign" alone doesn't cover it.
 */
async function isEditRestricted(doc: PdfDoc): Promise<boolean> {
  try {
    const allowed = await doc.getPermissions();
    if (!allowed) return false;
    const { PermissionFlag } = await import("pdfjs-dist");
    return !allowed.includes(PermissionFlag.MODIFY_CONTENTS);
  } catch {
    return false;
  }
}

const UNLOCK_FAILED_TITLE = "This PDF's protection can't be removed here";
const UNLOCK_FAILED_MESSAGE =
  "It opened, but it uses a kind of protection this tool can't take off to add a signature. If you're allowed to, save an unprotected copy from the program you opened it in, then open that copy here.";

export function initPdfSignWidget(root: HTMLElement): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;

  // ---- Elements ----
  const panels: Record<Panel, HTMLElement> = {
    drop: q('[data-panel="drop"]'),
    password: q('[data-panel="password"]'),
    restricted: q('[data-panel="restricted"]'),
    editor: q('[data-panel="editor"]'),
    processing: q('[data-panel="processing"]'),
    done: q('[data-panel="done"]'),
    error: q('[data-panel="error"]'),
  };
  const dropzone = q('[data-el="dropzone"]');
  const fileInput = q<HTMLInputElement>('[data-el="file-input"]');
  const browseBtn = q('[data-el="browse-btn"]');
  const dzTitle = q('[data-el="dz-title"]');
  const widgetTitle = q('[data-el="widget-title"]');
  const stage = q<HTMLCanvasElement>('[data-el="stage"]');
  const stageWrap = q('[data-el="stage-wrap"]');
  const overlay = q('[data-el="overlay"]');
  const strip = q('[data-el="filmstrip"]');
  const fileMeta = q('[data-el="file-meta"]');
  const editorHint = q('[data-el="editor-hint"]');
  const certNote = q('[data-el="cert-note"]');
  const sigPreview = q('[data-el="sig-preview"]');
  const createBtn = q<HTMLButtonElement>('[data-el="create-btn"]');
  const createLabel = q('[data-el="create-label"]');
  const addSigBtn = q<HTMLButtonElement>('[data-el="add-sig-btn"]');
  const textInput = q<HTMLInputElement>('[data-el="text-input"]');
  const addTextBtn = q<HTMLButtonElement>('[data-el="add-text-btn"]');
  const dateBtn = q<HTMLButtonElement>('[data-el="date-btn"]');
  const removeBtn = q<HTMLButtonElement>('[data-el="remove-btn"]');
  const copyAllBtn = q<HTMLButtonElement>('[data-el="copy-all-btn"]');
  const clearBtn = q<HTMLButtonElement>('[data-el="clear-btn"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const applyLabelEl = q('[data-el="apply-label"]');
  const procTitle = q('[data-el="proc-title"]');
  const procSub = q('[data-el="proc-sub"]');
  const donePreview = q('[data-el="done-preview"]');
  const doneTitle = q('[data-el="done-title"]');
  const doneSub = q('[data-el="done-sub"]');
  const downloadBtn = q('[data-el="download-btn"]');
  const anotherBtn = q('[data-el="another-btn"]');
  const keepEditingBtn = q('[data-el="keep-editing-btn"]');
  const pwForm = q<HTMLFormElement>('[data-el="pw-form"]');
  const pwInput = q<HTMLInputElement>('[data-el="pw-input"]');
  const pwMessage = q('[data-el="pw-message"]');
  const pwCancelBtn = q<HTMLButtonElement>('[data-el="pw-cancel"]');
  const restrictedContinueBtn = q<HTMLButtonElement>(
    '[data-el="restricted-continue"]',
  );
  const restrictedCancelBtn = q<HTMLButtonElement>(
    '[data-el="restricted-cancel"]',
  );
  const errTitle = q('[data-el="err-title"]');
  const errMessage = q('[data-el="err-message"]');
  // The editor and the error panel both offer a way back to the start.
  const startOverBtns = root.querySelectorAll<HTMLButtonElement>(
    '[data-el="try-another-btn"]',
  );

  const initialTitle = widgetTitle.textContent?.trim() || "Sign a PDF";

  // ---- State ----
  let opened: OpenedPdf | null = null;
  let sourceFile: File | null = null;
  let pages: Page[] = [];
  let active = -1;
  let renderToken = 0;
  let signature: SignAsset | null = null;
  let assets: SignAsset[] = [];
  let seq = 0;
  let certSigned = false;
  /**
   * Set when the opened file was encrypted. `plain` is the decrypted copy that
   * export signs; `password` is what it took to open ("" if it opened without
   * one), and a non-empty one is put back on the signed copy. Both live only
   * in memory and are dropped on reset.
   */
  let lock: {
    plain: Uint8Array;
    password: string;
    restricted: boolean;
  } | null = null;
  /** A file waiting on the restriction warning, between open and editor. */
  let pending: { doc: OpenedPdf; bytes: Uint8Array } | null = null;
  let result: {
    blob: Blob;
    name: string;
    count: number;
    marked: number;
  } | null = null;
  let doneUrl: string | null = null;
  let busy = false;
  let previewPage = 1;
  let dialog: SignatureDialog | null = null;
  let signatureMod: typeof import("./signature") | null = null;

  const items = (): Placed[] =>
    active >= 0 && pages[active] ? pages[active].items : [];
  const totalItems = () => pages.reduce((n, p) => n + p.items.length, 0);
  const markedPages = () => pages.filter((p) => p.items.length > 0).length;

  function showPanel(name: Panel, scroll = false) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
    setFocus(root, name === "editor", scroll);
  }

  const layer: PlacementLayer = createPlacementLayer({
    wrap: stageWrap,
    stage,
    overlay,
    getItems: items,
    describe: (it, i) => {
      const where = pages.length > 1 ? ` on page ${active + 1}` : "";
      return `${it.asset.kind === "signature" ? "Signature" : `Text "${it.asset.label}"`} ${i + 1}${where}. Arrow keys move it, plus and minus resize it, Delete removes it.`;
    },
    onChange: (kind) => {
      updateHint();
      if (kind === "commit") renderStrip();
    },
    onRemove: (id) => removeItem(id),
  });

  // ---- Copy ----
  function updateHint(note?: string) {
    const n = items().length;
    const where = pages.length > 1 ? ` on page ${active + 1}` : "";
    let hint: string;
    if (!signature && totalItems() === 0) {
      hint =
        "Create a signature, then drag it to where it belongs on the page. You can add more than one, and put them on any page.";
    } else if (n === 0) {
      hint =
        pages.length > 1
          ? `Nothing placed${where} yet. Press Add to page, or choose another page from the strip.`
          : "Press Add to page, then drag the signature into place.";
    } else {
      hint = `${plural(n, "item")}${where}. Drag to move, drag a corner to resize, or select one and press Delete to remove it.`;
    }
    editorHint.textContent = note ?? hint;
    syncControls();
  }

  function syncControls() {
    const n = items().length;
    const hasSel = layer.selectedId() !== null;
    removeBtn.disabled = !hasSel;
    clearBtn.disabled = n === 0;
    copyAllBtn.hidden = pages.length < 2;
    copyAllBtn.disabled = !hasSel || pages.length < 2;
    addSigBtn.disabled = !signature;
    addSigBtn.hidden = !signature;
    createLabel.textContent = signature ? "New signature" : "Create signature";
    createBtn.classList.toggle("btn-primary", !signature);
    createBtn.classList.toggle("btn-secondary", !!signature);
    addTextBtn.disabled = textInput.value.trim().length === 0;
    applyBtn.disabled = totalItems() === 0 || busy;
    const base = applyLabelEl.dataset.base ?? "Sign & download";
    const marked = markedPages();
    applyLabelEl.textContent =
      pages.length > 1 && marked > 0
        ? `${base} (${marked}/${pages.length})`
        : base;
  }

  function setTitle() {
    widgetTitle.textContent =
      pages.length > 1
        ? `Page ${active + 1} of ${pages.length}`
        : "Place your signature";
  }

  // ---- Page strip ----
  function renderStrip() {
    strip.hidden = pages.length < 2;
    strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
    if (pages.length < 2) return;
    pages.forEach((pg, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "strip-item" + (i === active ? " is-active" : "");
      btn.dataset.thumb = String(i);
      btn.setAttribute(
        "aria-label",
        `Page ${i + 1} of ${pages.length}${pg.items.length ? `, ${plural(pg.items.length, "item")} placed` : ", nothing placed"}`,
      );
      if (i === active) btn.setAttribute("aria-current", "true");
      if (pg.thumbUrl) {
        const img = document.createElement("img");
        img.src = pg.thumbUrl;
        img.alt = "";
        img.decoding = "async";
        btn.appendChild(img);
      }
      const num = document.createElement("span");
      num.className = "strip-page";
      num.textContent = String(i + 1);
      num.setAttribute("aria-hidden", "true");
      btn.appendChild(num);
      if (pg.items.length) {
        const badge = document.createElement("span");
        badge.className = "strip-badge";
        badge.textContent = String(pg.items.length);
        badge.setAttribute("aria-hidden", "true");
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        if (i !== active) void setActive(i);
      });
      strip.appendChild(btn);
    });
  }

  // ---- Intake ----
  function isPdf(f: File): boolean {
    return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  }

  async function acceptFile(file: File) {
    if (!isPdf(file)) {
      showError(
        "That isn't a PDF",
        "Please choose a PDF file. To sign a photo or a scan saved as an image, turn it into a PDF first.",
      );
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      showError(
        "That PDF is too large",
        `${file.name} is ${formatBytes(file.size)}. This tool handles files up to ${MAX_SIZE_MB} MB, because the whole document has to fit in your browser's memory.`,
      );
      return;
    }
    sourceFile = file;
    await openAndBuild();
  }

  /**
   * Open the stored file and, if it is encrypted, unlock it for pdf-lib.
   *
   * `password` only arrives on a retry from the password panel. The bytes are
   * re-read from the File every time, because pdf.js transfers (detaches) the
   * buffer it is given.
   */
  async function openAndBuild(password?: string) {
    if (!sourceFile) return;
    procTitle.textContent = "Opening your PDF";
    procSub.textContent = "Reading the pages…";
    widgetTitle.textContent = "Opening…";
    showPanel("processing");
    await raf();

    await releaseDoc();
    let next: OpenedPdf;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await sourceFile.arrayBuffer());
      next = await openPdf(bytes, password);
    } catch (e) {
      handleOpenFailure(e);
      return;
    }

    if (next.doc.numPages > MAX_PAGES) {
      await next.close();
      showError(
        "That document has too many pages",
        `It has ${next.doc.numPages} pages and this tool handles up to ${MAX_PAGES}. Split it first, then sign the part you need.`,
      );
      return;
    }

    // Unlocking happens here, at the door, rather than at export: if qpdf
    // can't do it, the user should hear so before placing anything. Note an
    // owner-password-only file opens in pdf.js without asking for anything, so
    // "encrypted" can't be inferred from whether a password was needed.
    if (await isEncrypted(next.doc)) {
      procSub.textContent = "Unlocking it in your browser…";
      try {
        const { decryptPdf } = await import("./qpdf");
        lock = {
          plain: await decryptPdf(bytes, password ?? ""),
          password: password ?? "",
          restricted: await isEditRestricted(next.doc),
        };
      } catch (e) {
        console.error("[sign-pdf] unlock failed", e);
        await next.close();
        showError(UNLOCK_FAILED_TITLE, UNLOCK_FAILED_MESSAGE);
        return;
      }
      if (lock.restricted) {
        pending = { doc: next, bytes };
        widgetTitle.textContent = "Before you sign";
        showPanel("restricted");
        restrictedContinueBtn.focus();
        return;
      }
    }
    await showEditor(next, bytes);
  }

  async function showEditor(next: OpenedPdf, bytes: Uint8Array) {
    if (!sourceFile) return;
    pending = null;
    opened = next;
    certSigned = hasCertificateSignature(bytes);
    try {
      await buildPages();
    } catch {
      showError(
        "We couldn't read that PDF",
        "The file opened but its pages could not be rendered. It may be damaged.",
      );
      return;
    }
    fileMeta.textContent = `${sourceFile.name} · ${formatBytes(sourceFile.size)} · ${plural(pages.length, "page")}`;
    certNote.hidden = !certSigned;
    await setActive(0);
    showPanel("editor", true);
  }

  function handleOpenFailure(e: unknown) {
    const reason = e instanceof PdfOpenError ? e.reason : "load";
    if (reason === "password" || reason === "wrong-password") {
      // Deliberately NOT showError(): needing a password is an ordinary state
      // of an ordinary file, and the error panel's only exit discards it.
      pwMessage.textContent =
        reason === "wrong-password"
          ? "That password didn't work. Check it and try again."
          : "Enter its password to open it. The password stays in your browser, and your signed copy is locked with the same one.";
      pwInput.value = "";
      widgetTitle.textContent = "Password needed";
      showPanel("password");
      pwInput.focus();
      return;
    }
    if (reason === "corrupt") {
      showError(
        "We couldn't open that PDF",
        "The file appears to be damaged or isn't a PDF. Try re-saving or re-exporting it, then open it here again.",
      );
      return;
    }
    showError(
      "We couldn't open that PDF",
      "Something went wrong while reading the file. Try again, or try a different PDF.",
    );
  }

  /** Render every page small, for the strip and to learn each page's size. */
  async function buildPages() {
    const doc = opened!.doc;
    pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { ptW, ptH } = pageSize(page);
      let thumbUrl = "";
      try {
        const canvas = await renderPage(page, fitScale(ptW, ptH, THUMB, 1));
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.7);
        releaseCanvas(canvas);
        thumbUrl = URL.createObjectURL(blob);
      } catch {
        // A page whose preview won't render still gets a strip entry.
        thumbUrl = "";
      }
      page.cleanup();
      pages.push({ n: i, ptW, ptH, thumbUrl, items: [] });
    }
  }

  /** Put one page on the stage at preview resolution. */
  async function setActive(i: number) {
    const pg = pages[i];
    if (!pg || !opened) return;
    const token = ++renderToken;
    active = i;
    layer.select(null);
    // The previous page's placements must not sit on top of the next page's
    // pixels while it renders.
    overlay.replaceChildren();
    const page = await opened.doc.getPage(pg.n);
    const canvas = await renderPage(page, fitScale(pg.ptW, pg.ptH, MAX_STAGE));
    page.cleanup();
    if (token !== renderToken) {
      releaseCanvas(canvas);
      return;
    }
    stage.width = canvas.width;
    stage.height = canvas.height;
    stage.style.aspectRatio = `${pg.ptW} / ${pg.ptH}`;
    stage.getContext("2d")!.drawImage(canvas, 0, 0);
    releaseCanvas(canvas);
    setTitle();
    renderStrip();
    layer.layout();
    layer.render();
    updateHint();
  }

  // ---- Placing ----
  function makeAsset(
    png: PngAsset,
    kind: SignAsset["kind"],
    label: string,
  ): SignAsset {
    const asset: SignAsset = {
      id: ++seq,
      url: URL.createObjectURL(png.blob),
      blob: png.blob,
      w: png.w,
      h: png.h,
      kind,
      label,
    };
    assets.push(asset);
    return asset;
  }

  /** A rectangle for `asset` on page `pg`, at the usual signing spot. */
  function defaultRect(asset: SignAsset, pg: Page, existing: Placed[]): Rect {
    let w = asset.kind === "signature" ? 0.3 : 0.24;
    let h = heightFor(w, asset.w, asset.h, pg.ptW, pg.ptH);
    // Tall artwork (a stacked initials mark, say) is limited by height instead.
    if (h > 0.18) {
      w = Math.max(MIN_W, (w * 0.18) / h);
      h = heightFor(w, asset.w, asset.h, pg.ptW, pg.ptH);
    }
    // Signatures sit lower right, where a signature line usually is; text goes
    // lower left, so a date does not land on top of the signature it belongs to.
    let x = asset.kind === "signature" ? 0.9 - w : 0.1;
    let y = 0.88 - h;
    // Placing the same thing twice should not stack the copies exactly.
    for (let tries = 0; tries < 8; tries++) {
      const clash = existing.some(
        (p) => Math.abs(p.rect.x - x) < 0.02 && Math.abs(p.rect.y - y) < 0.02,
      );
      if (!clash) break;
      y -= 0.07;
    }
    x = clamp(x, 0, 1 - w);
    y = clamp(y, 0, 1 - h);
    return { x, y, w, h };
  }

  function addPlacement(asset: SignAsset) {
    const pg = pages[active];
    if (!pg) return;
    const item: Placed = {
      id: ++seq,
      asset,
      rect: defaultRect(asset, pg, pg.items),
    };
    pg.items.push(item);
    layer.render();
    layer.select(item.id);
    // Below the two-column layout the page can be a screen away from the
    // button that was pressed. Only moves the screen if the item is off it.
    overlay
      .querySelector<HTMLElement>(`[data-sign-item="${item.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
    renderStrip();
    const what = asset.kind === "signature" ? "Signature" : `"${asset.label}"`;
    updateHint(
      `${what} added${pages.length > 1 ? ` to page ${active + 1}` : ""}. Drag it into place, and drag a corner to resize it.`,
    );
  }

  function removeItem(id: number) {
    const pg = pages[active];
    if (!pg) return;
    pg.items = pg.items.filter((p) => p.id !== id);
    layer.select(null);
    layer.render();
    renderStrip();
    updateHint("Removed.");
  }

  async function openCreator() {
    if (!dialog) {
      signatureMod = await import("./signature");
      dialog = signatureMod.initSignatureDialog(root, (png) => {
        signature = makeAsset(png, "signature", "Signature");
        renderSigPreview();
        addPlacement(signature);
      });
    }
    dialog.open();
  }

  function renderSigPreview() {
    sigPreview.innerHTML = "";
    sigPreview.classList.toggle("has-sig", !!signature);
    if (!signature) return;
    const img = new Image();
    img.src = signature.url;
    img.alt = "Your signature";
    sigPreview.appendChild(img);
  }

  async function addText(text: string) {
    const t = text.trim();
    if (!t || !opened) return;
    signatureMod ??= await import("./signature");
    const png = await signatureMod.renderStamp(t);
    if (!png) {
      updateHint("That text couldn't be drawn. Try different characters.");
      return;
    }
    addPlacement(makeAsset(png, "text", t));
  }

  /** Copy the selected item to every other page, at the same spot. */
  function copyToAll() {
    const id = layer.selectedId();
    const src = items().find((p) => p.id === id);
    if (!src) return;
    let added = 0;
    pages.forEach((pg, i) => {
      if (i === active) return;
      const dup = pg.items.some(
        (p) =>
          p.asset === src.asset &&
          Math.abs(p.rect.x - src.rect.x) < 0.005 &&
          Math.abs(p.rect.y - src.rect.y) < 0.005,
      );
      if (dup) return;
      const w = src.rect.w;
      const h = heightFor(w, src.asset.w, src.asset.h, pg.ptW, pg.ptH);
      // A taller image on a wider page might not fit at the same width.
      const fit = h > 1 ? 1 / h : 1;
      const w2 = w * fit;
      const h2 = h * fit;
      pg.items.push({
        id: ++seq,
        asset: src.asset,
        rect: {
          x: clamp(src.rect.x, 0, 1 - w2),
          y: clamp(src.rect.y, 0, 1 - h2),
          w: w2,
          h: h2,
        },
      });
      added++;
    });
    renderStrip();
    updateHint(
      added
        ? `Copied to ${plural(added, "other page")}. Check each page, because the spot that suits page ${active + 1} may not suit the others.`
        : "It is already in the same place on every page.",
    );
  }

  // ---- Export ----
  async function exportPdf() {
    if (totalItems() === 0 || busy || !sourceFile) return;
    busy = true;
    layer.select(null);
    const count = totalItems();
    const marked = markedPages();
    procTitle.textContent = "Adding your signature";
    procSub.textContent = "Placing it on the page and saving a copy…";
    widgetTitle.textContent = "Signing…";
    showPanel("processing");
    await raf();

    try {
      const { PDFDocument, degrees } = await import("pdf-lib");
      // An encrypted original was unlocked when it was opened; sign that copy.
      const bytes = lock
        ? lock.plain.slice()
        : new Uint8Array(await sourceFile.arrayBuffer());
      // updateMetadata:false keeps pdf-lib from rewriting Producer and ModDate:
      // the only thing this export should change is what the user placed.
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const libPages = doc.getPages();
      if (libPages.length !== pages.length) {
        throw new Error("page count changed between preview and export");
      }

      const embedded = new Map<number, PDFImage>();
      for (let i = 0; i < pages.length; i++) {
        const placed = pages[i].items;
        if (!placed.length) continue;
        const page = libPages[i];

        // pdf-lib wraps the page's existing content in a save/restore pair the
        // first time it appends to it (PDFPageLeaf.autoNormalizeCTM, on by
        // default). That matters: a page whose own content leaves the graphics
        // state altered, with a stray transform or clip, would otherwise carry
        // it into our image, and the signature would land where nobody put it.
        // tests/sign-pdf.spec.ts has a page built to do exactly that.
        const geometry = {
          // getCropBox() falls back to the MediaBox when there is no CropBox.
          view: visibleBox(box(page.getMediaBox()), box(page.getCropBox())),
          rotation: normaliseRotation(page.getRotation().angle),
        };
        for (const it of placed) {
          let img = embedded.get(it.asset.id);
          if (!img) {
            img = await doc.embedPng(
              new Uint8Array(await it.asset.blob.arrayBuffer()),
            );
            embedded.set(it.asset.id, img);
          }
          const a = toDrawArgs(geometry, it.rect);
          page.drawImage(img, {
            x: a.x,
            y: a.y,
            width: a.width,
            // From the image's own shape, so it can never come out stretched
            // even if the preview and the file disagree about the page's shape.
            height: (a.width * it.asset.h) / it.asset.w,
            rotate: degrees(a.rotate),
          });
        }
      }
      let out = await doc.save();
      if (
        (
          await PDFDocument.load(out, { updateMetadata: false })
        ).getPageCount() !== pages.length
      ) {
        throw new Error("signed copy has a different page count");
      }
      const password = lock?.password ?? "";
      if (password) {
        procSub.textContent = "Locking it with the same password…";
        const { encryptPdf } = await import("./qpdf");
        out = await encryptPdf(out, password);
        // The locked file must open with that password and still have every
        // page, or the user would be handed something nobody can read.
        const check = await openPdf(out, password);
        const n = check.doc.numPages;
        await check.close();
        if (n !== pages.length) throw new Error("locked copy lost pages");
      }

      const stem = sourceFile.name.replace(/\.pdf$/i, "");
      result = {
        blob: new Blob([out as BlobPart], { type: "application/pdf" }),
        name: `${stem}-signed.pdf`,
        count,
        marked,
      };
      showDone(await previewOf(out, password));
    } catch (e) {
      // Plain language for the user, the cause for a developer.
      console.error("[sign-pdf] export failed", e);
      showPanel("editor");
      setTitle();
      layer.layout();
      updateHint(
        "We couldn't add the signature, so nothing was saved. Your placements are still here. If it keeps happening, the PDF may be damaged or use features this tool can't write back.",
      );
    } finally {
      busy = false;
      syncControls();
    }
  }

  /**
   * Render the first signed page of the finished file for the done panel.
   * Taken from the output, not the input: it doubles as a check that what we
   * are about to hand over opens. Decorative, so a failure costs only the
   * preview.
   */
  async function previewOf(
    bytes: Uint8Array,
    password = "",
  ): Promise<Blob | null> {
    let out: OpenedPdf | null = null;
    try {
      const first = Math.max(
        0,
        pages.findIndex((p) => p.items.length > 0),
      );
      out = await openPdf(bytes, password || undefined);
      const page = await out.doc.getPage(first + 1);
      try {
        const { ptW, ptH } = pageSize(page);
        const canvas = await renderPage(page, fitScale(ptW, ptH, PREVIEW_PX));
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.8);
        releaseCanvas(canvas);
        previewPage = first + 1;
        return blob;
      } finally {
        page.cleanup();
      }
    } catch {
      return null;
    } finally {
      await out?.close().catch(() => {});
    }
  }

  function showDone(preview: Blob | null) {
    if (!result) return;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    donePreview.innerHTML = "";
    if (preview) {
      doneUrl = URL.createObjectURL(preview);
      const img = document.createElement("img");
      img.src = doneUrl;
      img.alt = `Page ${previewPage} of your signed PDF`;
      img.decoding = "async";
      donePreview.appendChild(img);
    }
    doneTitle.textContent = `Done: ${plural(result.count, "item")} added across ${plural(result.marked, "page")}`;
    let note = "";
    if (lock?.password)
      note += " · locked with the same password as the original";
    else if (lock?.restricted)
      note += " · the original's editing restriction isn't carried over";
    if (certSigned)
      note +=
        " · this file had a certificate-based digital signature, which a re-saved copy can't keep valid";
    doneSub.textContent = `${formatBytes(result.blob.size)} · the original text on every page is unchanged${note}`;
    widgetTitle.textContent = "Ready to download";
    showPanel("done");
  }

  function saveBlob(blob: Blob, name: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- Reset ----
  async function releaseDoc() {
    for (const p of pages) if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
    pages = [];
    lock = null;
    if (pending) {
      const p = pending;
      pending = null;
      await p.doc.close().catch(() => {});
    }
    if (opened) {
      const o = opened;
      opened = null;
      // destroy() lives on the loading task; skipping it leaks a worker and the
      // file bytes it is holding.
      await o.close().catch(() => {});
    }
  }

  async function reset() {
    await releaseDoc();
    sourceFile = null;
    active = -1;
    result = null;
    certSigned = false;
    signature = null;
    for (const a of assets) URL.revokeObjectURL(a.url);
    assets = [];
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    layer.select(null);
    overlay.replaceChildren();
    renderSigPreview();
    textInput.value = "";
    strip.hidden = true;
    strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
    certNote.hidden = true;
    widgetTitle.textContent = initialTitle;
    showPanel("drop");
    syncControls();
  }

  function showError(title: string, message: string) {
    void releaseDoc();
    errTitle.textContent = title;
    errMessage.textContent = message;
    widgetTitle.textContent = "Something went wrong";
    showPanel("error");
  }

  // ---- Wiring ----
  createBtn.addEventListener("click", () => void openCreator());
  addSigBtn.addEventListener(
    "click",
    () => signature && addPlacement(signature),
  );
  removeBtn.addEventListener("click", () => {
    const id = layer.selectedId();
    if (id !== null) removeItem(id);
  });
  clearBtn.addEventListener("click", () => {
    if (active < 0 || !pages[active]) return;
    pages[active].items = [];
    layer.select(null);
    layer.render();
    renderStrip();
    updateHint();
  });
  copyAllBtn.addEventListener("click", copyToAll);

  textInput.addEventListener("input", () => syncControls());
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addText(textInput.value);
    }
  });
  addTextBtn.addEventListener("click", () => void addText(textInput.value));
  dateBtn.addEventListener("click", () => {
    const date = new Date().toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    void addText(date);
  });

  pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = pwInput.value;
    if (!pw) return;
    void openAndBuild(pw);
  });
  pwCancelBtn.addEventListener("click", () => void reset());
  restrictedContinueBtn.addEventListener("click", () => {
    if (pending) void showEditor(pending.doc, pending.bytes);
  });
  restrictedCancelBtn.addEventListener("click", () => void reset());

  applyBtn.addEventListener("click", () => void exportPdf());
  downloadBtn.addEventListener("click", () => {
    if (result) saveBlob(result.blob, result.name);
  });
  anotherBtn.addEventListener("click", () => void reset());
  keepEditingBtn.addEventListener("click", () => {
    showPanel("editor");
    setTitle();
    layer.layout();
    updateHint();
  });
  startOverBtns.forEach((b) => b.addEventListener("click", () => void reset()));

  // ---- Drop zone ----
  // One document in, one out, so only the first file of a multi-file drop.
  createDropzone({
    dropzone,
    fileInput,
    browseBtn,
    dzTitle,
    idleLabel: "Drag & drop your PDF",
    dropLabel: "Drop to open your PDF",
    onFiles: (files) => void acceptFile(files[0]),
  });

  renderSigPreview();
  updateHint();
}
