# pdf.js runtime assets

Copied verbatim from [`pdfjs-dist`](https://github.com/mozilla/pdf.js) v6.2.108
by `scripts/sync-pdfjs.mjs`. Do not edit by hand.

pdf.js is licensed under the **Apache License 2.0**
(<https://github.com/mozilla/pdf.js/blob/master/LICENSE>).

They are served from this origin rather than a CDN for the same reason the ONNX
runtime binary is (see `src/lib/detect.ts`): a privacy tool should not make the
user's browser talk to a third party in order to open their file. Nothing here
is uploaded — these are downloads, fetched on demand while a PDF is rendered.

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `cmaps/`          | Character-map tables for CJK text encodings                       |
| `standard_fonts/` | The 14 standard PDF fonts, for files that don't embed them        |
| `wasm/jbig2`      | JBIG2 decoder — scanned/fax documents                             |
| `wasm/openjpeg`   | JPEG 2000 decoder                                                 |
| `wasm/qcms`       | Colour management                                                 |
| `iccs/`           | Default CMYK ICC profile, for print-origin documents              |

`quickjs-eval.wasm` is deliberately **not** copied. It exists to execute
JavaScript embedded inside a PDF, and is referenced only by pdf.js's scripting
sandbox (`build/pdf.sandbox.mjs`) — which this site never imports, so that code
cannot run. The bundled `LICENSE_*` files cover the decoders above.
