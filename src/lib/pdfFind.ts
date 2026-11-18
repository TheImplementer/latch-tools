// -----------------------------------------------------------------------
// Find and black out: where a piece of a PDF's text is on the page.
//
// ./findPatterns decides WHAT matches, as character ranges in a page's text.
// This module turns those ranges into boxes on the page, and the accuracy of
// those boxes is the whole point: a box that stops one character short leaves
// the last digit of an account number readable in the redacted copy.
//
// pdf.js gives each run of text its start point, its direction and its total
// width, but not where each character inside it sits. Estimating that from the
// characters' share of the run, or from browser font metrics, was measured
// leaving 0.2–15% of the target's pixels uncovered. So the estimate is only a
// starting point: each box is then widened on the rendered page itself, out to
// the clear space around the ink it overlaps, which is what took the measured
// leak to zero across Chrome, pdf-lib and rotated pages in Chromium and WebKit.
// Widening only ever grows a box. When it can't decide, it errs towards
// covering a neighbouring character rather than missing one.
//
// Form-field values and free-text comments aren't part of a page's text
// content, but they are painted into the redacted output, so they are searched
// too. A match there blacks out the whole field.
// -----------------------------------------------------------------------

import type { PageViewport } from "pdfjs-dist";
import type { PdfPage } from "./pdf";
import type { Rect } from "./regions";
import type { Match } from "./findPatterns";

interface TextRun {
  kind: "text";
  str: string;
  /** pdf.js text-space → PDF user-space matrix, font size included. */
  transform: number[];
  /** Advance width of the whole run, in PDF user-space units. */
  width: number;
  /** Font ascent and descent as fractions of the font size. */
  ascent: number;
  descent: number;
  family: string;
}

interface FieldRun {
  kind: "field";
  str: string;
  /** [x1, y1, x2, y2] in PDF user space. */
  rect: number[];
}

type Run = TextRun | FieldRun;

export interface PageText {
  /** Every run joined into one searchable string. */
  text: string;
  /** For each character of `text`: its run, or -1 for a joining separator. */
  runOf: Int32Array;
  /** For each character of `text`: its offset within that run. */
  offsetOf: Int32Array;
  runs: Run[];
  /**
   * "none": no text at all (a scan, or text drawn as shapes). "garbled": the
   * text can't be trusted, usually a font with no map back to real
   * characters. Either way a search will miss things, and the UI says so.
   */
  readable: "ok" | "none" | "garbled";
}

// ---- Reading ----

/** Read a page's text, form-field values and free-text comments. */
export async function readPageText(page: PdfPage): Promise<PageText> {
  const tc = await page.getTextContent();
  const runs: Run[] = [];
  let text = "";
  const runOf: number[] = [];
  const offsetOf: number[] = [];
  const push = (s: string, run: number) => {
    for (let k = 0; k < s.length; k++) {
      text += s[k];
      runOf.push(run);
      offsetOf.push(k);
    }
  };
  const sep = (s: string) => {
    text += s;
    runOf.push(-1);
    offsetOf.push(0);
  };

  for (const item of tc.items) {
    if (!("str" in item)) continue;
    const style = tc.styles[item.fontName] ?? {};
    const idx = runs.length;
    runs.push({
      kind: "text",
      str: item.str,
      transform: item.transform,
      width: item.width,
      ascent:
        typeof style.ascent === "number" && style.ascent > 0
          ? style.ascent
          : 0.8,
      descent:
        typeof style.descent === "number" && style.descent < 0
          ? style.descent
          : -0.2,
      family: style.fontFamily || "sans-serif",
    });
    push(item.str, idx);
    // A line that ends in a hyphen joins the next with no space, so a number
    // the layout wrapped at its hyphen ("40-11-" / "22") still reads whole.
    if (item.hasEOL && !item.str.endsWith("-")) sep("\n");
  }

  // Form fields and free-text comments are painted into the output (the
  // export renders annotations), so their words have to be findable too.
  try {
    const annots = await page.getAnnotations({ intent: "display" });
    for (const a of annots as Array<Record<string, any>>) {
      let s = "";
      if (a.annotationType === 20 && typeof a.fieldValue === "string")
        s = a.fieldValue;
      else if (a.annotationType === 3 && typeof a.contentsObj?.str === "string")
        s = a.contentsObj.str;
      if (!s.trim() || !Array.isArray(a.rect)) continue;
      sep("\n");
      const idx = runs.length;
      runs.push({ kind: "field", str: s, rect: a.rect });
      push(s, idx);
    }
  } catch {
    // Annotations are a bonus; the page text is still searchable without them.
  }

  const visible = text.replace(/\s/g, "");
  let readable: PageText["readable"] = "ok";
  if (!visible.length) readable = "none";
  else {
    // Private-use code points, U+FFFD and C0 controls are what a font without
    // a usable /ToUnicode map comes out as.
    const bad = visible.match(/[-�\u0000-\u001F]/g)?.length ?? 0;
    if (bad / visible.length > 0.3) readable = "garbled";
  }

  return {
    text,
    runOf: Int32Array.from(runOf),
    offsetOf: Int32Array.from(offsetOf),
    runs,
    readable,
  };
}

