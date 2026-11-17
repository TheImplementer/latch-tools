// -----------------------------------------------------------------------
// Where a signature goes, in PDF terms. Pure maths: no DOM, no pdf-lib, no
// pdf.js, so it can be unit-tested in Node and imported from anywhere.
//
// The editor works on what the user sees: a page preview that pdf.js has
// already rotated and cropped, with a signature at a normalised (0–1,
// top-left origin) rectangle. pdf-lib draws in *user space*: origin at the
// bottom-left of the unrotated page, y pointing up, and a CropBox/MediaBox
// that need not start at (0, 0). Getting from one to the other wrongly is the
// classic way a signature ends up in the wrong corner, or off the page, on
// exactly the documents (scans, landscape forms) people tend to sign.
//
// The page's visible area is its CropBox clipped to its MediaBox, which is also
// what pdf.js displays (Page.view). Rotation is clockwise, in degrees.
// -----------------------------------------------------------------------

/** A rectangle in PDF user space (y up). Width and height are positive. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface PageGeometry {
  /** The visible area of the unrotated page, in user space. */
  view: Box;
  /** Clockwise rotation applied when the page is displayed. */
  rotation: Rotation;
}

/** A placement on the displayed page: normalised, top-left origin. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What to hand to pdf-lib's drawImage, with `rotate` in degrees. */
export interface DrawArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: Rotation;
}

/** Same rule as pdf.js: a multiple of 90, folded into 0–270, else upright. */
export function normaliseRotation(deg: number): Rotation {
  if (!Number.isFinite(deg) || deg % 90 !== 0) return 0;
  return (((deg % 360) + 360) % 360) as Rotation;
}

/** pdf-lib can report a box with negative extents if its corners are swapped. */
export function positiveBox(b: Box): Box {
  return {
    x: b.w < 0 ? b.x + b.w : b.x,
    y: b.h < 0 ? b.y + b.h : b.y,
    w: Math.abs(b.w),
    h: Math.abs(b.h),
  };
}

/**
 * The visible area: CropBox ∩ MediaBox, or the MediaBox when there is no
 * CropBox or the two do not overlap. pdf.js makes the same choice, and the
 * preview the user placed the signature on comes from pdf.js.
 */
export function visibleBox(media: Box, crop?: Box): Box {
  const m = positiveBox(media);
  if (!crop) return m;
  const c = positiveBox(crop);
  const x0 = Math.max(m.x, c.x);
  const y0 = Math.max(m.y, c.y);
  const x1 = Math.min(m.x + m.w, c.x + c.w);
  const y1 = Math.min(m.y + m.h, c.y + c.h);
  if (x1 - x0 > 0 && y1 - y0 > 0)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return m;
}

/** The page's size as displayed, in points: width and height swap at 90/270. */
export function displaySize(g: PageGeometry): { w: number; h: number } {
  return g.rotation === 90 || g.rotation === 270
    ? { w: g.view.h, h: g.view.w }
    : { w: g.view.w, h: g.view.h };
}

/**
 * Map a rectangle on the displayed page to drawImage arguments.
 *
 * pdf-lib places an image by its bottom-left corner and rotates it
 * counter-clockwise about that corner. The displayed page is the user-space
 * page rotated clockwise by `rotation`, so drawing the image rotated
 * counter-clockwise by the same angle makes it appear upright. The anchor
 * therefore has to be the displayed bottom-left corner of the rectangle,
 * carried back into user space:
 *
 *   rotation   displayed (u, v)  ->  user space
 *       0       x0 + u·W            y1 − v·H
 *      90       x0 + v·W            y0 + u·H
 *     180       x1 − u·W            y0 + v·H
 *     270       x1 − v·W            y1 − u·H
 *
 * with u and v the fractions across and down the displayed page, W and H the
 * unrotated width and height, and (x0, y0)–(x1, y1) the visible box.
 */
export function toDrawArgs(g: PageGeometry, r: NormRect): DrawArgs {
  const { x: x0, y: y0, w: W, h: H } = g.view;
  const x1 = x0 + W;
  const y1 = y0 + H;
  const disp = displaySize(g);
  const u = r.x;
  const v = r.y + r.h; // the displayed bottom edge
  let x: number;
  let y: number;
  switch (g.rotation) {
    case 90:
      x = x0 + v * W;
      y = y0 + u * H;
      break;
    case 180:
      x = x1 - u * W;
      y = y0 + v * H;
      break;
    case 270:
      x = x1 - v * W;
      y = y1 - u * H;
      break;
    default:
      x = x0 + u * W;
      y = y1 - v * H;
  }
  return {
    x,
    y,
    width: r.w * disp.w,
    height: r.h * disp.h,
    rotate: g.rotation,
  };
}

/**
 * Height of a placement as a fraction of the page height, for a given width
 * fraction, so that the image keeps its own proportions on this page.
 *
 *   h_pt / w_pt = imgH / imgW,   h = h_pt / pageH,   w = w_pt / pageW
 */
export function heightFor(
  w: number,
  imgW: number,
  imgH: number,
  pageW: number,
  pageH: number,
): number {
  return w * (pageW / pageH) * (imgH / imgW);
}
