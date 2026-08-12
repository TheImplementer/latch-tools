// -----------------------------------------------------------------------
// Redaction engine — shared by blur-face, pixelate-image, blur-license-plate.
//
// The user drops one or more images, drags rectangles over the areas to hide,
// and picks an effect (blur or pixelate) + strength. The effect is rendered
// live on a stage canvas at preview resolution, then re-applied at each
// image's FULL resolution on export so the obscured pixels are baked in
// irreversibly — there is no overlay to peel off. Everything runs on the
// Canvas API; no library (bar a lazy JSZip for multi-file download), no upload.
//
// Coordinates are stored normalised (0–1, relative to the image) so the same
// region maps cleanly onto both the scaled preview and the full-res export,
// independent of device-pixel-ratio or display size — and so a set of boxes
// can be copied across a batch of similarly-framed photos ("apply to all").
//
// Memory: we never hold N full-resolution images. Each item keeps only a tiny
// thumbnail plus its regions; the stage canvas exists for the active item
// alone, and export decodes one file at a time and releases it straight after.
// -----------------------------------------------------------------------

// Type-only: erased at build, so this does NOT create a static edge to the
// detector. src/lib/detect.ts must only ever be reached via `await import()`
// from inside the click handler, or ONNX Runtime lands in the eager bundle.
import type { DetectKind, Detection } from "./detect";

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

/** One queued image. Deliberately holds no full-res pixels — see header note. */
interface Item {
  file: File;
  iw: number;
  ih: number;
  thumbUrl: string;
  regions: Rect[];
}

interface Result {
  name: string;
  blob: Blob;
  areas: number;
}

type Panel = "drop" | "editor" | "processing" | "done" | "error";
type Mode = "idle" | "creating" | "moving" | "resizing";
type Corner = "nw" | "ne" | "se" | "sw";

