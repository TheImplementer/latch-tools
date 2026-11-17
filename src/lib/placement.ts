// -----------------------------------------------------------------------
// Placement layer: put images on a page preview, then drag, resize and delete
// them.
//
// This is deliberately not src/lib/regions.ts. That editor is about drawing new
// boxes on a canvas and painting an effect into them; the objects here already
// exist (a signature the user made elsewhere), keep their proportions, and
// should look exactly like what will be embedded. So each placement is a real
// <img> in an overlay sitting over the page canvas, which gets crisp scaling,
// native focus and a hit area bigger than a canvas-drawn handle for free.
//
// What is shared with the redaction editor is the model, not the code:
// rectangles are normalised (0–1, top-left origin) against the *displayed*
// page, the overlay is laid over the painted area of a letterboxed canvas, and
// everything goes through Pointer Events with capture so mouse, pen and touch
// take one path. src/lib/signPlace.ts turns these rectangles into PDF
// coordinates at export.
// -----------------------------------------------------------------------

import { clamp, type Rect } from "./regions";

/** An image the user made or typed, shared by every place it is stamped. */
export interface SignAsset {
  id: number;
  /** Object URL of the PNG, for the on-screen preview. */
  url: string;
  blob: Blob;
  /** Pixel size of the PNG. */
  w: number;
  h: number;
  kind: "signature" | "text";
  /** Short name for screen readers and hints: "Signature", or the text itself. */
  label: string;
}

/** One stamp on one page. `rect.h` follows from `rect.w` and the image shape. */
export interface Placed {
  id: number;
  asset: SignAsset;
  rect: Rect;
}

type Corner = "nw" | "ne" | "se" | "sw";
type Mode = "idle" | "moving" | "resizing";

/** Smallest a stamp may be made, as a fraction of the page width. */
export const MIN_W = 0.04;

export interface PlacementOptions {
  /** The positioned box that contains the stage (and the overlay). */
  wrap: HTMLElement;
  stage: HTMLCanvasElement;
  overlay: HTMLElement;
  /** The placements on the page currently shown. */
  getItems: () => Placed[];
  /** What a screen reader hears when an item takes focus. */
  describe: (item: Placed, index: number) => string;
  /** The selection moved ("select") or an item moved, resized or went ("commit"). */
  onChange: (kind: "select" | "commit") => void;
  onRemove: (id: number) => void;
}

export interface PlacementLayer {
  /** Rebuild the nodes from getItems(). */
  render(): void;
  /** Re-lay the overlay over the painted page, after any size change. */
  layout(): void;
  selectedId(): number | null;
  select(id: number | null): void;
  destroy(): void;
}

