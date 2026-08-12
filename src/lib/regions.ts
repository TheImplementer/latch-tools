// -----------------------------------------------------------------------
// Region editing — the drag-a-box-over-it layer, shared by the image
// redaction tools (src/lib/redact.ts) and the PDF one (src/lib/pdfRedact.ts).
//
// This module owns two things and deliberately nothing else:
//
//   1. processRegion — turning a rectangle of source pixels into an obscured
//      tile. Pure canvas maths, no DOM state, no knowledge of what it is
//      obscuring.
//   2. createRegionEditor — pointer/touch/keyboard editing of a Rect[] on top
//      of a canvas.
//
// It knows nothing about files, pages, queues or export. That split is what
// lets one image and one PDF controller share the interaction model without
// either of them having to pretend a PDF page is a File, or vice versa.
//
// Coordinates are normalised (0–1, relative to the surface, top-left origin)
// so a region maps cleanly onto both the scaled preview and the full-
// resolution export, independent of device-pixel-ratio or display size — and
// so a set of boxes can be copied across similarly-framed images or across the
// pages of a document.
// -----------------------------------------------------------------------

export type Effect = "blur" | "pixelate" | "blackout";

/** A redaction region in normalised surface space (x,y = top-left, 0–1). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Mode = "idle" | "creating" | "moving" | "resizing";
type Corner = "nw" | "ne" | "se" | "sw";

/** Per-effect labels, kept in one place so hint/filename stay in sync. */
export const EFFECT_VERB: Record<Effect, string> = {
  blur: "blurred",
  pixelate: "pixelated",
  blackout: "blacked out",
};
export const EFFECT_SUFFIX: Record<Effect, string> = {
  blur: "blurred",
  pixelate: "pixelated",
  blackout: "redacted",
};

export const MAX_STAGE = 1400; // longest-side backing resolution for the preview
export const THUMB = 96; // filmstrip thumbnail longest side
export const HANDLE_CSS = 11; // resize-handle hit size, in CSS pixels
export const MIN_REGION = 0.012; // discard drags smaller than this (normalised)
const EFFECT_PREVIEW_MAX = 16; // above this, skip the effect pass mid-drag
const ACCENT = "#55c28b";

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Yield a frame, so a progress meter actually paints before the next encode. */
export const raf = () =>
  new Promise((r) => requestAnimationFrame(() => r(null)));

export function makeCanvas(
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
}

/**
 * Drop a canvas's backing store immediately rather than waiting for GC.
 *
 * At 300 DPI an A4 page is a ~33 MB surface; a long document walks through
 * hundreds of them, and Safari in particular is slow to reclaim them.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Normalise a rect so width/height are positive (top-left origin). */
