// -----------------------------------------------------------------------
// Making a signature image: draw it, type it, or upload one.
//
// Whatever the route, the result is the same thing: a transparent PNG trimmed
// to the ink, so it can sit on a page without a white box around it and the
// placement handles hug the signature rather than a pad's empty margin.
//
// Nothing here touches a PDF and nothing here leaves the browser. The module is
// loaded the first time someone asks to create a signature (not on page load),
// and the handwriting fonts in ./signatureFonts only when the Type tab opens.
// -----------------------------------------------------------------------

export type Ink = "black" | "blue";

/** Near-black and a ballpoint blue; pure #000 looks harsh next to page text. */
const INK: Record<Ink, string> = { black: "#141414", blue: "#1b3a9e" };

/** A finished image, ready to embed. */
export interface PngAsset {
  blob: Blob;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))),
      "image/png",
    );
  });
}

export async function toAsset(canvas: HTMLCanvasElement): Promise<PngAsset> {
  return { blob: await canvasToPng(canvas), w: canvas.width, h: canvas.height };
}

/**
 * Crop a canvas to the bounding box of its non-transparent pixels, plus `pad`.
 * Returns null when there is nothing drawn.
 */
export function trimCanvas(
  src: HTMLCanvasElement,
  pad = 6,
): HTMLCanvasElement | null {
  const W = src.width;
  const H = src.height;
  if (!W || !H) return null;
  const { data } = src.getContext("2d")!.getImageData(0, 0, W, H);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad);
  y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(src, x0, y0, w, h, 0, 0, w, h);
  return out;
}

// ---- Draw ---------------------------------------------------------------

export interface Pad {
  hasInk(): boolean;
  undo(): void;
  clear(): void;
  setInk(ink: Ink): void;
  /** Re-measure after the pad's CSS size changes (or it first becomes visible). */
  layout(): void;
  /** The drawing, trimmed, or null if the pad is empty. */
  toCanvas(): HTMLCanvasElement | null;
  destroy(): void;
}

/**
 * A pad that takes mouse, pen and touch through Pointer Events.
 *
 * Points are stored in units of the pad's width rather than pixels, so a stroke
 * survives the pad being resized (a phone turned sideways, a dialog opening
 * after layout) and the export resolution is independent of what was on screen.
 * The canvas needs `touch-action: none` in CSS, or a finger drags the page
 * instead of drawing.
 */
export function createPad(
  canvas: HTMLCanvasElement,
  onChange: () => void,
): Pad {
  interface Pt {
    x: number;
    y: number;
    /** 0.5 for mouse and touch (no pressure), the real value for a pen. */
    p: number;
  }
  let strokes: Pt[][] = [];
  let current: Pt[] | null = null;
  let pointerId = -1;
  let ink: Ink = "black";

  const ctx = () => canvas.getContext("2d")!;
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function width(p: Pt): number {
    // A pen reports pressure and should vary; a mouse or finger is constant.
    return canvas.width * 0.0055 * (0.55 + p.p * 0.9);
  }

  /**
   * Segment i of a stroke: a quadratic curve through the stroke's points,
   * using each point as a control and the midpoints between them as the
   * on-curve ends. That is what turns a jagged list of pointer samples into a
   * smooth line.
   */
  function segment(pts: Pt[], i: number) {
    const c = ctx();
    const W = canvas.width;
    const start = i === 0 ? pts[0] : mid(pts[i - 1], pts[i]);
    const end = mid(pts[i], pts[i + 1]);
    c.lineWidth = width(pts[i]);
    c.beginPath();
    c.moveTo(start.x * W, start.y * W);
    c.quadraticCurveTo(pts[i].x * W, pts[i].y * W, end.x * W, end.y * W);
    c.stroke();
  }
  function tail(pts: Pt[]) {
    const c = ctx();
    const W = canvas.width;
    const n = pts.length;
    if (n === 1) {
      // A tap: draw a dot, so a full stop or an "i" dot is not lost.
      c.beginPath();
      c.arc(pts[0].x * W, pts[0].y * W, width(pts[0]) / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    const start = n === 2 ? pts[0] : mid(pts[n - 2], pts[n - 1]);
    c.lineWidth = width(pts[n - 1]);
    c.beginPath();
    c.moveTo(start.x * W, start.y * W);
    c.lineTo(pts[n - 1].x * W, pts[n - 1].y * W);
    c.stroke();
  }
  function setStyle() {
    const c = ctx();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = INK[ink];
    c.fillStyle = INK[ink];
  }
  function redraw() {
    const c = ctx();
    c.clearRect(0, 0, canvas.width, canvas.height);
    setStyle();
    for (const pts of strokes) {
      for (let i = 0; i < pts.length - 1; i++) segment(pts, i);
      tail(pts);
    }
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const scale = clamp(window.devicePixelRatio || 1, 2, 3);
    const w = Math.round(r.width * scale);
    const h = Math.round(r.height * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    redraw();
  }

  function pointAt(e: PointerEvent): Pt {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      // Units of width, not height, so x and y share one scale.
      y: (e.clientY - r.top) / r.width,
      p: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
    };
  }

  function onDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (current) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pointerId = e.pointerId;
    current = [pointAt(e)];
    strokes.push(current);
    setStyle();
    tail(current);
    onChange();
  }
  function onMove(e: PointerEvent) {
    if (!current || e.pointerId !== pointerId) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const pt = pointAt(ev);
      const last = current[current.length - 1];
      // Skip sub-pixel jitter; it only adds wobble to the curve.
      const minStep = 0.6 / canvas.width;
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < minStep) continue;
      current.push(pt);
      if (current.length >= 2) segment(current, current.length - 2);
    }
  }
  function onUp(e: PointerEvent) {
    if (!current || e.pointerId !== pointerId) return;
    if (canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
    // Finish the last stretch, which the midpoint scheme leaves undrawn.
    if (current.length >= 2) tail(current);
    current = null;
    pointerId = -1;
    onChange();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas);

  return {
    hasInk: () => strokes.length > 0,
    undo() {
      if (current) return;
      strokes.pop();
      redraw();
      onChange();
    },
    clear() {
      if (current) return;
      strokes = [];
      redraw();
      onChange();
    },
    setInk(next) {
      ink = next;
      redraw();
    },
    layout,
    toCanvas: () =>
      strokes.length
        ? trimCanvas(canvas, Math.round(canvas.width * 0.008))
        : null,
    destroy() {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    },
  };
}