const MAX_SIZE_MB = 50;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const MAX_FILES = 30;
const MAX_STAGE = 1400; // longest-side backing resolution for the preview canvas
const THUMB = 96; // filmstrip thumbnail longest side
const HANDLE_CSS = 11; // resize-handle hit size, in CSS pixels
const MIN_REGION = 0.012; // discard drags smaller than this (normalised)
const EFFECT_PREVIEW_MAX = 16; // above this, skip the effect pass mid-drag

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function initRedactWidget(root: HTMLElement): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;
  const de = root.dataset.defaultEffect;
  const defaultEffect: Effect =
    de === "pixelate" ? "pixelate" : de === "blackout" ? "blackout" : "blur";

  // Auto-detection is opt-in per page. `null` everywhere it isn't configured,
  // in which case no button exists and none of the detect code path runs.
  const dk = root.dataset.detect;
  const detectKind: DetectKind | null =
    dk === "face" || dk === "plate" ? dk : null;
  const detectNoun = root.dataset.detectNoun ?? "faces";
  const detectOne = detectNoun.replace(/s$/, "");

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
  // Optional like strengthInput — q() would hand back a null typed as
  // HTMLElement on the pages that don't render these.
  const detectBtn = root.querySelector<HTMLButtonElement>(
    '[data-el="detect-btn"]',
  );
  const detectSpin = root.querySelector<HTMLElement>('[data-el="detect-spin"]');
  const detectLabelEl = root.querySelector<HTMLElement>(
    '[data-el="detect-label"]',
  );
  const detectCancelBtn = root.querySelector<HTMLButtonElement>(
    '[data-el="detect-cancel"]',
  );
  const detectCancelRow = root.querySelector<HTMLElement>(
    '[data-el="detect-cancel-row"]',
  );
  const undoBtn = q<HTMLButtonElement>('[data-el="undo-btn"]');
  const clearBtn = q<HTMLButtonElement>('[data-el="clear-btn"]');
  const applyAllBtn = q<HTMLButtonElement>('[data-el="apply-all-btn"]');
  const applyBtn = q<HTMLButtonElement>('[data-el="apply-btn"]');
  const applyLabelEl = q('[data-el="apply-label"]');
  const editorHint = q('[data-el="editor-hint"]');
  const strip = q('[data-el="filmstrip"]');
  const stripAddBtn = q<HTMLButtonElement>('[data-el="strip-add"]');
  const widgetTitle = q('[data-el="widget-title"]');
  const procTitle = q('[data-el="proc-title"]');
  const procSub = q('[data-el="proc-sub"]');
  const procMeter = q('[data-el="proc-meter"]');
  const procFill = q('[data-el="proc-fill"]');
  const procCount = q('[data-el="proc-count"]');
  const procPct = q('[data-el="proc-pct"]');
  const donePreview = q('[data-el="done-preview"]');
  const doneTitle = q('[data-el="done-title"]');
  const doneSub = q('[data-el="done-sub"]');
  const downloadBtn = q('[data-el="download-btn"]');
  const downloadLabelEl = q('[data-el="download-label"]');
  const anotherBtn = q('[data-el="another-btn"]');
  const errTitle = q('[data-el="err-title"]');
  const errMessage = q('[data-el="err-message"]');
  const tryAnotherBtn = q('[data-el="try-another-btn"]');

  // ---- State ----
  let items: Item[] = [];
  let active = -1;
  let stageImg: HTMLCanvasElement | null = null; // active item, at stage resolution
  let selected = -1;
  const effect: Effect = defaultEffect; // fixed per page — no in-widget switching
  let strength = 3;
  let mode: Mode = "idle";
  let activeCorner: Corner | null = null;
  let dragStart = { x: 0, y: 0 };
  let dragOrigin: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let results: Result[] = [];
  let doneUrl: string | null = null;
  let detectBusy = false;
  let detectCancelled = false;
  // Set when the runtime can't start at all — retrying won't help, so the
  // button goes away rather than offering something that can only fail.
  let detectDead = false;

  /** Regions of the item currently on the stage. Empty array when none loaded. */
  function regions(): Rect[] {
    return active >= 0 && items[active] ? items[active].regions : [];
  }
  function totalRegions(): number {
    return items.reduce((n, it) => n + it.regions.length, 0);
  }
  function itemsWithRegions(): Item[] {
    return items.filter((it) => it.regions.length > 0);
  }

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

    const rs = regions();

    // Baked-look preview: each region drawn with the real effect.
    //
    // processRegion is expensive (blur runs a halving-downscale chain) and this
    // function fires on every pointermove. Hand-drawn counts stay in the low
    // single digits, but auto-detect can put 40+ boxes on a crowd shot, so
    // while a drag is in flight we skip the effect pass and let the outlines
    // below carry the interaction. Releasing the pointer repaints in full.
    const liveDrag = mode !== "idle" && rs.length > EFFECT_PREVIEW_MAX;
    if (!liveDrag) {
      for (const rc of rs) {
        const px = Math.round(rc.x * W);
        const py = Math.round(rc.y * H);
        const pw = Math.round(rc.w * W);
        const ph = Math.round(rc.h * H);
        const tile = processRegion(stageImg, px, py, pw, ph);
        if (tile) ctx.drawImage(tile.canvas, tile.dx, tile.dy);
      }
    }

    // UI chrome (outlines + handles) — not baked into the export.
    const cssW = stage.getBoundingClientRect().width || W;
    const ratio = W / cssW;
    const handle = HANDLE_CSS * ratio;
    rs.forEach((rc, i) => {
      const x = rc.x * W;
      const y = rc.y * H;
      const w = rc.w * W;
      const h = rc.h * H;
      const isSel = i === selected;
      ctx.lineWidth = Math.max(1.5, ratio * 1.5);
      ctx.strokeStyle = isSel ? "#55c28b" : "rgba(255,255,255,0.9)";
      ctx.setLineDash(isSel ? [] : [ratio * 5, ratio * 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      if (isSel) {
        const pts = cornerPoints({ x: x, y: y, w: w, h: h });
        ctx.fillStyle = "#55c28b";
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

  // Repaint the hint line and re-derive every button's enabled state.
  //
  // `note` replaces the computed hint for one-off messages ("Copied 3 boxes
  // onto all 12 images"). It exists because this function owns editorHint
  // outright: a caller that set editorHint.textContent itself and then called
  // updateHint() had its message silently overwritten on the next line.
  function updateHint(note?: string) {
    const n = regions().length;
    const batch = items.length > 1;
    const where = batch ? ` on image ${active + 1}` : "";
    let hint: string;
    if (n === 0) {
      hint = batch
        ? `Drag a box over the area you want to hide${where}. Each image keeps its own boxes.`
        : "Drag a box over the area you want to hide. Add as many as you need.";
    } else {
      const verb = EFFECT_VERB[effect];
      hint = `${plural(n, "area")}${where} will be ${verb}. Drag to add more, or click one to move, resize, or delete it.`;
    }
    editorHint.textContent = note ?? hint;
    syncControls();
  }

  // Button enabled/disabled/label state, split out of updateHint so it can be
  // re-derived without overwriting a one-off note that is still on screen.
  function syncControls() {
    const n = regions().length;
    const batch = items.length > 1;
    undoBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
    applyAllBtn.disabled = n === 0 || items.length < 2;
    applyAllBtn.hidden = items.length < 2;

    if (detectBtn) {
      detectBtn.hidden = !detectKind || detectDead;
      detectBtn.disabled = detectBusy || items.length === 0;
      if (detectLabelEl && !detectBusy) {
        const base = detectLabelEl.dataset.base ?? "Find";
        detectLabelEl.textContent = batch
          ? `${base} in all ${items.length}`
          : base;
      }
    }

    // Export is enabled by ANY marked-up image, not just the visible one.
    const total = totalRegions();
    applyBtn.disabled = total === 0;
    const base =
      applyLabelEl.dataset.base ?? applyLabelEl.textContent ?? "Apply";
    const marked = itemsWithRegions().length;
    applyLabelEl.textContent =
      batch && marked > 0 ? `${base} (${marked}/${items.length})` : base;
  }

  // ---- Filmstrip ----
  function renderStrip() {
    strip.hidden = items.length < 2;
    if (items.length < 2) {
      strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
      return;
    }
    strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
    items.forEach((it, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "strip-item" + (i === active ? " is-active" : "");
      btn.dataset.thumb = String(i);
      btn.setAttribute(
        "aria-label",
        `Image ${i + 1} of ${items.length}: ${it.file.name}${it.regions.length ? `, ${plural(it.regions.length, "area")} marked` : ", no areas marked"}`,
      );
      if (i === active) btn.setAttribute("aria-current", "true");
      const img = document.createElement("img");
      img.src = it.thumbUrl;
      img.alt = "";
      img.decoding = "async";
      btn.appendChild(img);
      if (it.regions.length) {
        const badge = document.createElement("span");
        badge.className = "strip-badge";
        badge.textContent = String(it.regions.length);
        badge.setAttribute("aria-hidden", "true");
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        if (i !== active) void setActive(i);
      });
      strip.insertBefore(btn, stripAddBtn);
    });
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
    const rs = regions();
    for (let i = rs.length - 1; i >= 0; i--) if (insideRect(rs[i], p)) return i;
    return -1;
  }

  // ---- Pointer interaction ----
  function onPointerDown(e: PointerEvent) {
    if (!stageImg) return;
    const rs = regions();
    stage.setPointerCapture(e.pointerId);
    stage.focus();
    const p = stageToNorm(stage, e.clientX, e.clientY);
    dragStart = p;

    // Resize handle of the selected region takes priority.
    if (selected >= 0 && rs[selected]) {
      const corner = hitCorner(rs[selected], p);
      if (corner) {
        mode = "resizing";
        activeCorner = corner;
        dragOrigin = { ...rs[selected] };
        return;
      }
    }
    const hit = regionAt(p);
    if (hit >= 0) {
      selected = hit;
      mode = "moving";
      dragOrigin = { ...rs[hit] };
      updateHint();
      draw();
      return;
    }
    // Empty space → start a new region.
    selected = rs.length;
    rs.push({ x: p.x, y: p.y, w: 0, h: 0 });
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
    const rs = regions();
    if (selected < 0 || !rs[selected]) return;

    if (mode === "creating") {
      rs[selected] = {
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
      rs[selected] = { x: nx, y: ny, w: dragOrigin.w, h: dragOrigin.h };
    } else if (mode === "resizing" && activeCorner) {
      const { x, y, w, h } = dragOrigin;
      const right = x + w;
      const bottom = y + h;
      if (activeCorner === "nw")
        rs[selected] = normalise({
          x: p.x,
          y: p.y,
          w: right - p.x,
          h: bottom - p.y,
        });
      else if (activeCorner === "ne")
        rs[selected] = normalise({
          x: x,
          y: p.y,
          w: p.x - x,
          h: bottom - p.y,
        });
      else if (activeCorner === "se")
        rs[selected] = normalise({ x: x, y: y, w: p.x - x, h: p.y - y });
      else
        rs[selected] = normalise({
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
    const rs = regions();
    if (mode === "creating" && selected >= 0 && rs[selected]) {
      const rc = normalise(rs[selected]);
      if (rc.w < MIN_REGION || rc.h < MIN_REGION) {
        rs.splice(selected, 1); // too small — treat as a click, discard
        selected = -1;
      } else {
        rs[selected] = rc;
      }
    } else if (mode === "resizing" && selected >= 0 && rs[selected]) {
      rs[selected] = normalise(rs[selected]);
    }
    mode = "idle";
    activeCorner = null;
    updateHint();
    renderStrip();
    draw();
  }

  function updateCursor(p: { x: number; y: number }) {
    const rs = regions();
    let cursor = "crosshair";
    if (selected >= 0 && rs[selected]) {
      const corner = hitCorner(rs[selected], p);
      if (corner === "nw" || corner === "se") cursor = "nwse-resize";
      else if (corner === "ne" || corner === "sw") cursor = "nesw-resize";
      else if (regionAt(p) >= 0) cursor = "move";
    } else if (regionAt(p) >= 0) {
      cursor = "move";
    }
    stage.style.cursor = cursor;
  }

  function onKeyDown(e: KeyboardEvent) {
    const rs = regions();
    if (selected < 0 || !rs[selected]) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const rc = rs[selected];
    if (e.key === "Delete" || e.key === "Backspace") {
      rs.splice(selected, 1);
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
    renderStrip();
    draw();
  }

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", () => {
    if (stageImg) draw();
  });

  // ---- Strength control (blur/pixelate only; blackout omits it) ----
  strengthInput?.addEventListener("input", () => {
    strength = parseInt(strengthInput.value, 10) || 3;
    draw();
  });

  undoBtn.addEventListener("click", () => {
    regions().pop();
    selected = -1;
    updateHint();
    renderStrip();
    draw();
  });
  clearBtn.addEventListener("click", () => {
    if (active >= 0 && items[active]) items[active].regions = [];
    selected = -1;
    updateHint();
    renderStrip();
    draw();
  });

  // Copy the current image's boxes onto every other image in the batch. The
  // whole point of bulk mode: listing/dashcam photos are framed alike, so one
  // box over the plate usually lands correctly on all of them. Boxes are
  // normalised, so this survives differing pixel dimensions.
  applyAllBtn.addEventListener("click", () => {
    if (active < 0 || !items[active]) return;
    const src = items[active].regions;
    if (!src.length) return;
    items.forEach((it, i) => {
      if (i === active) return;
      it.regions = src.map((r) => ({ ...r }));
    });
    updateHint(
      `Copied ${plural(src.length, "box")} onto all ${items.length} images. Click any thumbnail to check and adjust it.`,
    );
    renderStrip();
  });

  // ---- Auto-detection ----
  //
  // The detector proposes boxes; it never applies them. Everything it finds
  // lands in items[].regions as an ordinary Rect the user can move, resize or
  // delete, and export still needs an explicit click. Recall is good, not
  // perfect, so the copy below always asks the user to check the result.

  // A detected box is tight — YuNet frames eyebrows-to-chin, ear-to-ear, which
  // leaves identifiable hair and jawline outside the blur. Plates need far less
  // (over-padding there just obscures bodywork).
  const DETECT_PAD: Record<
    DetectKind,
    { x: number; top: number; bot: number }
  > = {
    face: { x: 0.14, top: 0.28, bot: 0.14 },
    plate: { x: 0.1, top: 0.12, bot: 0.12 },
  };
  // Longest side we decode to for detection. Above the model's own input, well
  // below full res — the point is to keep memory flat across a batch.
  const DETECT_SOURCE_MAX = 1024;
  const DETECT_DEDUPE_IOU = 0.35;
  const MAX_REGIONS_PER_ITEM = 60;

  function rectIou(a: Rect, b: Rect): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = x2 - x1;
    const ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return 0;
    const inter = iw * ih;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  /**
   * Merge detections into one item's regions. Returns how many were added.
   *
   * Merges, never replaces: hand-drawn boxes are the user's work and there is
   * no undo deeper than a single pop(). Skipping anything that overlaps an
   * existing box also makes re-running detect idempotent.
   */
  function addDetections(it: Item, dets: Detection[]): number {
    if (!detectKind) return 0;
    const pad = DETECT_PAD[detectKind];
    let added = 0;

    for (const d of dets) {
      if (it.regions.length >= MAX_REGIONS_PER_ITEM) break;

      const px = d.w * pad.x;
      const x = clamp(d.x - px, 0, 1);
      const y = clamp(d.y - d.h * pad.top, 0, 1);
      const r: Rect = {
        x,
        y,
        w: clamp(d.x + d.w + px, 0, 1) - x,
        h: clamp(d.y + d.h + d.h * pad.bot, 0, 1) - y,
      };

      // Same floor the manual path enforces on pointerup — a detector box the
      // drag path would have rejected is an inconsistency users hit on resize.
      if (r.w < MIN_REGION || r.h < MIN_REGION) continue;
      if (it.regions.some((e) => rectIou(e, r) > DETECT_DEDUPE_IOU)) continue;

      it.regions.push(r);
      added++;
    }
    return added;
  }

  function setDetectBusy(on: boolean, label?: string) {
    detectBusy = on;
    if (detectSpin) detectSpin.hidden = !on;
    if (detectBtn) detectBtn.setAttribute("aria-busy", on ? "true" : "false");
    if (detectLabelEl && label) detectLabelEl.textContent = label;
  }

  /** Plain-language, never a stack. Detection failing must not lose any work. */
  function detectMessage(e: unknown): string {
    const reason =
      e && typeof e === "object" && "reason" in e
        ? (e as { reason: string }).reason
        : "run";
    if (reason === "fetch")
      return `Couldn't load the ${detectOne} finder — you may be offline. You can still draw boxes by hand.`;
    if (reason === "unsupported" || reason === "init")
      return `The ${detectOne} finder can't run in this browser. Draw boxes by hand instead — everything else works.`;
    return `The ${detectOne} finder ran into a problem. Draw boxes by hand instead.`;
  }

  /** Decode one queued item small enough for the detector, aspect preserved. */
  function decodeForDetect(it: Item): Promise<ImageBitmap> {
    const long = Math.max(it.iw, it.ih);
    if (long <= DETECT_SOURCE_MAX) return createImageBitmap(it.file);
    // Supplying only one dimension keeps the aspect ratio.
    return createImageBitmap(
      it.file,
      it.iw >= it.ih
        ? { resizeWidth: DETECT_SOURCE_MAX, resizeQuality: "high" }
        : { resizeHeight: DETECT_SOURCE_MAX, resizeQuality: "high" },
    );
  }

  function foundSummary(added: number, imagesHit: number, skipped: number) {
    const tail = skipped
      ? ` (${plural(skipped, "image")} couldn't be scanned.)`
      : "";
    if (added === 0) {
      return `No ${detectNoun} found automatically. Drag a box over anything you want to hide.${tail}`;
    }
    const where =
      items.length > 1
        ? ` across ${imagesHit} of ${items.length} images — click each thumbnail to check`
        : " — check the boxes";
    return `Found ${plural(added, detectOne)}${where}, and add any the finder missed.${tail}`;
  }

  async function runDetect() {
    if (!detectKind || detectBusy || items.length === 0) return;
    // Never mutate regions mid-drag: `selected` indexes into that array.
    if (mode !== "idle") return;

    const batch = items.length > 1;
    setDetectBusy(true, "Loading…");
    updateHint(`Looking for ${detectNoun}…`);

    let added = 0;
    let imagesHit = 0;
    let skipped = 0;
    detectCancelled = false;

    try {
      // The module chunk itself is a network fetch, so losing connectivity
      // fails here rather than inside detect(). Report it as such — "you may be
      // offline" is far more useful than a generic failure.
      const { detect, prewarm } = await import("./detect").catch(() => {
        throw { reason: "fetch" };
      });

      if (!batch) {
        setDetectBusy(true, "Finding…");
        // The active item is already decoded at stage resolution, so a
        // single-image run costs no extra decode.
        if (stageImg && items[active])
          added = addDetections(
            items[active],
            await detect(detectKind, stageImg),
          );
        if (added) imagesHit = 1;
        updateHint(foundSummary(added, imagesHit, skipped));
        return;
      }

      // Batch: same shape as apply() — processing panel, meter, yield a frame
      // between items so progress actually paints.
      procTitle.textContent = `Looking for ${detectNoun} in ${plural(items.length, "image")}`;
      procSub.textContent = "Running on your device — nothing is uploaded";
      procMeter.hidden = false;
      if (detectCancelRow) detectCancelRow.hidden = false;
      setProgress(0, items.length, `0 of ${items.length}`);
      widgetTitle.textContent = "Finding…";
      showPanel("processing");
      await raf();

      // Fetch runtime + weights before the bar starts, so the first tick isn't
      // a multi-second stall on a 13MB download.
      await prewarm(detectKind);

      for (let i = 0; i < items.length && !detectCancelled; i++) {
        setProgress(
          i,
          items.length,
          `${i + 1} of ${items.length} · ${items[i].file.name}`,
        );
        await raf();
        let bmp: ImageBitmap | null = null;
        try {
          const src =
            i === active && stageImg
              ? stageImg
              : (bmp = await decodeForDetect(items[i]));
          const n = addDetections(items[i], await detect(detectKind, src));
          added += n;
          if (n) imagesHit++;
        } catch {
          // One unreadable image must not abandon the whole batch.
          skipped++;
        } finally {
          bmp?.close();
        }
      }
      setProgress(items.length, items.length, "");
      showPanel("editor");
      updateHint(
        detectCancelled
          ? `Stopped. ${foundSummary(added, imagesHit, skipped)}`
          : foundSummary(added, imagesHit, skipped),
      );
    } catch (e) {
      // Deliberately NOT showError(): its only exit is reset(), which would
      // release every item and destroy boxes the user drew by hand. A failed
      // optional helper must never cost the user work.
      if (
        e &&
        typeof e === "object" &&
        "reason" in e &&
        ((e as { reason: string }).reason === "init" ||
          (e as { reason: string }).reason === "unsupported")
      ) {
        detectDead = true;
      }
      showPanel("editor");
      updateHint(detectMessage(e));
    } finally {
      if (detectCancelRow) detectCancelRow.hidden = true;
      widgetTitle.textContent =
        items.length > 1
          ? `Image ${active + 1} of ${items.length}`
          : "Draw over what to hide";
      setDetectBusy(false);
      // syncControls, not updateHint — the summary message must survive.
      syncControls();
      renderStrip();
      draw();
      // The button's ancestor was hidden while the processing panel was up, so
      // focus fell to <body>. Put it back where the user left it.
      if (detectBtn && !detectBtn.hidden && !detectBtn.disabled)
        detectBtn.focus();
    }
  }

  detectBtn?.addEventListener("click", () => void runDetect());
  detectCancelBtn?.addEventListener("click", () => {
    detectCancelled = true;
  });

  // ---- File intake ----
  function formatBytes(b: number): string {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function makeThumb(bmp: ImageBitmap): Promise<string> {
    const scale = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
    const t = makeCanvas(bmp.width * scale, bmp.height * scale);
    t.ctx.imageSmoothingEnabled = true;
    t.ctx.imageSmoothingQuality = "high";
    t.ctx.drawImage(bmp, 0, 0, t.canvas.width, t.canvas.height);
    const blob = await new Promise<Blob | null>((res) =>
      t.canvas.toBlob(res, "image/jpeg", 0.7),
    );
    return blob ? URL.createObjectURL(blob) : "";
  }

  function setProgress(done: number, total: number, label: string) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    procFill.style.width = pct + "%";
    procCount.textContent = label;
    procPct.textContent = pct + "%";
  }

  /** Build the stage canvas for one item. Decodes, draws, releases. */
  async function setActive(i: number) {
    const it = items[i];
    if (!it) return;
    active = i;
    selected = -1;
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(it.file);
      const scale = Math.min(1, MAX_STAGE / Math.max(it.iw, it.ih));
      const sw = Math.round(it.iw * scale);
      const sh = Math.round(it.ih * scale);
      stage.width = sw;
      stage.height = sh;
      stage.style.aspectRatio = `${it.iw} / ${it.ih}`;
      const si = makeCanvas(sw, sh);
      si.ctx.drawImage(bmp, 0, 0, sw, sh);
      stageImg = si.canvas;
    } finally {
      bmp?.close();
    }
    widgetTitle.textContent =
      items.length > 1
        ? `Image ${i + 1} of ${items.length}`
        : "Draw over what to hide";
    renderStrip();
    updateHint();
    draw();
  }

  /** Add files to the queue — used by both first drop and "Add more". */
  async function acceptFiles(list: File[], append = false) {
    const imgs = list.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) {
      showError(
        "Unsupported file type",
        "Please choose image files — JPEG, PNG, or WebP.",
      );
      return;
    }

    const room = MAX_FILES - (append ? items.length : 0);
    const chosen = imgs.slice(0, Math.max(0, room));
    const dropped = imgs.length - chosen.length;
    if (chosen.length === 0) {
      showError(
        "That's too many images",
        `You can work on up to ${MAX_FILES} images at once. Finish this batch, then start another.`,
      );
      return;
    }

    // Decoding a large batch takes a moment — show the working state.
    const showLoader = chosen.length > 1;
    if (showLoader) {
      procTitle.textContent = "Loading your images";
      procSub.textContent =
        "Reading them in your browser — nothing is uploaded";
      procMeter.hidden = false;
      setProgress(0, chosen.length, `0 of ${chosen.length}`);
      widgetTitle.textContent = "Loading…";
      showPanel("processing");
      await raf();
    }

    const accepted: Item[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i];
      if (showLoader) {
        setProgress(
          i,
          chosen.length,
          `${i + 1} of ${chosen.length} · ${f.name}`,
        );
        await raf();
      }
      if (f.size > MAX_SIZE_BYTES) {
        skipped.push(`${f.name} (${formatBytes(f.size)})`);
        continue;
      }
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await createImageBitmap(f);
        const thumbUrl = await makeThumb(bmp);
        accepted.push({
          file: f,
          iw: bmp.width,
          ih: bmp.height,
          thumbUrl,
          regions: [],
        });
      } catch {
        skipped.push(f.name);
      } finally {
        bmp?.close();
      }
    }

    if (accepted.length === 0) {
      showError(
        "We couldn't open those images",
        skipped.length === 1
          ? `${skipped[0]} is over the ${MAX_SIZE_MB} MB limit, corrupted, or in a format your browser cannot decode.`
          : `None of those files could be opened. They may be over the ${MAX_SIZE_MB} MB limit, corrupted, or in a format your browser cannot decode.`,
      );
      return;
    }

    if (append) {
      items = items.concat(accepted);
    } else {
      releaseItems();
      items = accepted;
    }

    if (strengthInput) strengthInput.value = String(strength);
    await setActive(append ? items.length - accepted.length : 0);
    showPanel("editor");

    // Non-fatal: some files were left out. Say so without losing the good ones.
    const notes: string[] = [];
    if (skipped.length)
      notes.push(
        `Skipped ${plural(skipped.length, "file")}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}.`,
      );
    if (dropped > 0)
      notes.push(`Only the first ${MAX_FILES} images were added.`);
    if (notes.length) editorHint.textContent = notes.join(" ");
  }

  // ---- Apply + export ----

  /** Bake the regions into one image at full resolution. */
  async function renderOne(it: Item): Promise<Result> {
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(it.file);
      const base = makeCanvas(it.iw, it.ih);
      base.ctx.drawImage(bmp, 0, 0);
      const out = makeCanvas(it.iw, it.ih);
      out.ctx.drawImage(base.canvas, 0, 0);
      for (const rc of it.regions) {
        const x = Math.round(rc.x * it.iw);
        const y = Math.round(rc.y * it.ih);
        const w = Math.round(rc.w * it.iw);
        const h = Math.round(rc.h * it.ih);
        const tile = processRegion(base.canvas, x, y, w, h);
        if (tile) out.ctx.drawImage(tile.canvas, tile.dx, tile.dy);
      }

      const isJpeg =
        /jpe?g/i.test(it.file.type) || /\.jpe?g$/i.test(it.file.name);
      const outType = isJpeg ? "image/jpeg" : "image/png";
      const ext = isJpeg ? "jpg" : "png";
      const blob = await new Promise<Blob>((resolve, reject) => {
        out.canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
          outType,
          0.92,
        );
      });
      const stem = it.file.name.replace(/\.[^.]+$/, "");
      return {
        name: `${stem}-${EFFECT_SUFFIX[effect]}.${ext}`,
        blob,
        areas: it.regions.length,
      };
    } finally {
      bmp?.close();
    }
  }

  async function apply() {
    const pending = itemsWithRegions();
    if (pending.length === 0) return;
    const batch = pending.length > 1;

    procTitle.textContent = batch
      ? `Rendering ${plural(pending.length, "image")}`
      : "Rendering your image";
    procSub.textContent = "Baking the effect in at full resolution";
    procMeter.hidden = !batch;
    setProgress(0, pending.length, batch ? `0 of ${pending.length}` : "");
    widgetTitle.textContent = "Applying…";
    showPanel("processing");

    // Yield a frame so the processing state paints before the (sync) encode.
    await raf();

    results = [];
    try {
      for (let i = 0; i < pending.length; i++) {
        if (batch) {
          setProgress(
            i,
            pending.length,
            `${i + 1} of ${pending.length} · ${pending[i].file.name}`,
          );
          await raf();
        }
        results.push(await renderOne(pending[i]));
      }
      setProgress(pending.length, pending.length, "");
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
    if (results.length === 0) return;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    const first = results[0];
    doneUrl = URL.createObjectURL(first.blob);
    donePreview.innerHTML = "";
    const img = document.createElement("img");
    img.src = doneUrl;
    img.alt = `Your image with ${plural(first.areas, "area")} ${EFFECT_VERB[effect]}`;
    img.decoding = "async";
    donePreview.appendChild(img);

    const verb = EFFECT_VERB[effect];
    const areas = results.reduce((n, r) => n + r.areas, 0);
    const bytes = results.reduce((n, r) => n + r.blob.size, 0);
    if (results.length > 1) {
      doneTitle.textContent = `Done — ${plural(results.length, "image")}, ${plural(areas, "area")} ${verb}`;
      doneSub.textContent = `${formatBytes(bytes)} total · baked in for good, and none of it left your device`;
      downloadLabelEl.textContent = "Download all (.zip)";
    } else {
      doneTitle.textContent = `Done — ${plural(areas, "area")} ${verb}`;
      doneSub.textContent = `${formatBytes(bytes)} · baked in for good, and it never left your device`;
      downloadLabelEl.textContent = "Download";
    }
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

  async function download() {
    if (results.length === 0) return;
    if (results.length === 1) {
      saveBlob(results[0].blob, results[0].name);
      return;
    }
    // Lazy — JSZip is only ever fetched by users who actually ran a batch.
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const r of results) zip.file(r.name, r.blob);
    const zipBlob = await zip.generateAsync({ type: "blob" });
    saveBlob(zipBlob, `${EFFECT_SUFFIX[effect]}-images.zip`);
  }
  downloadBtn.addEventListener("click", () => void download());

  // ---- Reset / error ----
  function releaseItems() {
    for (const it of items) if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    items = [];
  }
  function reset() {
    releaseItems();
    active = -1;
    stageImg = null;
    selected = -1;
    results = [];
    if (doneUrl) {
      URL.revokeObjectURL(doneUrl);
      doneUrl = null;
    }
    strip.hidden = true;
    strip.querySelectorAll("[data-thumb]").forEach((n) => n.remove());
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
  let appendNext = false;
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("is-drag");
    dzTitle.textContent = "Drop to load your images";
  });
  ["dragleave", "dragend"].forEach((ev) =>
    dropzone.addEventListener(ev, () => {
      dropzone.classList.remove("is-drag");
      dzTitle.textContent = "Drag & drop your images";
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-drag");
    dzTitle.textContent = "Drag & drop your images";
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length) {
      appendNext = false;
      void acceptFiles(files);
    }
  });
  dropzone.addEventListener("click", () => {
    appendNext = false;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      e.preventDefault();
      appendNext = false;
      fileInput.click();
    }
  });
  browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    appendNext = false;
    fileInput.click();
  });
  stripAddBtn.addEventListener("click", () => {
    appendNext = true;
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length) void acceptFiles(files, appendNext);
    fileInput.value = "";
  });

  // Initial paint.
  updateHint();
}
