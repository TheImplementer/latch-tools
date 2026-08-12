// -----------------------------------------------------------------------
// On-device object detection — proposes redaction regions for redact.ts.
//
// Runs two OpenCV Zoo models through ONNX Runtime Web, entirely in the
// browser: YuNet for faces (MIT) and LPD-YuNet for licence plates
// (Apache-2.0). Both the runtime's .wasm and the model weights are served
// from our own origin — ORT otherwise resolves its wasm against a CDN, which
// would break the "no third-party scripts" rule even though no file bytes
// would leave the device.
//
// Everything here is loaded lazily: this module must only ever be reached via
// `await import("./detect")` from inside a click handler, so neither the ~50KB
// of ORT glue nor the 13.5MB wasm touches the initial page payload.
//
// Detections are PROPOSALS. They come back as ordinary normalised rects that
// the user can move, resize and delete like any hand-drawn box, and nothing is
// ever exported without an explicit click. Recall is good, not perfect — the
// UI must never imply the detector found everything.
// -----------------------------------------------------------------------

import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";
// Self-hosted runtime binary. `?url` makes Vite emit it as a content-hashed
// asset (same treatment the jSquash codec wasm already gets) and hands us back
// the path to feed ORT.
// (The package's exports map publishes the binary at the top level, without
// the `dist/` segment. Importing `onnxruntime-web/wasm` resolves to ORT's
// "bundle" build, which inlines its own .mjs glue, so this is the only asset
// path we have to supply.)
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

export type DetectKind = "face" | "plate";

/** A detected box, normalised 0–1 against the source — same convention as Rect. */
export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export type DetectSource = ImageBitmap | HTMLCanvasElement;

export type DetectFailure = "unsupported" | "fetch" | "init" | "run";

export class DetectError extends Error {
  readonly reason: DetectFailure;
  constructor(reason: DetectFailure, message: string) {
    super(message);
    this.name = "DetectError";
    this.reason = reason;
  }
}

// ---- Model registry ----------------------------------------------------