// ---- Type ---------------------------------------------------------------

/** Longest an output image may be, in pixels; above this the text is scaled down. */
const MAX_TEXT_PX = 2400;

/**
 * Draw `text` in `fontCss` (a canvas font shorthand with a `{size}` token for
 * the pixel size) on a tight transparent canvas.
 *
 * Handwriting fonts overhang their advance width, and the overhang is exactly
 * the flourish people choose them for, so the canvas is sized from the glyph
 * bounding box rather than from measureText().width.
 */
function drawText(
  text: string,
  fontCss: (px: number) => string,
  color: string,
  size = 200,
): HTMLCanvasElement | null {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = fontCss(size);
  const m = probe.measureText(text);
  const left = m.actualBoundingBoxLeft ?? 0;
  const right = m.actualBoundingBoxRight ?? m.width;
  const textW = left + right;
  if (!(textW > 0)) return null;
  if (textW > MAX_TEXT_PX)
    return drawText(text, fontCss, color, size * (MAX_TEXT_PX / textW));

  const ascent = m.actualBoundingBoxAscent ?? size * 0.8;
  const descent = m.actualBoundingBoxDescent ?? size * 0.2;
  const pad = Math.round(size * 0.04);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textW) + pad * 2;
  canvas.height = Math.ceil(ascent + descent) + pad * 2;
  const c = canvas.getContext("2d")!;
  c.font = fontCss(size);
  c.fillStyle = color;
  c.textBaseline = "alphabetic";
  c.fillText(text, pad + left, pad + ascent);
  return canvas;
}

/** The typed name, drawn with the given font stack (see signatureFonts). */
export function renderTyped(
  text: string,
  stack: string,
  ink: Ink,
): HTMLCanvasElement | null {
  return drawText(text, (px) => `400 ${px}px ${stack}`, INK[ink]);
}

