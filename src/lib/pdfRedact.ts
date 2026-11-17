// -----------------------------------------------------------------------
// PDF redaction — one file in, N pages, one file out.
//
// The safety story is the whole reason this tool exists, and it is a property
// of the pipeline rather than a feature bolted onto it. A black rectangle drawn
// in a PDF editor is an object stacked on top of the text; the text object is
// untouched and comes straight back out with copy-paste. Here every page is
// rendered to a canvas, the bars are composited into those pixels, and the
// output PDF is rebuilt from the rasters — so the text layer does not survive
// to be recovered, because it is never carried across.
//
// Two consequences we own up to in the UI rather than hide: the result is
// images (no selectable or searchable text, and no text for a screen reader),
// and it is usually larger than the original.
//
// Shares the drag-a-box editing layer with the image tools via ./regions. What
// is genuinely different here is the queue: images are N files in and N files
// out, a PDF is one file in and one file out, so this module owns its own
// intake, page model and export rather than pretending a page is a File.
//
// Memory: page canvases are released as soon as they have been encoded, so a
// long document walks through them rather than accumulating them. At 300 DPI an
// A4 page is a ~33 MB surface and a 150-page document would be 5 GB if they were
// all held. See ./pdfRaster, which owns the export loop and that guarantee.
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
import {
  DPI_HIGH,
  DPI_STANDARD,
  canvasToBlob,
  rasterisePdf,
} from "./pdfRaster";
import {
  MAX_STAGE,
  THUMB,
  bakeRegions,
  createRegionEditor,
  plural,
  raf,
  releaseCanvas,
  setFocus,
  type Rect,
} from "./regions";

/** One page of the loaded document. Holds no full-resolution pixels. */
interface Page {
  /** 1-based, as pdf.js numbers them. */
  n: number;
  /** Size in PDF points, with /Rotate already applied. */
  ptW: number;
  ptH: number;
  thumbUrl: string;
  regions: Rect[];
}

type Panel = "drop" | "password" | "editor" | "processing" | "done" | "error";

const MAX_SIZE_MB = 100;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
// Rendering is linear in page count and the output is held in memory before
// download, so this is a real ceiling rather than a guess. Stated up front in
// the drop-zone copy so nobody discovers it after a two-minute wait.
const MAX_PAGES = 150;

