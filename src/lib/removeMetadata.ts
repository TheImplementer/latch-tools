// -----------------------------------------------------------------------
// /remove-metadata-from-pdf/: show what a PDF says about itself, then hand
// back a copy that doesn't.
//
// Flow: open with pdf.js (for the password prompt and the page-1 thumbnail),
// unlock with qpdf if the file is encrypted, inspect with ./pdfMetadata, let
// the user untick anything they want kept, clean, and, for an encrypted file,
// lock the clean copy exactly as the original was locked (same passwords,
// same restrictions) with qpdf --copy-encryption.
//
// ./pdfMetadata.clean() re-inspects its own output and throws if anything it
// was asked to remove is still there, so the done panel's claims are checked
// claims, not intentions.
//
// Weight: this controller loads on page ready; pdf.js arrives when a file is
// opened, pdf-lib when it is inspected, and qpdf (~440 KB) only for an
// encrypted file.
// -----------------------------------------------------------------------

import { createDropzone } from "./dropzone";
import {
  PdfOpenError,
  fitScale,
  openPdf,
  pageSize,
  renderPage,
  type OpenedPdf,
} from "./pdf";
import type { Category, Findings } from "./pdfMetadata";
import { canvasToBlob } from "./pdfRaster";
import { plural, raf, releaseCanvas } from "./regions";

type Panel = "drop" | "password" | "options" | "processing" | "done" | "error";

const MAX_SIZE_MB = 100;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const THUMB_PX = 220;
const PREVIEW_PX = 520;

const CATS: Category[] = [
  "props",
  "comments",
  "photos",
  "attachments",
  "scripts",
  "appData",
];