/** Plain text (a date, a printed name), in the system sans-serif. */
export async function renderStamp(text: string): Promise<PngAsset | null> {
  const canvas = drawText(
    text,
    (px) =>
      `500 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    INK.black,
    110,
  );
  return canvas ? toAsset(canvas) : null;
}

// ---- Upload -------------------------------------------------------------

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** The longest side an uploaded picture is scaled to: plenty for a signature. */
const MAX_UPLOAD_PX = 1600;

export class UploadError extends Error {}

async function decode(
  file: File,
): Promise<CanvasImageSource & { width: number; height: number }> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img>, which accepts what some bitmaps decoders refuse */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Turn an uploaded PNG or JPG into a signature canvas.
 *
 * With `removeBackground`, light pixels become transparent and the rest keep
 * their own colour. Each pixel's opacity is read from how far it is from paper
 * white, then the colour is "un-mixed" from the white it was blended with at
 * the edges, so a pen stroke keeps its colour instead of picking up a grey halo.
 * PNGs that are already transparent pass through that step unharmed, because
 * their transparent pixels stay transparent.
 */
export async function loadUpload(
  file: File,
  removeBackground: boolean,
): Promise<HTMLCanvasElement> {
  const okType =
    /^image\/(png|jpe?g)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  if (!okType)
    throw new UploadError(
      "Please choose a PNG or JPG picture of your signature.",
    );
  if (file.size > MAX_UPLOAD_BYTES)
    throw new UploadError("That picture is over 10 MB. Try a smaller one.");

  let img;
  try {
    img = await decode(file);
  } catch {
    throw new UploadError(
      "That picture couldn't be read. Try saving it as a PNG or JPG again.",
    );
  }
  const scale = Math.min(1, MAX_UPLOAD_PX / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const c = canvas.getContext("2d", { willReadFrequently: true })!;
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  if ("close" in img && typeof img.close === "function") img.close();

  if (removeBackground) {
    const px = c.getImageData(0, 0, canvas.width, canvas.height);
    const d = px.data;
    const LO = 110; // at or below this luminance a pixel is solid ink
    const HI = 232; // at or above this it is paper
    for (let i = 0; i < d.length; i += 4) {
      const a0 = d[i + 3];
      if (a0 === 0) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const a = clamp((HI - lum) / (HI - LO), 0, 1);
      if (a === 0) {
        d[i + 3] = 0;
        continue;
      }
      // Un-mix the white: observed = ink * a + 255 * (1 - a).
      for (let k = 0; k < 3; k++) {
        d[i + k] = clamp((d[i + k] - 255 * (1 - a)) / a, 0, 255);
      }
      d[i + 3] = Math.round(a0 * a);
    }
    c.putImageData(px, 0, 0);
  }

  const trimmed = trimCanvas(canvas, 6);
  if (!trimmed) {
    throw new UploadError(
      removeBackground
        ? "Nothing dark enough to keep was found in that picture. Try turning off Remove white background."
        : "That picture is empty.",
    );
  }
  return trimmed;
}

// ---- The dialog ---------------------------------------------------------

export interface SignatureDialog {
  open(): void;
  destroy(): void;
}

/**
 * Wire the signature dialog's markup (see SignWidget.astro) to the three
 * creation routes. `onUse` receives the finished PNG; the dialog closes itself.
 */
export function initSignatureDialog(
  root: HTMLElement,
  onUse: (asset: PngAsset) => void,
): SignatureDialog {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;
  const qa = <T extends HTMLElement = HTMLElement>(sel: string) =>
    Array.from(root.querySelectorAll(sel)) as T[];

  const dlg = q<HTMLDialogElement>('[data-el="sig-dialog"]');
  const methods = qa<HTMLInputElement>('input[name="sg-method"]');
  const panels = qa("[data-sg-panel]");
  const inkRow = q('[data-el="ink-row"]');
  const inks = qa<HTMLInputElement>('input[name="sg-ink"]');
  const useBtn = q<HTMLButtonElement>('[data-el="sig-use"]');
  const cancelBtn = q<HTMLButtonElement>('[data-el="sig-cancel"]');
  const closeBtn = q<HTMLButtonElement>('[data-el="sig-close"]');
  const message = q('[data-el="sig-message"]');

  // draw
  const padCanvas = q<HTMLCanvasElement>('[data-el="pad"]');
  const padWrap = q('[data-el="pad-wrap"]');
  const padUndo = q<HTMLButtonElement>('[data-el="pad-undo"]');
  const padClear = q<HTMLButtonElement>('[data-el="pad-clear"]');
  // type
  const typeInput = q<HTMLInputElement>('[data-el="type-input"]');
  const typeRows = qa<HTMLLabelElement>('[data-el="type-row"]');
  const typeNote = q('[data-el="type-note"]');
  // upload
  const upInput = q<HTMLInputElement>('[data-el="upload-input"]');
  const upBrowse = q<HTMLButtonElement>('[data-el="upload-browse"]');
  const upBg = q<HTMLInputElement>('[data-el="upload-bg"]');
  const upPreview = q('[data-el="upload-preview"]');
  const upName = q('[data-el="upload-name"]');

  let method: "draw" | "type" | "upload" = "draw";
  let ink: Ink = "black";
  let uploadFile: File | null = null;
  let uploadCanvas: HTMLCanvasElement | null = null;
  let typed: HTMLCanvasElement | null = null;
  let fontsMod: typeof import("./signatureFonts") | null = null;
  let typeToken = 0;
  let busy = false;

  const pad = createPad(padCanvas, () => {
    padWrap.classList.toggle("has-ink", pad.hasInk());
    padUndo.disabled = !pad.hasInk();
    padClear.disabled = !pad.hasInk();
    sync();
  });

  function say(text: string) {
    message.textContent = text;
    message.hidden = !text;
  }

  function sync() {
    for (const p of panels) p.hidden = p.dataset.sgPanel !== method;
    inkRow.hidden = method === "upload";
    let ready = false;
    if (method === "draw") ready = pad.hasInk();
    else if (method === "type")
      ready = !!typed && typeInput.value.trim().length > 0;
    else ready = !!uploadCanvas;
    useBtn.disabled = !ready || busy;
  }

  /** Draw the name in each style. Fonts are fetched the first time this runs. */
  async function renderType() {
    const token = ++typeToken;
    const text = typeInput.value.trim();
    const shown = text || "Your name";
    if (!fontsMod) fontsMod = await import("./signatureFonts");
    const mod = fontsMod;
    const loaded = await Promise.all(
      mod.SIGNATURE_FONTS.map((f) => mod.ensureFont(f, shown)),
    );
    if (token !== typeToken) return;
    typeNote.hidden = loaded.every(Boolean);
    typeRows.forEach((row, i) => {
      const font = mod.SIGNATURE_FONTS[i];
      const canvas = row.querySelector("canvas")!;
      const drawn = renderTyped(shown, mod.fontStack(font), ink);
      const ctx = canvas.getContext("2d")!;
      if (!drawn) {
        canvas.width = 1;
        canvas.height = 1;
        return;
      }
      canvas.width = drawn.width;
      canvas.height = drawn.height;
      ctx.drawImage(drawn, 0, 0);
      canvas.classList.toggle("is-placeholder", !text);
      if (row.querySelector("input")!.checked) {
        typed = text ? drawn : null;
      }
    });
    sync();
  }

  async function renderUpload() {
    if (!uploadFile) return;
    const token = ++typeToken;
    say("");
    try {
      const c = await loadUpload(uploadFile, upBg.checked);
      if (token !== typeToken) return;
      uploadCanvas = c;
      upPreview.innerHTML = "";
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", "Preview of your uploaded signature");
      upPreview.appendChild(c);
      upName.textContent = uploadFile.name;
    } catch (e) {
      if (token !== typeToken) return;
      uploadCanvas = null;
      upPreview.innerHTML = "";
      upName.textContent = "";
      say(
        e instanceof UploadError ? e.message : "That picture couldn't be used.",
      );
    }
    sync();
  }

  function setMethod(next: typeof method) {
    method = next;
    say("");
    if (next === "draw") requestAnimationFrame(() => pad.layout());
    if (next === "type") {
      void renderType();
      typeInput.focus();
    }
    sync();
  }

  function setInk(next: Ink) {
    ink = next;
    pad.setInk(next);
    if (method === "type") void renderType();
  }

  function reset() {
    pad.clear();
    typeInput.value = "";
    typed = null;
    uploadFile = null;
    uploadCanvas = null;
    upPreview.innerHTML = "";
    upName.textContent = "";
    upInput.value = "";
    say("");
    ink = "black";
    inks.forEach((i) => (i.checked = i.value === "black"));
    pad.setInk("black");
    methods.forEach((m) => (m.checked = m.value === "draw"));
    method = "draw";
    sync();
  }

  async function use() {
    if (busy) return;
    let source: HTMLCanvasElement | null = null;
    if (method === "draw") source = pad.toCanvas();
    else if (method === "type") source = typed;
    else source = uploadCanvas;
    if (!source) return;
    busy = true;
    sync();
    try {
      const asset = await toAsset(source);
      dlg.close();
      onUse(asset);
    } catch {
      say("We couldn't make an image from that. Try again.");
    } finally {
      busy = false;
      sync();
    }
  }

  methods.forEach((m) =>
    m.addEventListener(
      "change",
      () => m.checked && setMethod(m.value as typeof method),
    ),
  );
  inks.forEach((i) =>
    i.addEventListener("change", () => i.checked && setInk(i.value as Ink)),
  );
  padUndo.addEventListener("click", () => pad.undo());
  padClear.addEventListener("click", () => pad.clear());

  let typeTimer = 0;
  typeInput.addEventListener("input", () => {
    // One frame of debounce: three canvases redraw per keystroke.
    cancelAnimationFrame(typeTimer);
    typeTimer = requestAnimationFrame(() => void renderType());
  });
  typeRows.forEach((row) =>
    row
      .querySelector("input")!
      .addEventListener("change", () => void renderType()),
  );

  upBrowse.addEventListener("click", () => upInput.click());
  upInput.addEventListener("change", () => {
    const f = upInput.files?.[0];
    if (!f) return;
    uploadFile = f;
    void renderUpload();
  });
  upBg.addEventListener("change", () => void renderUpload());

  useBtn.addEventListener("click", () => void use());
  cancelBtn.addEventListener("click", () => dlg.close());
  closeBtn.addEventListener("click", () => dlg.close());
  // Esc is handled by <dialog> itself; there is no backdrop-click-to-close,
  // because losing a drawn signature to a stray click is worse than one extra
  // press of Cancel.

  return {
    open() {
      reset();
      dlg.showModal();
      requestAnimationFrame(() => pad.layout());
    },
    destroy() {
      pad.destroy();
    },
  };
}