// ---- Ink ----

/** Luminance of a rendered page, for widening boxes to the glyphs. */
export interface Ink {
  lum: Uint8Array;
  w: number;
  h: number;
}

export function inkOf(canvas: HTMLCanvasElement): Ink {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
    lum[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { lum, w: canvas.width, h: canvas.height };
}

/**
 * Whether a rendered page has anything on it — used to tell an image-only
 * page (a scan, which search can't see into) from a genuinely blank one.
 */
export function hasInk(canvas: HTMLCanvasElement): boolean {
  const { lum } = inkOf(canvas);
  let dark = 0;
  for (let i = 0; i < lum.length; i++) if (lum[i] < 200) dark++;
  return dark > lum.length * 0.002;
}

// ---- Boxes ----

/** An axis-aligned box in device pixels. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What snap() knows about the run a match sits in. */
interface RunInk {
  /** The whole run, estimated; its two ends are exact. */
  box: Box;
  /** Each word's estimated centre and width along the line, in pixels. */
  centres: [number, number][];
  /** The words the match covers, as indexes into `centres`. */
  first: number;
  last: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(str: string, family: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return str.length;
  measureCtx.font = `100px ${family}`;
  return measureCtx.measureText(str).width;
}

/**
 * Estimated box for characters [a, b) of a text run, in device pixels, plus
 * the run's direction on screen and its font size in device pixels.
 */
function estimate(
  run: TextRun,
  a: number,
  b: number,
  vp: PageViewport,
): { box: Box; dir: [number, number]; em: number } {
  const [A, B, C, D, E, F] = run.transform;
  const along = Math.hypot(A, B) || 1;
  const up = Math.hypot(C, D) || along;
  const fs = up;

  // Where [a, b) starts and ends along the run, as a fraction of its width.
  // Browser metrics for the run's generic family track the PDF's own glyph
  // widths far better than a character count does; the ink step below
  // corrects what's left.
  let f0 = a / run.str.length;
  let f1 = b / run.str.length;
  const full = measure(run.str, run.family);
  if (full > 0) {
    f0 = measure(run.str.slice(0, a), run.family) / full;
    f1 = measure(run.str.slice(0, b), run.family) / full;
  }
  const u0 = run.width * f0;
  const u1 = run.width * f1;
  const ux = A / along,
    uy = B / along;
  const vx = C / up,
    vy = D / up;
  const lo = run.descent * fs,
    hi = run.ascent * fs;

  const pts = [
    [u0, lo],
    [u1, lo],
    [u1, hi],
    [u0, hi],
  ].map(([u, v]) =>
    vp.convertToViewportPoint(E + ux * u + vx * v, F + uy * u + vy * v),
  );
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [p0, p1] = vp.convertToViewportPoint(E, F);
  const [q0, q1] = vp.convertToViewportPoint(E + ux, F + uy);
  const dl = Math.hypot(q0 - p0, q1 - p1) || 1;
  return {
    box: {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    },
    dir: [(q0 - p0) / dl, (q1 - p1) / dl],
    em: fs * vp.scale,
  };
}

/**
 * Widen a box out to the clear space around the glyphs it overlaps.
 *
 * Works along the text's direction on screen. Each edge moves outward past
 * ink, and past gaps narrower than the gap between two words, and stops at
 * the first word gap, or at a cap of 1.5 em. Stepping over the narrow gaps is
 * what catches the last character when the estimate stopped short of it;
 * stopping at the wide ones is what keeps the box off the next word.
 *
 * How wide a word gap is depends on the font, so where it can, this measures
 * it from the run itself (see wordGap). Otherwise it falls back to 0.2 em and
 * looks only at the middle band of the line, so that a table rule or an
 * underline running along the line doesn't read as one endless glyph.
 */
function snap(
  box: Box,
  horiz: boolean,
  em: number,
  ink: Ink,
  run?: RunInk,
): Box {
  const { lum, w: W, h: H } = ink;
  // How far an edge may move. Generous, because an OCR text layer can sit a
  // whole character away from the letters in the picture (measured: a layer
  // 6% off on a long word put the first letter outside a 0.6 em reach). Only
  // unbroken ink, such as a rule through the line, can use all of it.
  const cap = Math.max(3, Math.round(1.5 * em));
  const crossCap = Math.max(2, Math.round(0.35 * em));

  // Main axis = along the text. Cross axis = up the glyphs.
  let m0 = Math.floor(horiz ? box.x0 : box.y0);
  let m1 = Math.ceil(horiz ? box.x1 : box.y1);
  let c0 = Math.floor(horiz ? box.y0 : box.x0);
  let c1 = Math.ceil(horiz ? box.y1 : box.x1);
  const mMax = (horiz ? W : H) - 1;
  const cMax = (horiz ? H : W) - 1;
  const at = (m: number, c: number) =>
    horiz ? lum[c * W + m] : lum[m * W + c];

  // The line's background: the median luminance over the box and the reach
  // either side of it. Most of a line of text is background, and the median
  // copes with dark-on-light, light-on-dark and tinted table rows alike.
  const hist = new Uint32Array(256);
  let count = 0;
  for (let m = Math.max(0, m0 - cap); m <= Math.min(mMax, m1 + cap); m++) {
    for (let c = Math.max(0, c0); c <= Math.min(cMax, c1); c++) {
      hist[at(m, c)]++;
      count++;
    }
  }
  let bg = 255;
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc * 2 >= count) {
      bg = v;
      break;
    }
  }
  // Low on purpose. The faint anti-aliased last column of a glyph still has
  // to count as ink, or the box stops a pixel or two short of it; measured
  // on an OCR'd scan, where that sliver was visibly red. Treating paper grain
  // as ink only makes a box wider.
  const isInk = (v: number) => Math.abs(v - bg) > 28;

  const colIn = (lo: number, hi: number) => (m: number) => {
    if (m < 0 || m > mMax) return false;
    for (let c = Math.max(0, lo); c <= Math.min(cMax, hi); c++)
      if (isInk(at(m, c))) return true;
    return false;
  };
  let colInked = colIn(
    Math.round(c0 + (c1 - c0) * 0.22),
    Math.round(c1 - (c1 - c0) * 0.22),
  );
  let minGap = Math.max(2, Math.round(0.2 * em));
  let fitted = false;

  const measured = run ? wordBlobs(run, horiz, colIn(c0, c1)) : null;
  if (measured !== null) {
    minGap = measured.gap;
    // Gaps were measured over the full height of the line, so the walk has
    // to look at the same columns: a full stop sits below the middle band.
    colInked = colIn(c0, c1);
    // When the ink splits into exactly as many words as the text has, and
    // each lands near where the text says it should, start from the matched
    // words' own ink rather than the estimate. The estimate can overshoot
    // into the next word ("Sort c|ode: 20-45-67"), and widening alone can
    // only ever grow a box, never pull it back.
    const ws = measured.words;
    if (ws && run) {
      m0 = ws[run.first][0];
      m1 = ws[run.last][1];
      fitted = true;
    }
  }

  const extend = (start: number, step: 1 | -1) => {
    let edge = start,
      blank = 0;
    for (let p = start + step, n = 0; n < cap; p += step, n++) {
      if (p < 0 || p > mMax) break;
      if (colInked(p)) {
        edge = p;
        blank = 0;
      } else if (++blank >= minGap) break;
    }
    return edge;
  };
  m0 = extend(m0, -1);
  m1 = extend(m1, 1);

  // Up the glyphs: stop at the first clear row, so an accent or a descender
  // the font's metrics understated is still inside.
  const rowInked = (c: number) => {
    if (c < 0 || c > cMax) return false;
    for (let m = Math.max(0, m0); m <= Math.min(mMax, m1); m++)
      if (isInk(at(m, c))) return true;
    return false;
  };
  for (let n = 0; n < crossCap && rowInked(c0 - 1); n++) c0--;
  for (let n = 0; n < crossCap && rowInked(c1 + 1); n++) c1++;

  // Then the ends once more, over the full height of the line. The first pass
  // may only have looked at the middle band, and a glyph can overhang outside
  // it: the bar of a final "7" or "T" reaches past its stem at the top.
  // Measured leaving a red sliver on an OCR'd scan. Contiguous ink only, and
  // a short cap, so an underline running along the line can't drag the edge.
  const fullInked = colIn(c0, c1);
  const nudgeCap = Math.max(2, Math.round(0.3 * em));
  for (let n = 0; n < nudgeCap && fullInked(m0 - 1); n++) m0--;
  for (let n = 0; n < nudgeCap && fullInked(m1 + 1); n++) m1++;

  // The margin past the last ink. Smaller when the words were matched to
  // their own ink, whose edges are then known; in a tight face like Times
  // the full margin reaches the neighbouring word's first letter.
  const pad = Math.max(2, Math.round((fitted ? 0.06 : 0.12) * em));
  m0 -= pad;
  m1 += pad;
  c0 -= pad;
  c1 += pad;
  return horiz
    ? { x0: m0, y0: c0, x1: m1, y1: c1 }
    : { x0: c0, y0: m0, x1: c1, y1: m1 };

  /**
   * The gap that separates words in this run, in pixels, and where each word
   * is, or null if the ink doesn't say clearly.
   *
   * The run's ends are exact (pdf.js gives its start and its width), so its
   * ink can be split into blobs. A run of N words has N-1 word gaps, and they
   * should be the N-1 widest gaps between blobs. If they clearly are (the
   * narrowest of them at least 1.2× the widest of the rest), the threshold
   * sits halfway between the two groups. That tells a word space in a tight
   * face like Impact (barely 0.2 em) from the gap between two 1s in Arial
   * (nearly 0.3 em), which no single fixed number does. A one-word run has
   * no word gap to measure, so its widest letter gap, with a margin, is used
   * instead: anything wider than that is not inside the word.
   *
   * `words` is set only when the blobs, joined across letter gaps, make
   * exactly one group per word and each group sits within a word's width
   * (or an em) of where the text puts that word.
   */
  function wordBlobs(
    r: RunInk,
    hz: boolean,
    inked: (m: number) => boolean,
  ): { gap: number; words: [number, number][] | null } | null {
    const lo = Math.max(0, Math.floor(hz ? r.box.x0 : r.box.y0));
    const hi = Math.min(mMax, Math.ceil(hz ? r.box.x1 : r.box.y1));
    const blobs: [number, number][] = [];
    for (let m = lo; m <= hi; m++) {
      if (!inked(m)) continue;
      const last = blobs[blobs.length - 1];
      if (last && last[1] === m - 1) last[1] = m;
      else blobs.push([m, m]);
    }
    const n = r.centres.length;
    if (blobs.length < Math.max(2, n)) return null;
    const gaps = blobs.slice(1).map((b, k) => b[0] - blobs[k][1] - 1);
    const sorted = [...gaps].sort((x, y) => y - x);
    let gap: number;
    // A clear split can be trusted on its own. A close one (word gaps only a
    // pixel wider than letter gaps) is used only if the words it produces
    // land where the text says they are; otherwise a wrong threshold could
    // stop a box inside the very word it's covering.
    let clear = true;
    if (n <= 1) {
      gap = Math.max(2, Math.ceil(sorted[0] * 1.25) + 1);
    } else {
      const wordMin = sorted[n - 2];
      const letterMax = sorted[n - 1] ?? 0;
      if (wordMin <= letterMax) return null;
      clear = wordMin >= letterMax * 1.2 + 1;
      gap = Math.max(2, Math.ceil((wordMin + letterMax + 1) / 2));
    }

    const groups: [number, number][] = [];
    blobs.forEach((b, k) => {
      if (k > 0 && gaps[k - 1] < gap) groups[groups.length - 1][1] = b[1];
      else groups.push([b[0], b[1]]);
    });
    let words: [number, number][] | null = null;
    if (groups.length === n) {
      const near = groups.every((g, k) => {
        const c = (g[0] + g[1]) / 2;
        return (
          Math.abs(c - r.centres[k][0]) <= Math.max(0.6 * r.centres[k][1], 0.8 * em)
        );
      });
      if (near) words = groups;
    }
    if (!words && !clear) return null;
    return { gap, words };
  }
}