/** A box in model-input pixel space, straight out of a decoder. */
interface Raw {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

interface ModelSpec {
  url: string;
  /** Both models are exported with FIXED input dims — we always letterbox to these. */
  inputW: number;
  inputH: number;
  scoreThreshold: number;
  nmsThreshold: number;
  keepTopK: number;
  decode: (out: Record<string, Tensor>, spec: ModelSpec) => Raw[];
}

const MODEL_BASE = "/models/";

const MODELS: Record<DetectKind, ModelSpec> = {
  face: {
    url: MODEL_BASE + "face_detection_yunet_2023mar.onnx",
    inputW: 640,
    inputH: 640,
    // OpenCV defaults to 0.9. These are reviewable proposals shown to a human,
    // so recall is worth more than precision — a spurious box is one click to
    // delete, a missed face is a privacy failure.
    scoreThreshold: 0.6,
    nmsThreshold: 0.3,
    keepTopK: 128,
    decode: decodeFace,
  },
  // ⚠️ NOT WIRED TO ANY PAGE — the weights are deliberately not shipped.
  //
  // LPD-YuNet is trained on Chinese plates, and upstream warns that other
  // regions "may be limited". Measured on 35 openly-licensed UK/EU/US car
  // photos (2026-08-12): at this threshold only 9/35 images produced any
  // detection — UK 8/24 and **US 0/9** — for a per-plate recall around 35%,
  // far under the 0.75 bar. Dropping the threshold to 0.15 lifted image-level
  // hits to 66% but started emitting degenerate full-width boxes, which on a
  // redaction tool is worse than finding nothing. Precision at 0.8 was good:
  // every box it did draw was on a real plate. It is simply blind to most
  // Western plates.
  //
  // The decoder below is correct and verified against the reference prior
  // generation, so it stays: swapping in a model that handles UK/EU/US plates
  // means changing this url (plus dims/thresholds) and setting detect="plate"
  // on the page. Until then nothing fetches this and the file is absent.
  plate: {
    url: MODEL_BASE + "license_plate_detection_lpd_yunet_2023mar.onnx",
    inputW: 320,
    inputH: 240,
    scoreThreshold: 0.8,
    nmsThreshold: 0.3,
    keepTopK: 64,
    decode: decodePlate,
  },
};

// ---- Face decode (YuNet, anchor-free) -----------------------------------
//
// Ported from OpenCV's FaceDetectorYNImpl::postProcess. The graph emits twelve
// heads — cls/obj/bbox/kps at strides 8, 16 and 32 — with one row per feature
// -map cell (at 640x640 that is 6400 / 1600 / 400 rows, which matches the
// exported output shapes exactly). No priors and no variances are involved;
// each cell predicts an offset from its own grid position. Keypoints are
// ignored: we only need boxes.

const FACE_STRIDES = [8, 16, 32] as const;

function decodeFace(out: Record<string, Tensor>, spec: ModelSpec): Raw[] {
  const res: Raw[] = [];
  for (const stride of FACE_STRIDES) {
    const cls = out[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = out[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = out[`bbox_${stride}`]?.data as Float32Array | undefined;
    if (!cls || !obj || !bbox) continue;

    const cols = Math.floor(spec.inputW / stride);
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < spec.scoreThreshold) continue;

      const c = i % cols;
      const r = Math.floor(i / cols);
      const b = i * 4;
      const cx = (c + bbox[b]) * stride;
      const cy = (r + bbox[b + 1]) * stride;
      const w = Math.exp(bbox[b + 2]) * stride;
      const h = Math.exp(bbox[b + 3]) * stride;
      res.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
    }
  }
  return res;
}

// ---- Plate decode (LPD-YuNet, prior-based) ------------------------------
//
// Ported from opencv_zoo's lpd_yunet.py (_priorGen / _decode). Unlike the face
// model this one is RetinaFace-style: fixed priors plus variance decoding. The
// feature-map sizes come from repeated INTEGER halving (not ceil) — at 320x240
// that gives 30x40, 15x20, 7x10, 3x5, which with the per-level min_sizes
// yields 3600+600+140+45 = 4385 priors, matching the model's output rows.
//
// `loc` is 14 wide: 4 box values then five landmark points. The reference
// derives the plate quad from points 0, 1, 3 and 4 (columns 4:6, 6:8, 10:12,
// 12:14), skipping the middle one. We take the axis-aligned bounding box of
// those four corners rather than the reference's first-two-corners shortcut,
// so a plate photographed at an angle is still fully covered.

const PLATE_STEPS = [8, 16, 32, 64];
const PLATE_MIN_SIZES = [
  [10, 16, 24],
  [32, 48],
  [64, 96],
  [128, 192, 256],
];
const PLATE_VARIANCE = 0.1;
const PLATE_CORNERS = [4, 6, 10, 12];

const priorCache = new Map<string, Float32Array>();

/** Priors as flat [cx, cy, sx, sy] quads, all normalised to the input size. */
function platePriors(w: number, h: number): Float32Array {
  const key = `${w}x${h}`;
  const hit = priorCache.get(key);
  if (hit) return hit;

  // feature_map_2th, then successive halving down to the 6th.
  let fh = Math.floor(Math.floor((h + 1) / 2) / 2);
  let fw = Math.floor(Math.floor((w + 1) / 2) / 2);
  const maps: Array<[number, number]> = [];
  for (let k = 0; k < 4; k++) {
    fh = Math.floor(fh / 2);
    fw = Math.floor(fw / 2);
    maps.push([fh, fw]);
  }

  const out: number[] = [];
  for (let k = 0; k < maps.length; k++) {
    const [rows, cols] = maps[k];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        for (const minSize of PLATE_MIN_SIZES[k]) {
          out.push(
            ((j + 0.5) * PLATE_STEPS[k]) / w,
            ((i + 0.5) * PLATE_STEPS[k]) / h,
            minSize / w,
            minSize / h,
          );
        }
      }
    }
  }

  const priors = Float32Array.from(out);
  priorCache.set(key, priors);
  return priors;
}