function formatBytes(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

/** plural() for words whose plural isn't just "+s". */
function pl(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(items: string[], max = 3): string {
  const shown = items.slice(0, max).map((s) => `“${s}”`);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export function initRemoveMetadataWidget(root: HTMLElement): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;

  // ---- Elements ----
  const panels: Record<Panel, HTMLElement> = {
    drop: q('[data-panel="drop"]'),
    password: q('[data-panel="password"]'),
    options: q('[data-panel="options"]'),
    processing: q('[data-panel="processing"]'),
    done: q('[data-panel="done"]'),
    error: q('[data-panel="error"]'),
  };
  const dropzone = q('[data-el="dropzone"]');
  const fileInput = q<HTMLInputElement>('[data-el="file-input"]');
  const browseBtn = q('[data-el="browse-btn"]');
  const dzTitle = q('[data-el="dz-title"]');
  const widgetTitle = q('[data-el="widget-title"]');
  const fileThumb = q('[data-el="file-thumb"]');
  const fileName = q('[data-el="file-name"]');
  const fileSub = q('[data-el="file-sub"]');
  const optionsNote = q('[data-el="options-note"]');
  const warn = q('[data-el="mf-warn"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const procTitle = q('[data-el="proc-title"]');
  const procSub = q('[data-el="proc-sub"]');
  const procMeter = q('[data-el="proc-meter"]');
  const cancelRow = q('[data-el="cancel-row"]');
  const pwForm = q<HTMLFormElement>('[data-el="pw-form"]');
  const pwInput = q<HTMLInputElement>('[data-el="pw-input"]');
  const pwMessage = q('[data-el="pw-message"]');
  const pwCancelBtn = q<HTMLButtonElement>('[data-el="pw-cancel"]');
  const donePreview = q('[data-el="done-preview"]');
  const doneTitle = q('[data-el="done-title"]');
  const doneSub = q('[data-el="done-sub"]');
  const downloadBtn = q('[data-el="download-btn"]');
  const anotherBtn = q('[data-el="another-btn"]');
  const errTitle = q('[data-el="err-title"]');
  const errMessage = q('[data-el="err-message"]');
  const startOverBtns = root.querySelectorAll<HTMLButtonElement>(
    '[data-el="try-another-btn"]',
  );
  const row = (c: string) => q(`[data-row="${c}"]`);
  const detail = (c: string) => q(`[data-detail="${c}"]`);
  const check = (c: Category) => q<HTMLInputElement>(`input[data-cat="${c}"]`);

  const initialTitle =
    widgetTitle.textContent?.trim() || "Remove metadata from a PDF";

  // ---- State ----
  let sourceFile: File | null = null;
  /** The file as it arrived. Kept for --copy-encryption. */
  let original: Uint8Array | null = null;
  /** What pdf-lib reads: the original, or its decrypted copy. */
  let plain: Uint8Array | null = null;
  /** Set when the file was encrypted: what opened it ("" for owner-only). */
  let lockPassword: string | null = null;
  let found: Findings | null = null;
  let pages = 0;
  let thumbUrl: string | null = null;
  let result: { blob: Blob; name: string } | null = null;
  let doneUrl: string | null = null;
  let busy = false;

  function showPanel(name: Panel) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
  }
  function note(text: string | null) {
    optionsNote.textContent = text ?? "";
    optionsNote.hidden = !text;
  }
  const selected = () =>
    new Set(CATS.filter((c) => !row(c).hidden && check(c).checked));

  function syncControls() {
    applyBtn.disabled = busy || !plain;
  }

  // ---- Intake ----
  function isPdf(f: File): boolean {
    return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  }

  async function acceptFile(file: File) {
    if (!isPdf(file)) {
      showError(
        "That isn't a PDF",
        "Please choose a PDF file. For photos, use the photo metadata remover instead.",
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
    await openAndInspect();
  }

  /**
   * Open the stored file, unlock it if needed, and find out what's in it.
   * `password` only arrives on a retry from the password panel.
   */
  async function openAndInspect(password?: string) {
    if (!sourceFile) return;
    procTitle.textContent = "Opening your PDF";
    procSub.textContent = "Reading the file…";
    procMeter.hidden = true;
    cancelRow.hidden = true;
    widgetTitle.textContent = "Opening…";
    showPanel("processing");
    await raf();

    releaseState();
    let opened: OpenedPdf;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await sourceFile.arrayBuffer());
      opened = await openPdf(bytes, password);
    } catch (e) {
      handleOpenFailure(e);
      return;
    }

    try {
      pages = opened.doc.numPages;
      const info = (await opened.doc.getMetadata().catch(() => null))?.info as
        | { EncryptFilterName?: string | null }
        | undefined;
      await buildPreview(opened);

      let readable = bytes;
      if (info?.EncryptFilterName) {
        procSub.textContent = "Unlocking it in your browser…";
        const { decryptPdf } = await import("./qpdf");
        readable = await decryptPdf(bytes, password ?? "");
        lockPassword = password ?? "";
      }
      procSub.textContent = "Looking for metadata…";
      const { inspect } = await import("./pdfMetadata");
      found = await inspect(readable);
      original = bytes;
      plain = readable;
    } catch (e) {
      console.error("[remove-metadata] inspect failed", e);
      showError(
        "We couldn't read that PDF",
        "The file opened, but its structure couldn't be read to look for metadata. It may be damaged, or use a kind of protection this tool can't open.",
      );
      return;
    } finally {
      await opened.close().catch(() => {});
    }

    await fillOptions();
    widgetTitle.textContent = "Review what's in it";
    showPanel("options");
  }

  function handleOpenFailure(e: unknown) {
    const reason = e instanceof PdfOpenError ? e.reason : "load";
    if (reason === "password" || reason === "wrong-password") {
      // Needing a password is an ordinary state of an ordinary file, not an
      // error, and the error panel's only exit throws the file away.
      pwMessage.textContent =
        reason === "wrong-password"
          ? "That password didn't work. Check it and try again."
          : "Enter its password to open it. The password stays in your browser, and the clean copy is locked with the same one.";
      pwInput.value = "";
      widgetTitle.textContent = "Password needed";
      showPanel("password");
      pwInput.focus();
      return;
    }
    if (reason === "corrupt") {
      showError(
        "We couldn't open that PDF",
        "The file appears to be damaged or isn't really a PDF. Try re-saving or re-exporting it, then open it here again.",
      );
      return;
    }
    showError(
      "We couldn't open that PDF",
      "Something went wrong while reading the file. Try again, or try a different PDF.",
    );
  }

  async function buildPreview(opened: OpenedPdf) {
    const page = await opened.doc.getPage(1);
    try {
      const { ptW, ptH } = pageSize(page);
      const canvas = await renderPage(page, fitScale(ptW, ptH, THUMB_PX, 1));
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.75);
      releaseCanvas(canvas);
      thumbUrl = URL.createObjectURL(blob);
    } catch {
      thumbUrl = null;
    } finally {
      page.cleanup();
    }
    fileThumb.innerHTML = "";
    if (thumbUrl) {
      const img = document.createElement("img");
      img.src = thumbUrl;
      img.alt = "";
      img.decoding = "async";
      fileThumb.appendChild(img);
    }
  }

  // ---- Findings ----
  async function fillOptions() {
    if (!sourceFile || !found) return;
    const f = found;
    // Already loaded by inspect(); this resolves at once.
    const { has } = await import("./pdfMetadata");
    fileName.textContent = sourceFile.name;
    fileSub.textContent = `${formatBytes(sourceFile.size)} · ${plural(pages, "page")}${lockPassword !== null ? " · encrypted" : ""}`;

    for (const c of CATS) {
      row(c).hidden = !has(f, c);
      check(c).checked = true;
    }

    // Properties: one line per value.
    const props = detail("props");
    props.replaceChildren();
    for (const p of f.props) {
      const line = document.createElement("span");
      line.className = "mf-kv";
      const k = document.createElement("span");
      k.className = "mf-k";
      k.textContent = p.label;
      line.append(k, document.createTextNode(p.value));
      props.appendChild(line);
    }
    if (!f.props.length && f.xmpBytes) {
      props.textContent = `An XMP metadata packet (${formatBytes(f.xmpBytes)}).`;
    }

    detail("comments").textContent =
      `Names on ${plural(f.comments.count, "comment")}: ${list(f.comments.authors)}, with the times they were written. The comments themselves stay.`;

    const ph = f.photos;
    let photo = `${plural(ph.withDetails, "photo")} still ${ph.withDetails === 1 ? "carries" : "carry"} camera details`;
    if (ph.cameras.length) photo += ` (${ph.cameras.slice(0, 2).join(", ")})`;
    if (ph.withGps === ph.withDetails)
      photo +=
        ph.withGps === 1
          ? ", including where it was taken (GPS)"
          : ", all including where they were taken (GPS)";
    else if (ph.withGps)
      photo += `, and ${ph.withGps} of them also record where they were taken (GPS)`;
    detail("photos").textContent =
      photo +
      (ph.withDetails === 1
        ? ". The picture itself is left exactly as it is."
        : ". The pictures themselves are left exactly as they are.");

    detail("attachments").textContent =
      `${plural(f.attachments.length, "file")} hidden inside the PDF: ${list(f.attachments)}.`;

    detail("scripts").textContent =
      `${plural(f.scripts, "script")} that can run when the file is opened or used. Forms that calculate totals or format dates will stop doing so, but anything already filled in stays.`;

    const app: string[] = [];
    if (f.appData.pieceInfo)
      app.push(
        `private data from the app that made it, in ${plural(f.appData.pieceInfo, "place")}`,
      );
    if (f.appData.thumbnails)
      app.push(
        `${plural(f.appData.thumbnails, "stored page thumbnail")}, which can show an older version of the page`,
      );
    if (f.appData.objectMetadata)
      app.push(
        `metadata attached to ${pl(f.appData.objectMetadata, "image or page", "images or pages")}`,
      );
    detail("appData").textContent = app.length
      ? app.join("; ").replace(/^./, (c) => c.toUpperCase()) + "."
      : "";

    // Earlier versions: not optional, because rewriting the file drops them.
    const history = row("history");
    history.hidden = !(f.updates > 0 || f.orphans > 0);
    detail("history").textContent =
      f.updates > 0
        ? `This file was saved ${f.updates === 1 ? "once more" : `${f.updates} more times`} on top of the original, the way most editors save. The earlier version of everything that changed is still inside it, including text and properties that look deleted.`
        : `${plural(f.orphans, "leftover object")} from earlier edits that nothing uses any more, but that are still in the file.`;

    // An encrypted file's ID is part of its key, so it is kept.
    row("id").hidden = !f.hasId || lockPassword !== null;

    const warnings: string[] = [];
    if (f.pdfa)
      warnings.push(
        "This file says it is a PDF/A archival document. PDF/A requires document properties, so without them it will no longer pass a PDF/A check. Untick Document properties if that matters.",
      );
    if (f.certSigned)
      warnings.push(
        "This PDF carries a certificate-based digital signature. Any rewritten copy, including this one, will show that signature as no longer valid.",
      );
    warn.textContent = warnings.join(" ");
    warn.hidden = !warnings.length;

    const anything = CATS.some((c) => !row(c).hidden) || !history.hidden;
    note(
      anything
        ? null
        : lockPassword === null
          ? "We didn't find any metadata in this PDF beyond its document ID. Removing will still replace the ID and write a fresh copy."
          : "We didn't find any metadata in this PDF. Removing will still write a fresh copy, locked as the original was.",
    );
    syncControls();
  }

  // ---- Clean ----
  async function apply() {
    if (busy || !plain || !original || !sourceFile || !found) return;
    busy = true;
    note(null);
    syncControls();
    procTitle.textContent = "Removing metadata";
    procSub.textContent = "Writing a clean copy…";
    procMeter.hidden = true;
    cancelRow.hidden = true;
    widgetTitle.textContent = "Removing…";
    showPanel("processing");
    await raf();

    const remove = selected();
    let out: Uint8Array;
    try {
      const { clean } = await import("./pdfMetadata");
      const res = await clean(plain, {
        remove,
        newId: lockPassword === null,
      });
      out = res.bytes;
      if (lockPassword !== null) {
        procSub.textContent = "Locking it the way it was…";
        const { encryptLike } = await import("./qpdf");
        out = await encryptLike(out, original, lockPassword);
        // The locked copy must open with the same password and keep every
        // page, or the user would be handed something nobody can read.
        const check = await openPdf(out, lockPassword || undefined);
        const n = check.doc.numPages;
        await check.close();
        if (n !== pages) throw new Error("locked copy lost pages");
      }
    } catch (e) {
      console.error("[remove-metadata] clean failed", e);
      widgetTitle.textContent = "Review what's in it";
      showPanel("options");
      note(
        "We couldn't write a clean copy of this PDF, so nothing was saved. If it keeps happening, the file may be damaged or use features this tool can't rewrite.",
      );
      busy = false;
      syncControls();
      return;
    }

    const stem = sourceFile.name.replace(/\.pdf$/i, "");
    result = {
      blob: new Blob([out as BlobPart], { type: "application/pdf" }),
      name: `${stem}-clean.pdf`,
    };
    busy = false;
    syncControls();
    showDone(await previewOf(out), summary(found, remove));
  }

  /** What was removed, in words, from what was found and what was ticked. */
  function summary(f: Findings, remove: Set<Category>): string {
    const parts: string[] = [];
    if (remove.has("props")) {
      const n = f.props.filter((p) => p.label !== "Edit history").length;
      if (n) parts.push(pl(n, "document property", "document properties"));
      if (f.historyEntries) parts.push("an edit history");
      else if (!n && f.xmpBytes) parts.push("an XMP packet");
    }
    if (f.updates > 0) parts.push(plural(f.updates, "earlier version"));
    else if (f.orphans > 0) parts.push(plural(f.orphans, "leftover object"));
    if (remove.has("comments"))
      parts.push(`the names on ${plural(f.comments.count, "comment")}`);
    if (remove.has("photos"))
      parts.push(
        f.photos.withGps
          ? `camera details and GPS from ${plural(f.photos.withDetails, "photo")}`
          : `camera details from ${plural(f.photos.withDetails, "photo")}`,
      );
    if (remove.has("attachments"))
      parts.push(plural(f.attachments.length, "attached file"));
    if (remove.has("scripts")) parts.push(plural(f.scripts, "script"));
    if (remove.has("appData")) parts.push("hidden app data");
    return parts.length
      ? `Removed ${parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]}.`
      : "";
  }

  async function previewOf(bytes: Uint8Array): Promise<Blob | null> {
    let out: OpenedPdf | null = null;
    try {
      out = await openPdf(bytes, lockPassword || undefined);
      const page = await out.doc.getPage(1);
      try {
        const { ptW, ptH } = pageSize(page);
        const canvas = await renderPage(page, fitScale(ptW, ptH, PREVIEW_PX));
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.8);
        releaseCanvas(canvas);
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

  function showDone(preview: Blob | null, removed: string) {
    if (!result) return;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    donePreview.innerHTML = "";
    if (preview) {
      doneUrl = URL.createObjectURL(preview);
      const img = document.createElement("img");
      img.src = doneUrl;
      img.alt = "The first page of your clean PDF";
      img.decoding = "async";
      donePreview.appendChild(img);
    }
    doneTitle.textContent = "Done: a clean copy, with the pages unchanged";
    const lock =
      lockPassword === null
        ? ""
        : lockPassword
          ? " Locked with the same password and settings as the original."
          : " Its original restrictions are kept.";
    doneSub.textContent =
      `${formatBytes(result.blob.size)} · ${removed}${lock}`.trim();
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
  function releaseState() {
    if (thumbUrl) {
      URL.revokeObjectURL(thumbUrl);
      thumbUrl = null;
    }
    original = null;
    plain = null;
    lockPassword = null;
    found = null;
    pages = 0;
  }

  function reset() {
    releaseState();
    sourceFile = null;
    result = null;
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    fileThumb.innerHTML = "";
    for (const c of CATS) row(c).hidden = true;
    row("history").hidden = true;
    row("id").hidden = true;
    warn.hidden = true;
    note(null);
    syncControls();
    widgetTitle.textContent = initialTitle;
    showPanel("drop");
  }

  function showError(title: string, message: string) {
    releaseState();
    errTitle.textContent = title;
    errMessage.textContent = message;
    widgetTitle.textContent = "Something went wrong";
    showPanel("error");
  }

  // ---- Wiring ----
  applyBtn.addEventListener("click", () => void apply());
  downloadBtn.addEventListener("click", () => {
    if (result) saveBlob(result.blob, result.name);
  });
  anotherBtn.addEventListener("click", reset);
  startOverBtns.forEach((b) => b.addEventListener("click", reset));
  pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = pwInput.value;
    if (!pw) return;
    void openAndInspect(pw);
  });
  pwCancelBtn.addEventListener("click", reset);

  createDropzone({
    dropzone,
    fileInput,
    browseBtn,
    dzTitle,
    idleLabel: "Drag & drop your PDF",
    dropLabel: "Drop to open your PDF",
    onFiles: (files) => void acceptFile(files[0]),
  });

  syncControls();
}
