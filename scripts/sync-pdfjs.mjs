// Copies pdf.js's runtime asset directories out of node_modules into
// public/pdfjs/<version>/, so they are served from our own origin.
//
//   node scripts/sync-pdfjs.mjs
//
// Why not `?url` imports like the ONNX runtime binary gets in src/lib/detect.ts:
// these are whole directories that pdf.js fetches by name at runtime
// (`cMapUrl + "Adobe-Japan1-4.bcmap"`), so it needs a stable directory base,
// not a content-hashed filename. Version-in-the-path is what makes the
// immutable cache header in public/_headers safe — same trick the model
// filenames in public/models/ use.
//
// Re-run after bumping pdfjs-dist, then delete the old version directory.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = ROOT + "node_modules/pdfjs-dist/";
const version = JSON.parse(
  readFileSync(SRC + "package.json", "utf8"),
).version;
const DEST = `${ROOT}public/pdfjs/${version}/`;

// Everything a page might need to rasterise correctly. Because the raster IS
// our output, a missing glyph here is a wrong redaction, not a cosmetic bug.
const DIRS = [
  "cmaps", // CJK encodings
  "standard_fonts", // Helvetica/Times/etc. when a PDF doesn't embed them
  "iccs", // CMYK colour profile, so print-origin PDFs keep their colours
];
// Hand-picked rather than copying wasm/ wholesale: quickjs-eval is referenced
// only by pdf.js's scripting sandbox (build/pdf.sandbox.mjs), which we never
// import — so JavaScript embedded in a PDF cannot run and the wasm is dead
// weight. The *_nowasm_fallback.js shims are large pure-JS reimplementations
// of the decoders below; not worth shipping for the browsers we support.
const WASM = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"];
const LICENSES = [
  "LICENSE_JBIG2",
  "LICENSE_OPENJPEG",
  "LICENSE_QCMS",
  "LICENSE_PDFJS_JBIG2",
  "LICENSE_PDFJS_OPENJPEG",
  "LICENSE_PDFJS_QCMS",
];

if (existsSync(DEST)) rmSync(DEST, { recursive: true });
mkdirSync(DEST + "wasm", { recursive: true });
for (const dir of DIRS) cpSync(SRC + dir, DEST + dir, { recursive: true });
for (const f of [...WASM, ...LICENSES])
  cpSync(SRC + "wasm/" + f, DEST + "wasm/" + f);

writeFileSync(
  DEST + "NOTICE.md",
  `# pdf.js runtime assets

Copied verbatim from [\`pdfjs-dist\`](https://github.com/mozilla/pdf.js) v${version}
by \`scripts/sync-pdfjs.mjs\`. Do not edit by hand.

pdf.js is licensed under the **Apache License 2.0**
(<https://github.com/mozilla/pdf.js/blob/master/LICENSE>).

They are served from this origin rather than a CDN for the same reason the ONNX
runtime binary is (see \`src/lib/detect.ts\`): a privacy tool should not make the
user's browser talk to a third party in order to open their file. Nothing here
is uploaded — these are downloads, fetched on demand while a PDF is rendered.

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| \`cmaps/\`          | Character-map tables for CJK text encodings                       |
| \`standard_fonts/\` | The 14 standard PDF fonts, for files that don't embed them        |
| \`wasm/jbig2\`      | JBIG2 decoder — scanned/fax documents                             |
| \`wasm/openjpeg\`   | JPEG 2000 decoder                                                 |
| \`wasm/qcms\`       | Colour management                                                 |
| \`iccs/\`           | Default CMYK ICC profile, for print-origin documents              |

\`quickjs-eval.wasm\` is deliberately **not** copied. It exists to execute
JavaScript embedded inside a PDF, and is referenced only by pdf.js's scripting
sandbox (\`build/pdf.sandbox.mjs\`) — which this site never imports, so that code
cannot run. The bundled \`LICENSE_*\` files cover the decoders above.
`,
);

console.log(`Synced pdf.js ${version} assets → public/pdfjs/${version}/`);