function decodePlate(out: Record<string, Tensor>, spec: ModelSpec): Raw[] {
  const loc = out.loc?.data as Float32Array | undefined;
  const conf = out.conf?.data as Float32Array | undefined;
  const iou = out.iou?.data as Float32Array | undefined;
  if (!loc || !conf || !iou) return [];

  const priors = platePriors(spec.inputW, spec.inputH);
  const n = Math.min(priors.length / 4, iou.length);
  const res: Raw[] = [];

  for (let i = 0; i < n; i++) {
    const score = Math.sqrt(clamp01(conf[i * 2 + 1]) * clamp01(iou[i]));
    if (score < spec.scoreThreshold) continue;

    const p = i * 4;
    const pcx = priors[p];
    const pcy = priors[p + 1];
    const psx = priors[p + 2];
    const psy = priors[p + 3];
    const base = i * 14;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of PLATE_CORNERS) {
      const px = (pcx + loc[base + c] * PLATE_VARIANCE * psx) * spec.inputW;
      const py = (pcy + loc[base + c + 1] * PLATE_VARIANCE * psy) * spec.inputH;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    res.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, score });
  }
  return res;
}

// ---- Shared post-processing --------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function iouOf(a: Raw, b: Raw): number {
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

/** Greedy IoU suppression, highest score first. */
export function nms(boxes: Raw[], threshold: number, keepTopK: number): Raw[] {
  const sorted = [...boxes].sort((p, q) => q.score - p.score);
  const kept: Raw[] = [];
  for (const cand of sorted) {
    if (kept.length >= keepTopK) break;
    if (kept.some((k) => iouOf(k, cand) > threshold)) continue;
    kept.push(cand);
  }
  return kept;
}

// ---- Capability probe ---------------------------------------------------

// The canonical WebAssembly SIMD feature-detection module. ORT dropped its
// non-SIMD build, so no SIMD means no detector at all — in which case the UI
// hides the button rather than offering something that can only fail.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

let supported: boolean | null = null;

export function detectSupported(): boolean {
  if (supported !== null) return supported;
  try {
    supported =
      typeof WebAssembly === "object" &&
      typeof WebAssembly.validate === "function" &&
      WebAssembly.validate(SIMD_PROBE);
  } catch {
    supported = false;
  }
  return supported;
}

// ---- Runtime bootstrap --------------------------------------------------

type OrtModule = typeof import("onnxruntime-web/wasm");

let ortPromise: Promise<OrtModule> | null = null;

async function ensureOrt(): Promise<OrtModule> {
  if (!detectSupported()) {
    throw new DetectError("unsupported", "WebAssembly SIMD is not available.");
  }
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import("onnxruntime-web/wasm");
      // MUST be set before the first session is created, or ORT resolves its
      // binary against a CDN. A Playwright test asserts no off-origin request.
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
      // Single-threaded on purpose: threads need SharedArrayBuffer, which needs
      // site-wide COOP/COEP headers. Not worth that blast radius for a model
      // that runs in tens of milliseconds.
      ort.env.wasm.numThreads = 1;
      // Escape hatch if main-thread jank ever becomes a problem: proxy = true
      // makes ORT spawn its own worker with no worker file of ours. It is known
      // to interact badly with custom wasmPaths, so it stays off for now.
      ort.env.wasm.proxy = false;
      ort.env.logLevel = "error";
      return ort;
    })().catch((e) => {
      ortPromise = null;
      throw new DetectError("init", String(e));
    });
  }
  return ortPromise;
}

// Cache the PROMISE, not the resolved session: a batch fires detect() many
// times back to back and a double-click can start two runs, so a plain
// null-check would race and build two wasm arenas. Evicting on failure is what
// makes "you're offline, try again" actually work.
const sessions = new Map<DetectKind, Promise<InferenceSession>>();

