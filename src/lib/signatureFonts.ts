// -----------------------------------------------------------------------
// Handwriting fonts for the "Type" signature tab.
//
// Self-hosted, like everything else this site runs: the woff2 files come from
// the @fontsource packages (SIL Open Font License 1.1), Vite copies them into
// /_astro/ with a content hash, and the page never talks to Google Fonts or any
// other third party to draw a name. This module is only reached through a
// dynamic import() the first time the Type tab opens, so the font bytes cost
// nothing for someone who draws or uploads instead.
//
// Each family is registered as two FontFace objects (latin and latin-ext) with
// the same unicode-range split the @fontsource stylesheets use. Calling
// document.fonts.load() with the text being drawn then fetches only the faces
// that text needs: "Anna" costs one file, "Łukasz" two.
// -----------------------------------------------------------------------

import dancingLatin from "@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff2?url";
import dancingLatinExt from "@fontsource/dancing-script/files/dancing-script-latin-ext-400-normal.woff2?url";
import caveatLatin from "@fontsource/caveat/files/caveat-latin-400-normal.woff2?url";
import caveatLatinExt from "@fontsource/caveat/files/caveat-latin-ext-400-normal.woff2?url";
import saintLatin from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-400-normal.woff2?url";
import saintLatinExt from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-ext-400-normal.woff2?url";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

export interface SignatureFont {
  id: string;
  /** What the style is called in the UI. */
  label: string;
  family: string;
  faces: { url: string; range: string }[];
}

export const SIGNATURE_FONTS: SignatureFont[] = [
  {
    id: "dancing",
    label: "Flowing",
    family: "Dancing Script",
    faces: [
      { url: dancingLatin, range: LATIN },
      { url: dancingLatinExt, range: LATIN_EXT },
    ],
  },
  {
    id: "caveat",
    label: "Casual",
    family: "Caveat",
    faces: [
      { url: caveatLatin, range: LATIN },
      { url: caveatLatinExt, range: LATIN_EXT },
    ],
  },
  {
    id: "saint",
    label: "Formal",
    family: "Mrs Saint Delafield",
    faces: [
      { url: saintLatin, range: LATIN },
      { url: saintLatinExt, range: LATIN_EXT },
    ],
  },
];

const registered = new Set<string>();

/** CSS font shorthand tail for canvas: the family, then a generic fallback. */
export function fontStack(f: SignatureFont): string {
  return `"${f.family}", "Segoe Script", "Brush Script MT", cursive`;
}

/**
 * Make `font` usable for drawing `text`. Resolves true when the glyphs are
 * ready, false when the file could not be fetched, in which case the caller
 * draws with the fallback stack and says so.
 */
export async function ensureFont(
  font: SignatureFont,
  text: string,
): Promise<boolean> {
  if (!registered.has(font.id)) {
    registered.add(font.id);
    for (const face of font.faces) {
      document.fonts.add(
        new FontFace(font.family, `url(${face.url}) format("woff2")`, {
          style: "normal",
          weight: "400",
          unicodeRange: face.range,
        }),
      );
    }
  }
  const spec = `400 64px "${font.family}"`;
  try {
    await document.fonts.load(spec, text || "A");
    return document.fonts.check(spec, text || "A");
  } catch {
    return false;
  }
}
