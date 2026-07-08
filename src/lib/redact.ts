// -----------------------------------------------------------------------
// Redaction engine — shared by blur-face, pixelate-image, blur-license-plate.
//
// The user drops one image, drags one or more rectangles over the areas to
// hide, and picks an effect (blur or pixelate) + strength. The effect is
// rendered live on a stage canvas at preview resolution, then re-applied at
// the image's FULL resolution on export so the obscured pixels are baked in
// irreversibly — there is no overlay to peel off. Everything runs on the
// Canvas API; no library, no upload.
//
// Coordinates are stored normalised (0–1, relative to the image) so the same
// region maps cleanly onto both the scaled preview and the full-res export,
// independent of device-pixel-ratio or display size.
// -----------------------------------------------------------------------

export type Effect = "blur" | "pixelate" | "blackout";

// Per-effect labels, kept in one place so hint/filename stay in sync.
// (The header pill label lives in the component now — effect is fixed per page.)
const EFFECT_VERB: Record<Effect, string> = {
  blur: "blurred",
  pixelate: "pixelated",
  blackout: "blacked out",
};
const EFFECT_SUFFIX: Record<Effect, string> = {
  blur: "blurred",
  pixelate: "pixelated",
  blackout: "redacted",
};

/** A redaction region in normalised image space (x,y = top-left, 0–1). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Panel = "drop" | "editor" | "processing" | "done" | "error";
type Mode = "idle" | "creating" | "moving" | "resizing";
type Corner = "nw" | "ne" | "se" | "sw";

const MAX_SIZE_MB = 50;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const MAX_STAGE = 1400; // longest-side backing resolution for the preview canvas
const HANDLE_CSS = 11; // resize-handle hit size, in CSS pixels
const MIN_REGION = 0.012; // discard drags smaller than this (normalised)

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function makeCanvas(
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
}

/** Normalise a rect so width/height are positive (top-left origin). */
function normalise(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

export function initRedactWidget(root: HTMLElement): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;
  const de = root.dataset.defaultEffect;
  const defaultEffect: Effect =
    de === "pixelate" ? "pixelate" : de === "blackout" ? "blackout" : "blur";

  // ---- Elements ----
  const panels: Record<Panel, HTMLElement> = {
    drop: q('[data-panel="drop"]'),
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
  // Strength only renders on blur/pixelate pages (blackout ignores it) — may be absent.
  const strengthInput = root.querySelector<HTMLInputElement>(
    '[data-el="strength"]',
  );
  const undoBtn = q<HTMLButtonElement>('[data-el="undo-btn"]');
  const clearBtn = q<HTMLButtonElement>('[data-el="clear-btn"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const editorHint = q('[data-el="editor-hint"]');
  const widgetTitle = q('[data-el="widget-title"]');
  const donePreview = q('[data-el="done-preview"]');
  const doneTitle = q('[data-el="done-title"]');
  const doneSub = q('[data-el="done-sub"]');
  const downloadBtn = q('[data-el="download-btn"]');
  const anotherBtn = q('[data-el="another-btn"]');
  const errTitle = q('[data-el="err-title"]');
  const errMessage = q('[data-el="err-message"]');
  const tryAnotherBtn = q('[data-el="try-another-btn"]');

  // ---- State ----
  let bitmap: ImageBitmap | null = null;
  let baseCanvas: HTMLCanvasElement | null = null; // full-resolution source image
  let stageImg: HTMLCanvasElement | null = null; // image drawn at stage resolution (preview sampling source)
  let iw = 0;
  let ih = 0;
  let regions: Rect[] = [];
  let selected = -1;
  const effect: Effect = defaultEffect; // fixed per page — no in-widget switching
  let strength = 3;
  let mode: Mode = "idle";
  let activeCorner: Corner | null = null;
  let dragStart = { x: 0, y: 0 };
  let dragOrigin: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let sourceFile: File | null = null;
  let resultBlob: Blob | null = null;
  let resultName = "";
  let doneUrl: string | null = null;

  function showPanel(name: Panel) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
  }

  // ---- Effect maths (resolution-independent: scaled to region size) ----
  function blurRadius(minSidePx: number): number {
    const frac = 0.045 * strength + 0.035; // strength 1 → 0.08 … 5 → 0.26 of the shorter side
    return Math.max(3, Math.round(minSidePx * frac));
  }
  function blockSize(minSidePx: number): number {
    const blocksAcross = [16, 12, 9, 6, 4][strength - 1] ?? 9; // higher strength → coarser
    return Math.max(4, Math.round(minSidePx / blocksAcross));
  }

  // Produce the obscured tile for one region, sampled from `src` at the given
  // pixel rect. Returns the inner region canvas plus where to paste it. Blur
  // uses a padded crop so edges sample real neighbours (clean, no transparent
  // ring) while only the region itself is written back.
  function processRegion(
    src: HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number,
  ): { canvas: HTMLCanvasElement; dx: number; dy: number } | null {
    if (w < 2 || h < 2) return null;
    const minSide = Math.min(w, h);

    if (effect === "blackout") {
      // Solid fill — the strongest redaction: the underlying pixels are
      // replaced outright, so nothing remains to recover. Ignores strength.
      const inner = makeCanvas(w, h);
      inner.ctx.fillStyle = "#000000";
      inner.ctx.fillRect(0, 0, w, h);
      return { canvas: inner.canvas, dx: x, dy: y };
    }

    if (effect === "blur") {
      // Blur by averaging: shrink the region down, then scale it back up with
      // smoothing on. We deliberately avoid ctx.filter='blur()' — it is a
      // silent no-op in Safari/WebKit. Downscale in halving steps: a single
      // large downscale aliases high-frequency detail in WebKit (leaving the
      // region only half-blurred), whereas repeated 2× averaging is clean and
      // consistent across engines.
      const r = blurRadius(minSide);
      const dsW = Math.max(1, Math.round(w / r));
      const dsH = Math.max(1, Math.round(h / r));
      let curW = w;
      let curH = h;
      let cur = makeCanvas(curW, curH);
      cur.ctx.imageSmoothingEnabled = true;
      cur.ctx.imageSmoothingQuality = "high";
      cur.ctx.drawImage(src, x, y, w, h, 0, 0, curW, curH);
      while (curW > dsW * 2 || curH > dsH * 2) {
        const nW = Math.max(dsW, Math.floor(curW / 2));
        const nH = Math.max(dsH, Math.floor(curH / 2));
        const next = makeCanvas(nW, nH);
        next.ctx.imageSmoothingEnabled = true;
        next.ctx.imageSmoothingQuality = "high";
        next.ctx.drawImage(cur.canvas, 0, 0, curW, curH, 0, 0, nW, nH);
        cur = next;
        curW = nW;
        curH = nH;
      }
      // Final clean downscale to the exact target size, then upscale back.
      const small = makeCanvas(dsW, dsH);
      small.ctx.imageSmoothingEnabled = true;
      small.ctx.imageSmoothingQuality = "high";
      small.ctx.drawImage(cur.canvas, 0, 0, curW, curH, 0, 0, dsW, dsH);
      const inner = makeCanvas(w, h);
      inner.ctx.imageSmoothingEnabled = true;
      inner.ctx.imageSmoothingQuality = "high";
      inner.ctx.drawImage(small.canvas, 0, 0, dsW, dsH, 0, 0, w, h);
      return { canvas: inner.canvas, dx: x, dy: y };
    }

    // Pixelate: average down, then scale back up with smoothing off (blocks).
    const block = blockSize(minSide);
    const smallW = Math.max(1, Math.round(w / block));
    const smallH = Math.max(1, Math.round(h / block));
    const small = makeCanvas(smallW, smallH);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.drawImage(src, x, y, w, h, 0, 0, smallW, smallH);
    const inner = makeCanvas(w, h);
    inner.ctx.imageSmoothingEnabled = false;
    inner.ctx.drawImage(small.canvas, 0, 0, smallW, smallH, 0, 0, w, h);
    return { canvas: inner.canvas, dx: x, dy: y };
  }

  // ---- Stage rendering ----
  function stageToNorm(
    el: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  }

  function cornerPoints(r: Rect): Record<Corner, { x: number; y: number }> {
    return {
      nw: { x: r.x, y: r.y },
      ne: { x: r.x + r.w, y: r.y },
      se: { x: r.x + r.w, y: r.y + r.h },
      sw: { x: r.x, y: r.y + r.h },
    };
  }

  function draw() {
    if (!stageImg) return;
    const ctx = stage.getContext("2d")!;
    const W = stage.width;
    const H = stage.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(stageImg, 0, 0, W, H);

    // Baked-look preview: each region drawn with the real effect.
    for (const rc of regions) {
      const px = Math.round(rc.x * W);
      const py = Math.round(rc.y * H);
      const pw = Math.round(rc.w * W);
      const ph = Math.round(rc.h * H);
      const tile = processRegion(stageImg, px, py, pw, ph);
      if (tile) ctx.drawImage(tile.canvas, tile.dx, tile.dy);
    }

    // UI chrome (outlines + handles) — not baked into the export.
    const cssW = stage.getBoundingClientRect().width || W;
    const ratio = W / cssW;
    const handle = HANDLE_CSS * ratio;
    regions.forEach((rc, i) => {
      const x = rc.x * W;
      const y = rc.y * H;
      const w = rc.w * W;
      const h = rc.h * H;
      const isSel = i === selected;
      ctx.lineWidth = Math.max(1.5, ratio * 1.5);
      ctx.strokeStyle = isSel ? "#4d8bff" : "rgba(255,255,255,0.9)";
      ctx.setLineDash(isSel ? [] : [ratio * 5, ratio * 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      if (isSel) {
        const pts = cornerPoints({ x: x, y: y, w: w, h: h });
        ctx.fillStyle = "#4d8bff";
        for (const key of Object.keys(pts) as Corner[]) {
          const p = pts[key];
          ctx.beginPath();
          ctx.arc(p.x, p.y, handle * 0.55, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = ratio;
          ctx.stroke();
        }
      }
    });
  }

  function updateHint() {
    const n = regions.length;
    if (n === 0) {
      editorHint.textContent =
        "Drag a box over the area you want to hide. Add as many as you need.";
    } else {
      const verb = EFFECT_VERB[effect];
      editorHint.textContent = `${n} area${n !== 1 ? "s" : ""} will be ${verb}. Drag to add more, or click one to move, resize, or delete it.`;
    }
    applyBtn.disabled = n === 0;
    undoBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
  }

  // ---- Hit testing ----
  function hitCorner(rc: Rect, p: { x: number; y: number }): Corner | null {
    const rect = stage.getBoundingClientRect();
    const tolX = HANDLE_CSS / (rect.width || 1);
    const tolY = HANDLE_CSS / (rect.height || 1);
    const pts = cornerPoints(rc);
    for (const key of Object.keys(pts) as Corner[]) {
      const c = pts[key];
      if (Math.abs(p.x - c.x) <= tolX && Math.abs(p.y - c.y) <= tolY)
        return key;
    }
    return null;
  }
  function insideRect(rc: Rect, p: { x: number; y: number }): boolean {
    return (
      p.x >= rc.x && p.x <= rc.x + rc.w && p.y >= rc.y && p.y <= rc.y + rc.h
    );
  }
  // Topmost region under the point (regions drawn in order → last wins).
  function regionAt(p: { x: number; y: number }): number {
    for (let i = regions.length - 1; i >= 0; i--)
      if (insideRect(regions[i], p)) return i;
    return -1;
  }

  // ---- Pointer interaction ----
  function onPointerDown(e: PointerEvent) {
    if (!bitmap) return;
    stage.setPointerCapture(e.pointerId);
    stage.focus();
    const p = stageToNorm(stage, e.clientX, e.clientY);
    dragStart = p;

    // Resize handle of the selected region takes priority.
    if (selected >= 0) {
      const corner = hitCorner(regions[selected], p);
      if (corner) {
        mode = "resizing";
        activeCorner = corner;
        dragOrigin = { ...regions[selected] };
        return;
      }
    }
    const hit = regionAt(p);
    if (hit >= 0) {
      selected = hit;
      mode = "moving";
      dragOrigin = { ...regions[hit] };
      updateHint();
      draw();
      return;
    }
    // Empty space → start a new region.
    selected = regions.length;
    regions.push({ x: p.x, y: p.y, w: 0, h: 0 });
    mode = "creating";
    dragOrigin = { x: p.x, y: p.y, w: 0, h: 0 };
    draw();
  }

  function onPointerMove(e: PointerEvent) {
    const p = stageToNorm(stage, e.clientX, e.clientY);

    if (mode === "idle") {
      updateCursor(p);
      return;
    }
    if (selected < 0) return;

    if (mode === "creating") {
      regions[selected] = {
        x: dragOrigin.x,
        y: dragOrigin.y,
        w: p.x - dragOrigin.x,
        h: p.y - dragOrigin.y,
      };
    } else if (mode === "moving") {
      const dx = p.x - dragStart.x;
      const dy = p.y - dragStart.y;
      const nx = clamp(dragOrigin.x + dx, 0, 1 - dragOrigin.w);
      const ny = clamp(dragOrigin.y + dy, 0, 1 - dragOrigin.h);
      regions[selected] = { x: nx, y: ny, w: dragOrigin.w, h: dragOrigin.h };
    } else if (mode === "resizing" && activeCorner) {
      let { x, y, w, h } = dragOrigin;
      const right = x + w;
      const bottom = y + h;
      if (activeCorner === "nw")
        regions[selected] = normalise({
          x: p.x,
          y: p.y,
          w: right - p.x,
          h: bottom - p.y,
        });
      else if (activeCorner === "ne")
        regions[selected] = normalise({
          x: x,
          y: p.y,
          w: p.x - x,
          h: bottom - p.y,
        });
      else if (activeCorner === "se")
        regions[selected] = normalise({ x: x, y: y, w: p.x - x, h: p.y - y });
      else
        regions[selected] = normalise({
          x: p.x,
          y: y,
          w: right - p.x,
          h: p.y - y,
        });
    }
    draw();
  }

  function onPointerUp(e: PointerEvent) {
    if (stage.hasPointerCapture(e.pointerId))
      stage.releasePointerCapture(e.pointerId);
    if (mode === "creating" && selected >= 0) {
      const rc = normalise(regions[selected]);
      if (rc.w < MIN_REGION || rc.h < MIN_REGION) {
        regions.splice(selected, 1); // too small — treat as a click, discard
        selected = -1;
      } else {
        regions[selected] = rc;
      }
    } else if (mode === "resizing" && selected >= 0) {
      regions[selected] = normalise(regions[selected]);
    }
    mode = "idle";
    activeCorner = null;
    updateHint();
    draw();
  }

  function updateCursor(p: { x: number; y: number }) {
    let cursor = "crosshair";
    if (selected >= 0) {
      const corner = hitCorner(regions[selected], p);
      if (corner === "nw" || corner === "se") cursor = "nwse-resize";
      else if (corner === "ne" || corner === "sw") cursor = "nesw-resize";
      else if (regionAt(p) >= 0) cursor = "move";
    } else if (regionAt(p) >= 0) {
      cursor = "move";
    }
    stage.style.cursor = cursor;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (selected < 0) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const rc = regions[selected];
    if (e.key === "Delete" || e.key === "Backspace") {
      regions.splice(selected, 1);
      selected = -1;
      e.preventDefault();
    } else if (e.key === "Escape") {
      selected = -1;
    } else if (e.key === "ArrowLeft") {
      rc.x = clamp(rc.x - step, 0, 1 - rc.w);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      rc.x = clamp(rc.x + step, 0, 1 - rc.w);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      rc.y = clamp(rc.y - step, 0, 1 - rc.h);
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      rc.y = clamp(rc.y + step, 0, 1 - rc.h);
      e.preventDefault();
    } else {
      return;
    }
    updateHint();
    draw();
  }

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", () => {
    if (bitmap) draw();
  });

  // ---- Strength control (blur/pixelate only; blackout omits it) ----
  strengthInput?.addEventListener("input", () => {
    strength = parseInt(strengthInput.value, 10) || 3;
    draw();
  });

  undoBtn.addEventListener("click", () => {
    regions.pop();
    selected = -1;
    updateHint();
    draw();
  });
  clearBtn.addEventListener("click", () => {
    regions = [];
    selected = -1;
    updateHint();
    draw();
  });

  // ---- File intake ----
  function formatBytes(b: number): string {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function acceptFile(file: File) {
    if (!file.type.startsWith("image/")) {
      showError(
        "Unsupported file type",
        "Please choose an image file — JPEG, PNG, or WebP.",
      );
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      showError(
        "File too large",
        `${file.name} is ${formatBytes(file.size)}. The limit is ${MAX_SIZE_MB} MB.`,
      );
      return;
    }
    try {
      const bmp = await createImageBitmap(file);
      closeBitmap();
      bitmap = bmp;
      iw = bmp.width;
      ih = bmp.height;
      sourceFile = file;

      const base = makeCanvas(iw, ih);
      base.ctx.drawImage(bmp, 0, 0);
      baseCanvas = base.canvas;

      const scale = Math.min(1, MAX_STAGE / Math.max(iw, ih));
      const sw = Math.round(iw * scale);
      const sh = Math.round(ih * scale);
      stage.width = sw;
      stage.height = sh;
      stage.style.aspectRatio = `${iw} / ${ih}`;
      const si = makeCanvas(sw, sh);
      si.ctx.drawImage(bmp, 0, 0, sw, sh);
      stageImg = si.canvas;

      regions = [];
      selected = -1;
      if (strengthInput) strengthInput.value = String(strength);
      widgetTitle.textContent = "Draw over what to hide";
      updateHint();
      draw();
      showPanel("editor");
    } catch {
      showError(
        "We couldn't open that image",
        "The file looks corrupted or is in a format your browser cannot decode.",
      );
    }
  }

  // ---- Apply + export ----
  async function apply() {
    if (!baseCanvas || regions.length === 0 || !sourceFile) return;
    showPanel("processing");
    widgetTitle.textContent = "Applying…";

    // Yield a frame so the processing state paints before the (sync) encode.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    try {
      const out = makeCanvas(iw, ih);
      out.ctx.drawImage(baseCanvas, 0, 0);
      for (const rc of regions) {
        const x = Math.round(rc.x * iw);
        const y = Math.round(rc.y * ih);
        const w = Math.round(rc.w * iw);
        const h = Math.round(rc.h * ih);
        const tile = processRegion(baseCanvas, x, y, w, h);
        if (tile) out.ctx.drawImage(tile.canvas, tile.dx, tile.dy);
      }

      const isJpeg =
        /jpe?g/i.test(sourceFile.type) || /\.jpe?g$/i.test(sourceFile.name);
      const outType = isJpeg ? "image/jpeg" : "image/png";
      const ext = isJpeg ? "jpg" : "png";
      const blob = await new Promise<Blob>((resolve, reject) => {
        out.canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
          outType,
          0.92,
        );
      });

      const stem = sourceFile.name.replace(/\.[^.]+$/, "");
      resultBlob = blob;
      resultName = `${stem}-${EFFECT_SUFFIX[effect]}.${ext}`;
      showDone();
    } catch {
      showError(
        "We couldn't finish that image",
        "Something went wrong while rendering the result. Try a smaller image or fewer regions.",
      );
    }
  }
  applyBtn.addEventListener("click", apply);

  function showDone() {
    if (!resultBlob) return;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    doneUrl = URL.createObjectURL(resultBlob);
    donePreview.innerHTML = "";
    const img = document.createElement("img");
    img.src = doneUrl;
    img.alt = `Your image with ${regions.length} area${regions.length !== 1 ? "s" : ""} ${EFFECT_VERB[effect]}`;
    img.decoding = "async";
    donePreview.appendChild(img);

    const n = regions.length;
    const verb = EFFECT_VERB[effect];
    doneTitle.textContent = `Done — ${n} area${n !== 1 ? "s" : ""} ${verb}`;
    doneSub.textContent = `${formatBytes(resultBlob.size)} · baked in for good, and it never left your device`;
    widgetTitle.textContent = "Ready to download";
    showPanel("done");
  }

  function download() {
    if (!resultBlob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(resultBlob);
    a.download = resultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  downloadBtn.addEventListener("click", download);

  // ---- Reset / error ----
  function closeBitmap() {
    if (bitmap) bitmap.close();
    bitmap = null;
  }
  function reset() {
    closeBitmap();
    baseCanvas = null;
    stageImg = null;
    regions = [];
    selected = -1;
    resultBlob = null;
    sourceFile = null;
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    widgetTitle.textContent = "Hide anything private";
    showPanel("drop");
  }
  anotherBtn.addEventListener("click", reset);
  tryAnotherBtn.addEventListener("click", reset);

  function showError(title: string, message: string) {
    errTitle.textContent = title;
    errMessage.textContent = message;
    widgetTitle.textContent = "Something went wrong";
    showPanel("error");
  }

  // ---- Drop zone wiring ----
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("is-drag");
    dzTitle.textContent = "Drop to load your image";
  });
  ["dragleave", "dragend"].forEach((ev) =>
    dropzone.addEventListener(ev, () => {
      dropzone.classList.remove("is-drag");
      dzTitle.textContent = "Drag & drop your image";
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-drag");
    dzTitle.textContent = "Drag & drop your image";
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) acceptFile(file);
    fileInput.value = "";
  });

  // Initial paint.
  updateHint();
}