async function createSession(kind: DetectKind): Promise<InferenceSession> {
  const ort = await ensureOrt();
  const spec = MODELS[kind];

  let bytes: Uint8Array;
  try {
    // Fetch the weights ourselves rather than handing ORT a URL, so a 404 can
    // be told apart from being offline.
    const res = await fetch(spec.url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new DetectError("fetch", String(e));
  }

  try {
    return await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  } catch (e) {
    throw new DetectError("init", String(e));
  }
}

function ensureSession(kind: DetectKind): Promise<InferenceSession> {
  let p = sessions.get(kind);
  if (!p) {
    p = createSession(kind);
    sessions.set(kind, p);
  }
  return p.catch((e) => {
    sessions.delete(kind);
    throw e;
  });
}

/** Fetch runtime + weights ahead of a batch, so the progress bar isn't a stall. */
export async function prewarm(kind: DetectKind): Promise<void> {
  await ensureSession(kind);
}

// ---- Preprocessing ------------------------------------------------------

interface Letterboxed {
  tensorData: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

// One scratch canvas and one buffer, reused across every call — a 30-image
// batch would otherwise allocate 30 x 640x640x3 floats plus 30 canvases.
let scratch: {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null = null;
let scratchBuf: Float32Array | null = null;

function scratchFor(w: number, h: number) {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new DetectError("run", "Canvas 2D is unavailable.");
    scratch = { canvas, ctx };
  }
  if (scratch.canvas.width !== w || scratch.canvas.height !== h) {
    scratch.canvas.width = w;
    scratch.canvas.height = h;
  }
  return scratch;
}

/**
 * Scale-and-pad the source into the model's fixed input, preserving aspect.
 *
 * The reference implementations squash to the input size instead, which
 * distorts anything that isn't already the model's aspect ratio. Letterboxing
 * keeps face and plate geometry intact and makes the inverse mapping exact.
 */
function letterbox(src: DetectSource, w: number, h: number): Letterboxed {
  const sw = src.width;
  const sh = src.height;
  const scale = Math.min(w / sw, h / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const padX = Math.floor((w - dw) / 2);
  const padY = Math.floor((h - dh) / 2);

  const { ctx } = scratchFor(w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, sw, sh, padX, padY, dw, dh);

  const { data } = ctx.getImageData(0, 0, w, h);
  const plane = w * h;
  if (!scratchBuf || scratchBuf.length !== plane * 3) {
    scratchBuf = new Float32Array(plane * 3);
  }
  const f = scratchBuf;
  // Both models were exported for OpenCV's blobFromImage defaults: planar
  // NCHW, BGR channel order, raw 0-255 values, no mean subtraction and no
  // scaling. Canvas hands us interleaved RGBA, so the channels swap here.
  // If boxes ever come out as plausible nonsense, suspect this block first.
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    f[p] = data[i + 2];
    f[plane + p] = data[i + 1];
    f[plane * 2 + p] = data[i];
  }

  return { tensorData: f, scale, padX, padY };
}

// ---- Public entry point -------------------------------------------------

/**
 * Find regions worth redacting in one image.
 *
 * Returns boxes normalised against `src`, sorted by score. Never throws for
 * "nothing found" — that is an empty array, not an error.
 */
export async function detect(
  kind: DetectKind,
  src: DetectSource,
): Promise<Detection[]> {
  const spec = MODELS[kind];
  const session = await ensureSession(kind);
  const ort = await ensureOrt();

  const { tensorData, scale, padX, padY } = letterbox(
    src,
    spec.inputW,
    spec.inputH,
  );

  let out: Record<string, Tensor>;
  try {
    const tensor = new ort.Tensor("float32", tensorData, [
      1,
      3,
      spec.inputH,
      spec.inputW,
    ]);
    out = (await session.run({
      [session.inputNames[0]]: tensor,
    })) as unknown as Record<string, Tensor>;
  } catch (e) {
    throw new DetectError("run", String(e));
  }

  const raw = nms(spec.decode(out, spec), spec.nmsThreshold, spec.keepTopK);

  // Undo the letterbox, then normalise against the source.
  const sw = src.width;
  const sh = src.height;
  return raw.map((b) => ({
    x: (b.x - padX) / scale / sw,
    y: (b.y - padY) / scale / sh,
    w: b.w / scale / sw,
    h: b.h / scale / sh,
    score: b.score,
  }));
}