export function normalise(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- Effect maths (resolution-independent: scaled to region size) ----
function blurRadius(minSidePx: number, strength: number): number {
  const frac = 0.045 * strength + 0.035; // strength 1 → 0.08 … 5 → 0.26 of the shorter side
  return Math.max(3, Math.round(minSidePx * frac));
}
function blockSize(minSidePx: number, strength: number): number {
  const blocksAcross = [16, 12, 9, 6, 4][strength - 1] ?? 9; // higher strength → coarser
  return Math.max(4, Math.round(minSidePx / blocksAcross));
}

/**
 * Produce the obscured tile for one region, sampled from `src` at the given
 * pixel rect. Returns the inner region canvas plus where to paste it.
 *
 * The same function runs at preview resolution and at export resolution —
 * that is what makes "what you see is what gets baked in" true rather than
 * aspirational.
 */
export function processRegion(
  src: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  effect: Effect,
  strength: number,
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
    const r = blurRadius(minSide, strength);
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
  const block = blockSize(minSide, strength);
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

/**
 * Bake every region into a full-resolution copy of `source`.
 *
 * Two canvases on purpose: regions always sample from the untouched original,
 * so overlapping boxes can't feed each other's output back in.
 */
export function bakeRegions(
  source: CanvasImageSource,
  w: number,
  h: number,
  regions: Rect[],
  effect: Effect,
  strength: number,
): HTMLCanvasElement {
  const base = makeCanvas(w, h);
  base.ctx.drawImage(source, 0, 0, w, h);
  const out = makeCanvas(w, h);
  out.ctx.drawImage(base.canvas, 0, 0);
  for (const rc of regions) {
    const tile = processRegion(
      base.canvas,
      Math.round(rc.x * w),
      Math.round(rc.y * h),
      Math.round(rc.w * w),
      Math.round(rc.h * h),
      effect,
      strength,
    );
    if (tile) out.ctx.drawImage(tile.canvas, tile.dx, tile.dy);
  }
  releaseCanvas(base.canvas);
  return out.canvas;
}

// ---- The editor --------------------------------------------------------

export interface RegionEditorOptions {
  /** The visible canvas the user draws on. */
  stage: HTMLCanvasElement;
  /** The region array of whatever is currently on the stage. Mutated in place. */
  getRegions: () => Rect[];
  /** Clean pixels for the current surface, at stage resolution. */
  getStageImg: () => HTMLCanvasElement | null;
  getEffect: () => Effect;
  getStrength: () => number;
  /**
   * The host should re-sync its own UI.
   *
   * "select" — only the selection moved; refresh the hint line.
   * "commit" — the region set changed; refresh the hint line *and* anything
   *            that counts regions, such as a filmstrip badge.
   *
   * The editor repaints the stage itself immediately afterwards, so a host
   * must not call draw() from here.
   */
  onEdit: (kind: "select" | "commit") => void;
}

export interface RegionEditor {
  /** Repaint the stage: clean pixels, baked-look regions, then UI chrome. */
  draw(): void;
  selected(): number;
  setSelected(i: number): void;
  /** False while a drag is in flight — mutating regions then corrupts indices. */
  isIdle(): boolean;
  destroy(): void;
}

/**
 * Bind region editing to a canvas.
 *
 * All interaction is Pointer Events, so mouse, pen and touch take the same
 * path; the canvas needs `touch-action: none` in CSS for touch drags to draw
 * instead of scrolling the page. Keyboard editing needs it focusable
 * (`tabindex="0"`).
 */
export function createRegionEditor(opts: RegionEditorOptions): RegionEditor {
  const { stage, getRegions, getStageImg, getEffect, getStrength, onEdit } =
    opts;

  let selected = -1;
  let mode: Mode = "idle";
  let activeCorner: Corner | null = null;
  let dragStart = { x: 0, y: 0 };
  let dragOrigin: Rect = { x: 0, y: 0, w: 0, h: 0 };

  /**
   * Where the canvas bitmap is actually painted inside the element's box.
   *
   * The stage is styled `object-fit: contain` with a `max-height`, so a tall
   * image is letterboxed: the element can be 552×460 while the picture inside
   * it is only 368×460, with 92px of dead space each side. Mapping a pointer
   * against the element box instead of the painted area puts every drawn box
   * in the wrong place — badly wrong for portrait photos and for PDF pages,
   * which are portrait essentially always.
   */
  function contentRect() {
    const r = stage.getBoundingClientRect();
    const bitmapAR = stage.width / stage.height;
    if (!isFinite(bitmapAR) || bitmapAR <= 0 || !r.width || !r.height) return r;
    const boxAR = r.width / r.height;
    if (boxAR > bitmapAR) {
      // Pillarboxed: full height, narrower than the box.
      const w = r.height * bitmapAR;
      return new DOMRect(r.left + (r.width - w) / 2, r.top, w, r.height);
    }
    // Letterboxed: full width, shorter than the box.
    const h = r.width / bitmapAR;
    return new DOMRect(r.left, r.top + (r.height - h) / 2, r.width, h);
  }

  function stageToNorm(clientX: number, clientY: number) {
    const rect = contentRect();
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
    const stageImg = getStageImg();
    if (!stageImg) return;
    const ctx = stage.getContext("2d")!;
    const W = stage.width;
    const H = stage.height;
    const effect = getEffect();
    const strength = getStrength();
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(stageImg, 0, 0, W, H);

    const rs = getRegions();

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
        const tile = processRegion(
          stageImg,
          Math.round(rc.x * W),
          Math.round(rc.y * H),
          Math.round(rc.w * W),
          Math.round(rc.h * H),
          effect,
          strength,
        );
        if (tile) ctx.drawImage(tile.canvas, tile.dx, tile.dy);
      }
    }

    // UI chrome (outlines + handles) — not baked into the export.
    const cssW = contentRect().width || W;
    const ratio = W / cssW;
    const handle = HANDLE_CSS * ratio;
    rs.forEach((rc, i) => {
      const x = rc.x * W;
      const y = rc.y * H;
      const w = rc.w * W;
      const h = rc.h * H;
      const isSel = i === selected;
      ctx.lineWidth = Math.max(1.5, ratio * 1.5);
      ctx.strokeStyle = isSel ? ACCENT : "rgba(255,255,255,0.9)";
      ctx.setLineDash(isSel ? [] : [ratio * 5, ratio * 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      if (isSel) {
        const pts = cornerPoints({ x, y, w, h });
        ctx.fillStyle = ACCENT;
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

  // ---- Hit testing ----
  function hitCorner(rc: Rect, p: { x: number; y: number }): Corner | null {
    const rect = contentRect();
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
    const rs = getRegions();
    for (let i = rs.length - 1; i >= 0; i--) if (insideRect(rs[i], p)) return i;
    return -1;
  }

  // ---- Pointer interaction ----
  function onPointerDown(e: PointerEvent) {
    if (!getStageImg()) return;
    const rs = getRegions();
    stage.setPointerCapture(e.pointerId);
    stage.focus();
    const p = stageToNorm(e.clientX, e.clientY);
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
      onEdit("select");
      draw();
      return;
    }
    // Empty space → start a new region. It stays zero-sized until pointerup
    // decides whether the drag was big enough to keep, so no commit yet.
    selected = rs.length;
    rs.push({ x: p.x, y: p.y, w: 0, h: 0 });
    mode = "creating";
    dragOrigin = { x: p.x, y: p.y, w: 0, h: 0 };
    draw();
  }

  function onPointerMove(e: PointerEvent) {
    const p = stageToNorm(e.clientX, e.clientY);

    if (mode === "idle") {
      updateCursor(p);
      return;
    }
    const rs = getRegions();
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
      rs[selected] = {
        x: clamp(dragOrigin.x + dx, 0, 1 - dragOrigin.w),
        y: clamp(dragOrigin.y + dy, 0, 1 - dragOrigin.h),
        w: dragOrigin.w,
        h: dragOrigin.h,
      };
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
        rs[selected] = normalise({ x, y: p.y, w: p.x - x, h: bottom - p.y });
      else if (activeCorner === "se")
        rs[selected] = normalise({ x, y, w: p.x - x, h: p.y - y });
      else rs[selected] = normalise({ x: p.x, y, w: right - p.x, h: p.y - y });
    }
    draw();
  }

  function onPointerUp(e: PointerEvent) {
    if (stage.hasPointerCapture(e.pointerId))
      stage.releasePointerCapture(e.pointerId);
    const rs = getRegions();
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
    onEdit("commit");
    draw();
  }

  function updateCursor(p: { x: number; y: number }) {
    const rs = getRegions();
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
    const rs = getRegions();
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
    onEdit("commit");
    draw();
  }

  const onResize = () => {
    if (getStageImg()) draw();
  };

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  return {
    draw,
    selected: () => selected,
    setSelected: (i: number) => {
      selected = i;
    },
    isIdle: () => mode === "idle",
    destroy() {
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerUp);
      stage.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    },
  };
}
