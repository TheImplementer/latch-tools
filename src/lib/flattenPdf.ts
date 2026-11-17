// -----------------------------------------------------------------------
// PDF flattening — one document in, one flattened document out.
//
// "Flatten" means two different things to two different people, and this tool
// does both rather than picking one and hoping:
//
//   Rasterise (thorough) — render every page and rebuild the PDF from those
//   images. Layers, annotations, comments, form fields and anything hidden all
//   merge down into the page. This is ./pdfRaster, the same pipeline that makes
//   /redact-pdf/ safe, with no bars drawn on it.
//
//   Form-flatten (crisp) — pdf-lib's form.flatten() draws each field's
//   appearance stream into the page content and removes the field. The text
//   stays vector-sharp and selectable, and nothing else in the document is
//   touched.
//
// They are not weak and strong versions of one operation; they answer different
// questions, and rasterising a filled form to "lock" it would be a bad answer
// (fuzzy text, no search, much bigger file). The UI says so, and so does the
// page.
//
// The awkward part is that crisp mode cannot serve every document, and failing
// silently would be the worst outcome — the user would get back a file that
// looks flattened and isn't. So the document is inspected up front and the mode
// is switched off with a specific reason when it cannot be honoured. See
// inspect() for the five reasons; the hidden-widget one is a real leak rather
// than a limitation, and is commented there.
// -----------------------------------------------------------------------

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
  DPI_HIGH,
  DPI_STANDARD,
  canvasToBlob,
  rasterisePdf,
} from "./pdfRaster";
import { plural, raf, releaseCanvas } from "./regions";

type Panel = "drop" | "password" | "options" | "processing" | "done" | "error";
type Mode = "raster" | "form";

const MAX_SIZE_MB = 100;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
// Rasterising is linear in page count and the result is held in memory before
// download, so this is a real ceiling. It is a constraint of the raster mode
// rather than of the document, but it is stated in the drop-zone copy — which
// the user reads before choosing a mode — so it applies to both.
const MAX_PAGES = 150;
/** Longest side of the page-1 preview shown beside the filename. */
const THUMB_PX = 220;
/** Longest side of the finished-document preview. */
const PREVIEW_PX = 520;

/** What pdf.js reports per form field. Parents of a dotted name have no type. */
interface FieldObject {
  type?: string;
  hidden?: boolean;
}

interface Inspection {
  pages: number;
  /** Terminal form fields — the ones pdf-lib would actually flatten. */
  fields: number;
  /** Null when form-flatten is available, otherwise why it is not. */
  crispBlocked: string | null;
}