const SVG_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function createPlacementLayer(opts: PlacementOptions): PlacementLayer {
  const { wrap, stage, overlay, getItems, describe, onChange, onRemove } = opts;

  let selected: number | null = null;
  let mode: Mode = "idle";
  let corner: Corner | null = null;
  let origin: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let start = { x: 0, y: 0 };
  let activeId = -1;

  /**
   * Where the canvas bitmap is actually painted inside its element's box. The
   * stage is `object-fit: contain`, so it can be letterboxed; see the same note
   * in regions.ts. The overlay is laid over this rectangle, not the box.
   */
  function contentRect(): DOMRect {
    const r = stage.getBoundingClientRect();
    const ar = stage.width / stage.height;
    if (!isFinite(ar) || ar <= 0 || !r.width || !r.height) return r;
    if (r.width / r.height > ar) {
      const w = r.height * ar;
      return new DOMRect(r.left + (r.width - w) / 2, r.top, w, r.height);
    }
    const h = r.width / ar;
    return new DOMRect(r.left, r.top + (r.height - h) / 2, r.width, h);
  }

  function layout() {
    const wr = wrap.getBoundingClientRect();
    const cr = contentRect();
    // Absolute offsets are measured from the padding box, inside the border.
    overlay.style.left = `${cr.left - wr.left - wrap.clientLeft}px`;
    overlay.style.top = `${cr.top - wr.top - wrap.clientTop}px`;
    overlay.style.width = `${cr.width}px`;
    overlay.style.height = `${cr.height}px`;
  }

  function norm(clientX: number, clientY: number) {
    const r = overlay.getBoundingClientRect();
    return {
      x: (clientX - r.left) / (r.width || 1),
      y: (clientY - r.top) / (r.height || 1),
    };
  }

  const find = (id: number) => getItems().find((p) => p.id === id);
  const nodeOf = (id: number) =>
    overlay.querySelector<HTMLElement>(`[data-sign-item="${id}"]`);

  function paint(el: HTMLElement, r: Rect) {
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
    // The remove button floats above the item, which would hang off the top of
    // the page for an item near the edge; CSS moves it below in that case.
    el.dataset.nearTop = r.y < 0.07 ? "1" : "";
  }

  function markSelected() {
    overlay.querySelectorAll<HTMLElement>("[data-sign-item]").forEach((el) => {
      const on = Number(el.dataset.signItem) === selected;
      el.classList.toggle("is-selected", on);
    });
  }

  function select(id: number | null) {
    if (selected === id) return;
    selected = id;
    markSelected();
    onChange("select");
  }

  /** Keep h in step with w (the image's proportions never change). */
  function fitH(r: Rect, k: number): Rect {
    return { ...r, h: r.w * k };
  }

  function resizeFromCorner(p: { x: number; y: number }): Rect {
    const k = origin.h / origin.w; // height per unit width, fixed by the image
    const east = corner === "ne" || corner === "se";
    const south = corner === "sw" || corner === "se";
    // The opposite corner stays where it is.
    const ax = east ? origin.x : origin.x + origin.w;
    const ay = south ? origin.y : origin.y + origin.h;
    const dx = east ? p.x - ax : ax - p.x;
    const dy = south ? p.y - ay : ay - p.y;
    // Project the pointer onto the image's own diagonal, so dragging along
    // either axis (or between them) grows the image smoothly.
    const t = (dx + dy * k) / (1 + k * k);
    const maxW = Math.min(east ? 1 - ax : ax, (south ? 1 - ay : ay) / k);
    const w = clamp(t, Math.min(MIN_W, maxW), Math.max(maxW, 0.001));
    const h = w * k;
    return { x: east ? ax : ax - w, y: south ? ay : ay - h, w, h };
  }

  function onPointerDown(e: PointerEvent, item: Placed, el: HTMLElement) {
    if ((e.target as HTMLElement).closest(".sg-del")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    select(item.id);
    el.setPointerCapture(e.pointerId);
    activeId = item.id;
    origin = { ...item.rect };
    start = norm(e.clientX, e.clientY);
    const handle = (e.target as HTMLElement).closest<HTMLElement>(".sg-handle");
    if (handle) {
      mode = "resizing";
      corner = handle.dataset.corner as Corner;
    } else {
      mode = "moving";
    }
  }

  function onPointerMove(e: PointerEvent, item: Placed, el: HTMLElement) {
    if (mode === "idle" || activeId !== item.id) return;
    const p = norm(e.clientX, e.clientY);
    if (mode === "moving") {
      item.rect = {
        ...origin,
        x: clamp(origin.x + (p.x - start.x), 0, 1 - origin.w),
        y: clamp(origin.y + (p.y - start.y), 0, 1 - origin.h),
      };
    } else {
      item.rect = resizeFromCorner(p);
    }
    paint(el, item.rect);
  }

  function onPointerUp(e: PointerEvent, item: Placed, el: HTMLElement) {
    if (activeId !== item.id) return;
    if (el.hasPointerCapture(e.pointerId))
      el.releasePointerCapture(e.pointerId);
    mode = "idle";
    corner = null;
    activeId = -1;
    onChange("commit");
  }

  function onKeyDown(e: KeyboardEvent, item: Placed, el: HTMLElement) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const r = item.rect;
    const k = r.h / r.w;
    switch (e.key) {
      case "ArrowLeft":
        r.x = clamp(r.x - step, 0, 1 - r.w);
        break;
      case "ArrowRight":
        r.x = clamp(r.x + step, 0, 1 - r.w);
        break;
      case "ArrowUp":
        r.y = clamp(r.y - step, 0, 1 - r.h);
        break;
      case "ArrowDown":
        r.y = clamp(r.y + step, 0, 1 - r.h);
        break;
      case "+":
      case "=":
      case "-":
      case "_": {
        // Grow or shrink about the centre, then pull back inside the page.
        const f = e.key === "+" || e.key === "=" ? 1.08 : 1 / 1.08;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const maxW = Math.min(1, 1 / k);
        const w = clamp(r.w * f, Math.min(MIN_W, maxW), maxW);
        const next = fitH({ ...r, w }, k);
        next.x = clamp(cx - w / 2, 0, 1 - w);
        next.y = clamp(cy - next.h / 2, 0, 1 - next.h);
        item.rect = next;
        break;
      }
      case "Delete":
      case "Backspace":
        e.preventDefault();
        onRemove(item.id);
        return;
      case "Escape":
        select(null);
        el.blur();
        return;
      default:
        return;
    }
    e.preventDefault();
    paint(el, item.rect);
    onChange("commit");
  }

  function build(item: Placed, index: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "sg-item";
    el.dataset.signItem = String(item.id);
    el.tabIndex = 0;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", describe(item, index));
    paint(el, item.rect);

    const img = new Image();
    img.src = item.asset.url;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);

    for (const c of ["nw", "ne", "se", "sw"] as const) {
      const h = document.createElement("span");
      h.className = `sg-handle sg-${c}`;
      h.dataset.corner = c;
      h.setAttribute("aria-hidden", "true");
      el.appendChild(h);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sg-del";
    del.setAttribute("aria-label", "Remove this item");
    del.innerHTML = SVG_X;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove(item.id);
    });
    el.appendChild(del);

    el.addEventListener("pointerdown", (e) => onPointerDown(e, item, el));
    el.addEventListener("pointermove", (e) => onPointerMove(e, item, el));
    el.addEventListener("pointerup", (e) => onPointerUp(e, item, el));
    el.addEventListener("pointercancel", (e) => onPointerUp(e, item, el));
    el.addEventListener("keydown", (e) => onKeyDown(e, item, el));
    el.addEventListener("focus", () => select(item.id));
    return el;
  }

  function render() {
    const items = getItems();
    if (selected !== null && !find(selected)) selected = null;
    overlay.replaceChildren(...items.map((it, i) => build(it, i)));
    markSelected();
  }

  // A click on the page itself (anywhere that is not a placement) lets go of
  // the selection. The overlay ignores pointer events except on its items, so
  // those clicks reach the wrapper, and a touch on empty page still scrolls.
  const onWrapDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-sign-item]")) return;
    select(null);
  };
  wrap.addEventListener("pointerdown", onWrapDown);

  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);
  window.addEventListener("resize", layout);

  return {
    render,
    layout,
    selectedId: () => selected,
    select: (id) => {
      select(id);
      if (id !== null) nodeOf(id)?.focus({ preventScroll: true });
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener("resize", layout);
      wrap.removeEventListener("pointerdown", onWrapDown);
    },
  };
}