function formatBytes(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

export function initPdfRedactWidget(root: HTMLElement): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;

  // ---- Elements ----
  const panels: Record<Panel, HTMLElement> = {
    drop: q('[data-panel="drop"]'),
    password: q('[data-panel="password"]'),
    editor: q('[data-panel="editor"]'),
    processing: q('[data-panel="processing"]'),
    done: q('[data-panel="done"]'),
    error: q('[data-panel="error"]'),
  };
  const dropzone = q('[data-el="dropzone"]');
  const fileInput = q<HTMLInputElement>('[data-el="file-input"]');
  const browseBtn = q('[data-el="browse-btn"]');
  const dzTitle = q('[data-el="dz-title"]');
  const stage = q<HTMLCanvasElement>('[data-el="stage"]');
  const qualityInput = q<HTMLSelectElement>('[data-el="quality"]');
  const undoBtn = q<HTMLButtonElement>('[data-el="undo-btn"]');
  const clearBtn = q<HTMLButtonElement>('[data-el="clear-btn"]');
  const applyAllBtn = q<HTMLButtonElement>('[data-el="apply-all-btn"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const applyLabelEl = q('[data-el="apply-label"]');
  const editorHint = q('[data-el="editor-hint"]');
  const strip = q('[data-el="filmstrip"]');
  const widgetTitle = q('[data-el="widget-title"]');
  const procTitle = q('[data-el="proc-title"]');
  const procSub = q('[data-el="proc-sub"]');
  const procMeter = q('[data-el="proc-meter"]');
  const procFill = q('[data-el="proc-fill"]');
  const procCount = q('[data-el="proc-count"]');
  const procPct = q('[data-el="proc-pct"]');
  const cancelRow = root.querySelector<HTMLElement>('[data-el="cancel-row"]');
  const cancelBtn = root.querySelector<HTMLButtonElement>('[data-el="cancel"]');
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
  const tryAnotherBtn = q('[data-el="try-another-btn"]');

  // ---- State ----
  let opened: OpenedPdf | null = null;
  let sourceFile: File | null = null;
  let pages: Page[] = [];
  let active = -1;
  let stageImg: HTMLCanvasElement | null = null;
  let result: { blob: Blob; name: string; bars: number } | null = null;
  let doneUrl: string | null = null;
  let cancelled = false;
  let busy = false;

  function regions(): Rect[] {
    return active >= 0 && pages[active] ? pages[active].regions : [];
  }
  function totalRegions(): number {
    return pages.reduce((n, p) => n + p.regions.length, 0);
  }
  function markedPages(): number {
    return pages.filter((p) => p.regions.length > 0).length;
  }
  function showPanel(name: Panel, scroll = false) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
    setFocus(root, name === "editor", scroll);
  }
  function dpi(): number {
    return qualityInput.value === "high" ? DPI_HIGH : DPI_STANDARD;
  }

  const editor = createRegionEditor({
    stage,
    getRegions: regions,
    getStageImg: () => stageImg,
    getEffect: () => "blackout",
    // Blackout ignores strength — the pixels are replaced outright, so there is
    // no "how much" to tune. The control in that slot is output DPI instead.
    getStrength: () => 1,
    onEdit: (kind) => {
      updateHint();
      if (kind === "commit") renderStrip();
    },
  });

  // ---- Copy ----
  function updateHint(note?: string) {
    const n = regions().length;
    const where = pages.length > 1 ? ` on page ${active + 1}` : "";
    let hint: string;
    if (n === 0) {
      hint =
        pages.length > 1
          ? `Drag a box over anything to hide${where}. Each page keeps its own boxes.`
          : "Drag a box over anything you want to hide. Add as many as you need.";
    } else {
      hint = `${plural(n, "area")}${where} will be blacked out. Drag to add more, or click one to move, resize, or delete it.`;
    }
    editorHint.textContent = note ?? hint;
    syncControls();
  }

  function syncControls() {
    const n = regions().length;
    undoBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
    applyAllBtn.disabled = n === 0 || pages.length < 2;
    applyAllBtn.hidden = pages.length < 2;

    const total = totalRegions();
    applyBtn.disabled = total === 0 || busy;
    const base = applyLabelEl.dataset.base ?? "Redact & download";
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
        : "Draw over what to hide";
  }

  function setProgress(done: number, total: number, label: string) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    procFill.style.width = pct + "%";
    procCount.textContent = label;
    procPct.textContent = pct + "%";
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
        `Page ${i + 1} of ${pages.length}${pg.regions.length ? `, ${plural(pg.regions.length, "area")} marked` : ", no areas marked"}`,
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
      if (pg.regions.length) {
        const badge = document.createElement("span");
        badge.className = "strip-badge";
        badge.textContent = String(pg.regions.length);
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
        "Please choose a PDF file. To black out details in a photo or screenshot, use the image redaction tool instead.",
      );
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      showError(
        "That PDF is too large",
        `${file.name} is ${formatBytes(file.size)}. This tool handles files up to ${MAX_SIZE_MB} MB — everything runs in your browser's memory, so there is a real ceiling.`,
      );
      return;
    }
    sourceFile = file;
    await openAndBuild();
  }

  /**
   * Open the stored file and build the page list.
   *
   * `password` is only supplied on a retry from the password panel. Note the
   * bytes are re-read from the File every time: pdf.js transfers the buffer it
   * is given, so the previous attempt's array is detached.
   */
  async function openAndBuild(password?: string) {
    if (!sourceFile) return;
    procTitle.textContent = "Opening your PDF";
    procSub.textContent = "Reading it in your browser — nothing is uploaded";
    procMeter.hidden = true;
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
        `It has ${next.doc.numPages} pages and this tool handles up to ${MAX_PAGES}. Split it first, then redact the part you need.`,
      );
      return;
    }

    opened = next;
    try {
      await buildPages();
    } catch {
      showError(
        "We couldn't read that PDF",
        "The file opened but its pages could not be rendered. It may be damaged.",
      );
      return;
    }
    await setActive(0);
    showPanel("editor", true);
  }

  function handleOpenFailure(e: unknown) {
    const reason = e instanceof PdfOpenError ? e.reason : "load";
    if (reason === "password" || reason === "wrong-password") {
      // Deliberately NOT showError(): needing a password is an ordinary state
      // of an ordinary file, not a failure, and the error panel's only exit
      // throws the file away.
      pwMessage.textContent =
        reason === "wrong-password"
          ? "That password didn't work. Check it and try again."
          : "This PDF is password-protected. Enter its password to open it — the password stays in your browser, like the file itself.";
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

  /** Render every page small, for the strip and to learn each page's size. */
  async function buildPages() {
    const doc = opened!.doc;
    const total = doc.numPages;
    pages = [];

    const metered = total > 1;
    procTitle.textContent = `Reading ${plural(total, "page")}`;
    procSub.textContent =
      "Rendering previews on your device — nothing is uploaded";
    procMeter.hidden = !metered;
    if (metered) setProgress(0, total, `0 of ${total}`);
    showPanel("processing");
    await raf();

    for (let i = 1; i <= total; i++) {
      if (metered) {
        setProgress(i - 1, total, `${i} of ${total}`);
        await raf();
      }
      const page = await doc.getPage(i);
      const { ptW, ptH } = pageSize(page);
      let thumbUrl = "";
      try {
        const canvas = await renderPage(page, fitScale(ptW, ptH, THUMB, 1));
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.7);
        releaseCanvas(canvas);
        thumbUrl = URL.createObjectURL(blob);
      } catch {
        // A page whose preview won't render is not fatal — it still gets a
        // strip entry, and export will report properly if it fails there too.
        thumbUrl = "";
      }
      page.cleanup();
      pages.push({ n: i, ptW, ptH, thumbUrl, regions: [] });
    }
    setProgress(total, total, "");
  }

  /** Put one page on the stage at preview resolution. */
  async function setActive(i: number) {
    const pg = pages[i];
    if (!pg || !opened) return;
    active = i;
    editor.setSelected(-1);
    const page = await opened.doc.getPage(pg.n);
    const canvas = await renderPage(page, fitScale(pg.ptW, pg.ptH, MAX_STAGE));
    page.cleanup();
    if (stageImg) releaseCanvas(stageImg);
    stage.width = canvas.width;
    stage.height = canvas.height;
    stage.style.aspectRatio = `${pg.ptW} / ${pg.ptH}`;
    stageImg = canvas;
    setTitle();
    renderStrip();
    updateHint();
    editor.draw();
  }

  // ---- Export ----
  //
  // The rule that matters: a page that fails to render must never be written
  // out. A PDF that is missing one page is obvious; a PDF where one page came
  // through un-redacted is a leak that looks like success. ./pdfRaster owns
  // that rule — it writes nothing until every page has rendered.
  async function exportPdf() {
    if (totalRegions() === 0 || busy) return;
    busy = true;
    cancelled = false;
    const total = pages.length;

    procTitle.textContent = `Redacting ${plural(total, "page")}`;
    procSub.textContent =
      "Baking the bars into the pixels and rebuilding the file";
    procMeter.hidden = false;
    if (cancelRow) cancelRow.hidden = false;
    setProgress(0, total, `0 of ${total}`);
    widgetTitle.textContent = "Redacting…";
    showPanel("processing");
    await raf();

    try {
      const out = await rasterisePdf(opened!.doc, {
        dpi: dpi(),
        // The bars are composited into the page's own pixels here, at export
        // resolution. bakeRegions always returns a new canvas; pdfRaster
        // releases whichever of the two it ends up encoding.
        transform: (canvas, i) =>
          pages[i].regions.length
            ? bakeRegions(
                canvas,
                canvas.width,
                canvas.height,
                pages[i].regions,
                "blackout",
                1,
              )
            : canvas,
        onProgress: (done) =>
          setProgress(
            done,
            total,
            done < total ? `${done + 1} of ${total}` : "",
          ),
        shouldCancel: () => cancelled,
      });

      if (!out.ok) {
        showPanel("editor");
        updateHint(
          "Stopped — nothing was exported. Your boxes are still here.",
        );
        return;
      }

      const stem = (sourceFile?.name ?? "document").replace(/\.pdf$/i, "");
      result = {
        blob: new Blob([out.bytes as BlobPart], { type: "application/pdf" }),
        name: `${stem}-redacted.pdf`,
        bars: totalRegions(),
      };
      // Stays inside the try: the finally below decides whether to restore the
      // editor's chrome by checking whether the done panel is showing, so
      // showDone() has to have run by then.
      showDone(out.firstPage);
    } catch (e) {
      // The user gets plain language; a developer gets the cause. Swallowing it
      // entirely makes an export failure impossible to diagnose from a bug
      // report, and there is nothing sensitive in a canvas or pdf-lib error.
      console.error("[redact-pdf] export failed", e);
      // Back to the editor, never showError: its only exit is reset(), which
      // would throw away every box the user drew. Nothing partial is emitted.
      showPanel("editor");
      updateHint(
        "We couldn't finish redacting that document, so nothing was exported — your boxes are still here. Try the Standard quality setting, which uses less memory.",
      );
    } finally {
      busy = false;
      if (cancelRow) cancelRow.hidden = true;
      syncControls();
      // Only restore the editor's chrome if we actually came back to it. On
      // success we are sitting on the done panel, whose heading showDone() owns
      // — resetting it here would overwrite "Ready to download" with the page
      // counter a moment after the user sees it.
      if (panels.done.hidden) {
        setTitle();
        renderStrip();
        editor.draw();
      }
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
      img.alt = `The first page of your redacted PDF`;
      img.decoding = "async";
      donePreview.appendChild(img);
    }
    doneTitle.textContent = `Done — ${plural(result.bars, "area")} blacked out across ${plural(pages.length, "page")}`;
    doneSub.textContent = `${formatBytes(result.blob.size)} · the text under the bars is gone, not covered — and none of it left your device`;
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
    if (stageImg) {
      releaseCanvas(stageImg);
      stageImg = null;
    }
    if (opened) {
      const o = opened;
      opened = null;
      await o.close().catch(() => {});
    }
  }

  async function reset() {
    await releaseDoc();
    sourceFile = null;
    active = -1;
    result = null;
    editor.setSelected(-1);
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    strip.hidden = true;
    strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
    widgetTitle.textContent = "Black out anything private";
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
  qualityInput.addEventListener("change", () => syncControls());

  undoBtn.addEventListener("click", () => {
    regions().pop();
    editor.setSelected(-1);
    updateHint();
    renderStrip();
    editor.draw();
  });
  clearBtn.addEventListener("click", () => {
    if (active >= 0 && pages[active]) pages[active].regions = [];
    editor.setSelected(-1);
    updateHint();
    renderStrip();
    editor.draw();
  });

  // Headers, footers and address blocks sit at the same place on every page of
  // a document, which makes this far more useful here than it is on a batch of
  // photos. Boxes are normalised, so it survives mixed page sizes.
  applyAllBtn.addEventListener("click", () => {
    if (active < 0 || !pages[active]) return;
    const src = pages[active].regions;
    if (!src.length) return;
    pages.forEach((pg, i) => {
      if (i === active) return;
      pg.regions = src.map((r) => ({ ...r }));
    });
    updateHint(
      `Copied ${plural(src.length, "box")} onto all ${pages.length} pages. Click any page to check it — a box that fits page 1 may not fit page 4.`,
    );
    renderStrip();
  });

  applyBtn.addEventListener("click", () => void exportPdf());
  cancelBtn?.addEventListener("click", () => {
    cancelled = true;
  });
  downloadBtn.addEventListener("click", () => {
    if (result) saveBlob(result.blob, result.name);
  });
  anotherBtn.addEventListener("click", () => void reset());
  tryAnotherBtn.addEventListener("click", () => void reset());

  pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = pwInput.value;
    if (!pw) return;
    void openAndBuild(pw);
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

  updateHint();
}