function formatBytes(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Decide what this document supports, before the user commits to a mode.
 *
 * Everything here comes from pdf.js. pdf-lib is deliberately not consulted:
 * its getForm() calls getOrCreateAcroForm(), which *mutates* the document by
 * adding an empty /AcroForm when there isn't one. Probing with it would mean
 * every file we touch grows a form dictionary it didn't have.
 */
async function inspect(doc: PdfDoc): Promise<Inspection> {
  const pages = doc.numPages;

  let encrypted = false;
  let xfa = false;
  try {
    const info = (await doc.getMetadata()).info as {
      EncryptFilterName?: string | null;
      IsXFAPresent?: boolean;
    };
    // Non-null for any encrypted document — including the owner-password-only
    // files that open without ever prompting us. That matters because pdf-lib
    // cannot read an encrypted PDF at all, and finding out at export time would
    // mean failing after the user had already committed to the mode.
    encrypted = !!info?.EncryptFilterName;
    xfa = !!info?.IsXFAPresent;
  } catch {
    // A metadata read that fails is not a reason to reject the file.
  }

  const terminal: FieldObject[] = [];
  try {
    const objects = (await doc.getFieldObjects()) as Record<
      string,
      FieldObject[]
    > | null;
    if (objects) {
      for (const list of Object.values(objects)) {
        // Entries without a type are the non-terminal parents of a dotted field
        // name ("applicant" for "applicant.name"). Counting them would overstate
        // the field count and disagree with what pdf-lib flattens.
        for (const f of list) if (f.type) terminal.push(f);
      }
    }
  } catch {
    // Leave the mode enabled and let the export path report — a failed scan is
    // not evidence that there is nothing to flatten.
    return { pages, fields: 0, crispBlocked: null };
  }

  const fields = terminal.length;
  let crispBlocked: string | null = null;
  if (fields === 0) {
    crispBlocked =
      "This PDF has no form fields, so this would hand back the same file. Rasterise is the one you want.";
  } else if (terminal.every((f) => f.type === "signature")) {
    crispBlocked =
      "The only fields here are signature fields. Baking those in adds nothing visible and breaks the signature.";
  } else if (xfa) {
    crispBlocked =
      "This is a dynamic XFA form. Its live fields aren't the kind this mode can bake in, so the result wouldn't match what you see.";
  } else if (terminal.some((f) => f.hidden)) {
    // Not a limitation — a leak. pdf.js honours the widget's hidden flag when
    // rendering, so rasterising correctly leaves hidden fields off the page.
    // pdf-lib's flatten() does not look at the flag at all and draws every
    // widget, which would print values onto the page that nobody can see today.
    // On a privacy tool that is not an acceptable default.
    crispBlocked =
      "Some fields in this PDF are hidden. Baking them in would print values onto the page that aren't visible today, so this mode is off for this file.";
  } else if (encrypted) {
    crispBlocked =
      "This PDF is encrypted. Rewriting its contents in place isn't possible while it is, but rasterising it is.";
  }

  return { pages, fields, crispBlocked };
}

export function initFlattenPdfWidget(root: HTMLElement): void {
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
  const modeRaster = q<HTMLInputElement>('[data-el="mode-raster"]');
  const modeForm = q<HTMLInputElement>('[data-el="mode-form"]');
  const modeFormRow = q('[data-el="mode-form-row"]');
  const modeFormWhy = q('[data-el="mode-form-why"]');
  const qualityRow = q('[data-el="quality-row"]');
  const qualityInput = q<HTMLSelectElement>('[data-el="quality"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const applyLabelEl = q('[data-el="apply-label"]');
  const procTitle = q('[data-el="proc-title"]');
  const procSub = q('[data-el="proc-sub"]');
  const procMeter = q('[data-el="proc-meter"]');
  const procFill = q('[data-el="proc-fill"]');
  const procCount = q('[data-el="proc-count"]');
  const procPct = q('[data-el="proc-pct"]');
  const cancelRow = q('[data-el="cancel-row"]');
  const cancelBtn = q<HTMLButtonElement>('[data-el="cancel"]');
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
  // Both the options panel and the error panel offer a way back to the start.
  const startOverBtns = root.querySelectorAll<HTMLButtonElement>(
    '[data-el="try-another-btn"]',
  );

  // The heading the component was given, so reset() restores exactly that
  // rather than a second copy of it that can drift out of sync.
  const initialTitle = widgetTitle.textContent?.trim() || "Flatten a PDF";

  // ---- State ----
  let opened: OpenedPdf | null = null;
  let sourceFile: File | null = null;
  let info: Inspection | null = null;
  let thumbUrl: string | null = null;
  let result: { blob: Blob; name: string } | null = null;
  let doneUrl: string | null = null;
  let cancelled = false;
  let busy = false;

  function showPanel(name: Panel) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
  }
  function mode(): Mode {
    return modeForm.checked ? "form" : "raster";
  }
  function dpi(): number {
    return qualityInput.value === "high" ? DPI_HIGH : DPI_STANDARD;
  }
  function setProgress(done: number, total: number, label: string) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    procFill.style.width = pct + "%";
    procCount.textContent = label;
    procPct.textContent = pct + "%";
  }
  function note(text: string | null) {
    optionsNote.textContent = text ?? "";
    optionsNote.hidden = !text;
  }

  function syncControls() {
    // The quality control only means anything when we are rendering pages.
    qualityRow.hidden = mode() !== "raster";
    const blocked = mode() === "form" && !!info?.crispBlocked;
    applyBtn.disabled = busy || blocked || !opened;
    const base = applyLabelEl.dataset.base ?? "Flatten & download";
    applyLabelEl.textContent = base;
  }

  // ---- Intake ----
  function isPdf(f: File): boolean {
    return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  }

  async function acceptFile(file: File) {
    if (!isPdf(file)) {
      showError(
        "That isn't a PDF",
        "Please choose a PDF file. This tool flattens PDF documents, not images.",
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
   * Open the stored file and work out what it supports.
   *
   * `password` only arrives on a retry from the password panel. The bytes are
   * re-read from the File every time: pdf.js transfers the buffer it is given,
   * so the previous attempt's array is already detached.
   */
  async function openAndInspect(password?: string) {
    if (!sourceFile) return;
    procTitle.textContent = "Opening your PDF";
    procSub.textContent = "Opening your PDF…";
    procMeter.hidden = true;
    cancelRow.hidden = true;
    widgetTitle.textContent = "Opening…";
    showPanel("processing");
    await raf();

    await releaseDoc();
    let next: OpenedPdf;
    try {
      const bytes = new Uint8Array(await sourceFile.arrayBuffer());
      next = await openPdf(bytes, password);
    } catch (e) {
      handleOpenFailure(e);
      return;
    }

    if (next.doc.numPages > MAX_PAGES) {
      await next.close();
      showError(
        "That document has too many pages",
        `It has ${next.doc.numPages} pages and this tool handles up to ${MAX_PAGES}. Split it first, then flatten the part you need.`,
      );
      return;
    }

    opened = next;
    try {
      info = await inspect(next.doc);
      await buildPreview();
    } catch {
      showError(
        "We couldn't read that PDF",
        "The file opened but couldn't be read properly. It may be damaged.",
      );
      return;
    }

    fillOptions();
    widgetTitle.textContent = "Choose how to flatten";
    showPanel("options");
  }

  function handleOpenFailure(e: unknown) {
    const reason = e instanceof PdfOpenError ? e.reason : "load";
    if (reason === "password" || reason === "wrong-password") {
      // Deliberately NOT showError(): needing a password is an ordinary state
      // of an ordinary file, and the error panel's only exit throws the file
      // away.
      pwMessage.textContent =
        reason === "wrong-password"
          ? "That password didn't work. Check it and try again."
          : "This PDF is password-protected. Enter its password to open it. The password stays in your browser, like the file.";
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

  /** Render page 1 small, so the user can see they opened the right file. */
  async function buildPreview() {
    if (!opened) return;
    const page = await opened.doc.getPage(1);
    try {
      const { ptW, ptH } = pageSize(page);
      const canvas = await renderPage(page, fitScale(ptW, ptH, THUMB_PX, 1));
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.75);
      releaseCanvas(canvas);
      thumbUrl = URL.createObjectURL(blob);
    } finally {
      page.cleanup();
    }
    fileThumb.innerHTML = "";
    const img = document.createElement("img");
    img.src = thumbUrl!;
    img.alt = "";
    img.decoding = "async";
    fileThumb.appendChild(img);
  }

  function fillOptions() {
    if (!sourceFile || !info) return;
    fileName.textContent = sourceFile.name;
    const fieldPart =
      info.fields > 0
        ? `${plural(info.fields, "form field")}`
        : "no form fields";
    fileSub.textContent = `${formatBytes(sourceFile.size)} · ${plural(info.pages, "page")} · ${fieldPart}`;

    const blocked = info.crispBlocked;
    modeForm.disabled = !!blocked;
    modeFormRow.classList.toggle("is-disabled", !!blocked);
    modeFormWhy.textContent = blocked ?? "";
    modeFormWhy.hidden = !blocked;
    if (blocked) modeRaster.checked = true;
    note(null);
    syncControls();
  }

  // ---- Export ----
  async function apply() {
    if (busy || !opened || !sourceFile) return;
    if (mode() === "form" && info?.crispBlocked) return;
    busy = true;
    cancelled = false;
    note(null);
    syncControls();
    try {
      if (mode() === "raster") await runRaster();
      else await runFormFlatten();
    } finally {
      busy = false;
      cancelRow.hidden = true;
      syncControls();
    }
  }

  async function runRaster() {
    const total = info!.pages;
    procTitle.textContent = `Flattening ${plural(total, "page")}`;
    procSub.textContent = "Rendering every page and rebuilding the file";
    procMeter.hidden = false;
    cancelRow.hidden = false;
    setProgress(0, total, `0 of ${total}`);
    widgetTitle.textContent = "Flattening…";
    showPanel("processing");
    await raf();

    let out;
    try {
      out = await rasterisePdf(opened!.doc, {
        dpi: dpi(),
        onProgress: (done) =>
          setProgress(
            done,
            total,
            done < total ? `${done + 1} of ${total}` : "",
          ),
        shouldCancel: () => cancelled,
      });
    } catch (e) {
      // Plain language for the user, the cause for a developer — an export
      // failure is otherwise impossible to diagnose from a bug report, and
      // there is nothing sensitive in a canvas error.
      console.error("[flatten-pdf] rasterise failed", e);
      backToOptions(
        "We couldn't finish flattening that document, so nothing was saved. Try the Standard quality setting, which uses less memory.",
      );
      return;
    }

    if (!out.ok) {
      backToOptions("Stopped. Nothing was saved, and your original is unchanged.");
      return;
    }

    result = {
      blob: new Blob([out.bytes as BlobPart], { type: "application/pdf" }),
      name: outputName(),
    };
    showDone(
      out.firstPage,
      `Done: ${plural(total, "page")} flattened`,
      `${formatBytes(result.blob.size)} · every page is now an image, with no layers, fields or hidden content left`,
    );
  }

  async function runFormFlatten() {
    // One indivisible operation rather than a page loop, so the meter stays
    // hidden — a bar that jumps straight from 0% to 100% tells nobody anything.
    procTitle.textContent = "Flattening form fields";
    procSub.textContent = "Baking the values into the page";
    procMeter.hidden = true;
    cancelRow.hidden = true;
    widgetTitle.textContent = "Flattening…";
    showPanel("processing");
    await raf();

    let bytes: Uint8Array;
    let flattened: number;
    try {
      const { PDFDocument } = await import("pdf-lib");
      // updateMetadata:false keeps pdf-lib from rewriting Producer, Creator and
      // ModDate. The whole selling point of this mode is that it changes as
      // little as possible, and quietly restamping the document's provenance
      // would contradict that.
      const doc = await PDFDocument.load(
        new Uint8Array(await sourceFile!.arrayBuffer()),
        { updateMetadata: false },
      );
      const form = doc.getForm();
      flattened = form.getFields().length;
      if (flattened === 0) {
        // pdf.js found fields and pdf-lib can't reach them — malformed field
        // tree, or an XFA-only form. Saving here would produce a file identical
        // to the input while the UI claimed success.
        backToOptions(
          "We couldn't reach the form fields in this PDF to bake them in, so nothing was saved. Rasterise will flatten it.",
        );
        return;
      }
      form.flatten();
      // flatten() removes each field as it succeeds, so a partial run leaves
      // some behind. Anything other than zero means the document is half-done
      // and must not be handed over.
      const left = form.getFields().length;
      if (left !== 0) throw new Error(`${left} field(s) not flattened`);
      bytes = await doc.save();
    } catch (e) {
      console.error("[flatten-pdf] form flatten failed", e);
      backToOptions(
        "We couldn't bake this form's fields into the page, so nothing was saved. This happens with unusual or damaged form fields. Rasterising will still flatten it.",
      );
      return;
    }

    result = {
      blob: new Blob([bytes as BlobPart], { type: "application/pdf" }),
      name: outputName(),
    };
    showDone(
      await previewOf(bytes),
      `Done: ${plural(flattened, "form field")} baked in`,
      `${formatBytes(result.blob.size)} · the values are now part of the page, and the text is still selectable`,
    );
  }

  function outputName(): string {
    const stem = (sourceFile?.name ?? "document").replace(/\.pdf$/i, "");
    return `${stem}-flattened.pdf`;
  }

  /**
   * Render page 1 of the finished document for the done panel.
   *
   * Deliberately from the output rather than the input: it is a cheap
   * end-to-end check that what we are about to hand over actually opens. Purely
   * decorative, so a failure costs the preview and nothing else.
   */
  async function previewOf(bytes: Uint8Array): Promise<Blob | null> {
    let out: OpenedPdf | null = null;
    try {
      out = await openPdf(bytes);
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

  /** Recoverable stop: keep the document open and the options as they were. */
  function backToOptions(message: string) {
    widgetTitle.textContent = "Choose how to flatten";
    showPanel("options");
    note(message);
  }

  function showDone(preview: Blob | null, title: string, sub: string) {
    if (!result) return;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    donePreview.innerHTML = "";
    if (preview) {
      doneUrl = URL.createObjectURL(preview);
      const img = document.createElement("img");
      img.src = doneUrl;
      img.alt = "The first page of your flattened PDF";
      img.decoding = "async";
      donePreview.appendChild(img);
    }
    doneTitle.textContent = title;
    doneSub.textContent = sub;
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
    if (thumbUrl) {
      URL.revokeObjectURL(thumbUrl);
      thumbUrl = null;
    }
    if (opened) {
      const o = opened;
      opened = null;
      // destroy() lives on the loading task, not the document proxy. Skipping
      // it leaks a worker and the file bytes it is holding, per opened file.
      await o.close().catch(() => {});
    }
  }

  async function reset() {
    await releaseDoc();
    sourceFile = null;
    info = null;
    result = null;
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    fileThumb.innerHTML = "";
    modeRaster.checked = true;
    modeForm.disabled = false;
    modeFormRow.classList.remove("is-disabled");
    modeFormWhy.hidden = true;
    note(null);
    syncControls();
    widgetTitle.textContent = initialTitle;
    showPanel("drop");
  }

  function showError(title: string, message: string) {
    void releaseDoc();
    errTitle.textContent = title;
    errMessage.textContent = message;
    widgetTitle.textContent = "Something went wrong";
    showPanel("error");
  }

  // ---- Wiring ----
  modeRaster.addEventListener("change", () => {
    note(null);
    syncControls();
  });
  modeForm.addEventListener("change", () => {
    note(null);
    syncControls();
  });
  applyBtn.addEventListener("click", () => void apply());
  cancelBtn.addEventListener("click", () => {
    cancelled = true;
  });
  downloadBtn.addEventListener("click", () => {
    if (result) saveBlob(result.blob, result.name);
  });
  anotherBtn.addEventListener("click", () => void reset());
  startOverBtns.forEach((b) => b.addEventListener("click", () => void reset()));

  pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = pwInput.value;
    if (!pw) return;
    void openAndInspect(pw);
  });
  pwCancelBtn.addEventListener("click", () => void reset());

  // ---- Drop zone ----
  // One document in, one out — so only the first file of a multi-file drop.
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