function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Boxes on the same line (they overlap across the line by more than half). */
function sameLine(a: Box, b: Box, horiz: boolean): boolean {
  const [a0, a1, b0, b1] = horiz
    ? [a.y0, a.y1, b.y0, b.y1]
    : [a.x0, a.x1, b.x0, b.x1];
  const ov = Math.min(a1, b1) - Math.max(a0, b0);
  return ov > 0.5 * Math.min(a1 - a0, b1 - b0);
}

/**
 * The boxes that cover one match, normalised to the page (0–1, the same space
 * the region editor works in). One box per line the match spans.
 *
 * `vp` and `ink` must come from the same render, at the same scale.
 */
export function boxesFor(
  pt: PageText,
  m: Match,
  vp: PageViewport,
  ink: Ink,
): Rect[] {
  // Split the match into per-run character spans.
  const spans = new Map<number, [number, number]>();
  for (let k = m.start; k < m.end; k++) {
    const r = pt.runOf[k];
    if (r < 0) continue;
    const off = pt.offsetOf[k];
    const s = spans.get(r);
    if (s) {
      s[0] = Math.min(s[0], off);
      s[1] = Math.max(s[1], off + 1);
    } else spans.set(r, [off, off + 1]);
  }

  const out: { box: Box; horiz: boolean }[] = [];
  for (const [r, [a, b]] of spans) {
    const run = pt.runs[r];
    let box: Box;
    let horiz = true;
    if (run.kind === "field") {
      // (pdf.js 6 dropped convertToViewportRectangle; two corners do it.)
      const [x0, y0] = vp.convertToViewportPoint(run.rect[0], run.rect[1]);
      const [x1, y1] = vp.convertToViewportPoint(run.rect[2], run.rect[3]);
      box = {
        x0: Math.min(x0, x1),
        y0: Math.min(y0, y1),
        x1: Math.max(x0, x1),
        y1: Math.max(y0, y1),
      };
      const pad = 2;
      box = {
        x0: box.x0 - pad,
        y0: box.y0 - pad,
        x1: box.x1 + pad,
        y1: box.y1 + pad,
      };
    } else {
      const est = estimate(run, a, b, vp);
      const [dx, dy] = est.dir;
      // Within ~2° of horizontal or vertical on screen: widen to the ink.
      // Anything else is left as the box around the rotated outline, which
      // already over-covers, with a margin.
      if (Math.abs(dy) < 0.035 || Math.abs(dx) < 0.035) {
        horiz = Math.abs(dx) >= Math.abs(dy);
        const whole = estimate(run, 0, run.str.length, vp).box;
        const spans = [...run.str.matchAll(/\S+/g)].map((w) => [w.index!, w.index! + w[0].length]);
        const centres = spans.map(([s0, s1]) => {
          const wb = estimate(run, s0, s1, vp).box;
          const [lo, hi] = horiz ? [wb.x0, wb.x1] : [wb.y0, wb.y1];
          return [(lo + hi) / 2, hi - lo] as [number, number];
        });
        let first = spans.findIndex(([, s1]) => s1 > a);
        let last = spans.length - 1 - [...spans].reverse().findIndex(([s0]) => s0 < b);
        if (first < 0 || last >= spans.length || last < first) first = last = -1;
        box = snap(
          est.box,
          horiz,
          est.em,
          ink,
          first < 0 ? undefined : { box: whole, centres, first, last },
        );
      } else {
        const pad = 0.15 * est.em;
        box = {
          x0: est.box.x0 - pad,
          y0: est.box.y0 - pad,
          x1: est.box.x1 + pad,
          y1: est.box.y1 + pad,
        };
      }
    }
    const prev = out.find(
      (o) => o.horiz === horiz && sameLine(o.box, box, horiz),
    );
    if (prev) prev.box = union(prev.box, box);
    else out.push({ box, horiz });
  }

  const W = ink.w,
    H = ink.h;
  return out.map(({ box }) => {
    const x0 = Math.max(0, box.x0) / W;
    const y0 = Math.max(0, box.y0) / H;
    const x1 = Math.min(W, box.x1) / W;
    const y1 = Math.min(H, box.y1) / H;
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  });
}
