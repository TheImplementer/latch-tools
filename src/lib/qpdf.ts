// -----------------------------------------------------------------------
// qpdf, compiled to WebAssembly, for the one job pdf-lib can't do: reading
// and writing encrypted PDFs.
//
// pdf.js can open an encrypted file, which is all the tools that rasterise
// pages need. /sign-pdf/ is different: it stamps the original document with
// pdf-lib, and pdf-lib cannot decrypt. So an encrypted file goes through qpdf
// first, gets signed as a plain file, and, if it needed a password to open,
// goes back through qpdf to be locked with that same password.
//
// Weight: ~440 KB of gzipped wasm. It is fetched only when someone opens an
// encrypted PDF, and from our own origin like everything else, so the file
// itself still never leaves the browser. qpdf works on an in-memory
// filesystem inside the module; nothing touches the network or disk.
//
// Library choice was measured, not assumed (2026-11-17): @cantoo/pdf-lib
// decrypts but drops the document's /Info (title, author), and
// @pdfsmaller/pdf-decrypt has no AES-128 and fails on pdf-lib-made files.
// qpdf passed RC4-40/128, AES-128/256, owner-only and object-stream files.
// -----------------------------------------------------------------------

import wasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import type { QpdfInstance } from "@neslinesli93/qpdf-wasm";

/** What went wrong, in terms the UI can act on. */
export type QpdfFailure = "wrong-password" | "failed";

export class QpdfError extends Error {
  constructor(
    readonly reason: QpdfFailure,
    detail: string,
  ) {
    super(detail);
    this.name = "QpdfError";
  }
}

interface Runner {
  qpdf: QpdfInstance & {
    FS: QpdfInstance["FS"] & {
      writeFile(path: string, data: Uint8Array): void;
      unlink(path: string): void;
    };
  };
  /** qpdf's own messages from the current run. Never shown to the user. */
  log: string[];
}

let runner: Promise<Runner> | null = null;

function load(): Promise<Runner> {
  runner ??= (async () => {
    const mod = await import("@neslinesli93/qpdf-wasm");
    // The package is CommonJS; depending on the bundler the factory arrives as
    // the default export or as the module itself.
    const create = (mod.default ?? mod) as unknown as (
      opts: object,
    ) => Promise<Runner["qpdf"]>;
    const log: string[] = [];
    const qpdf = await create({
      locateFile: () => wasmUrl,
      // Emscripten prints to the console by default. Keep it here instead, so
      // a failure can be logged once with its cause.
      print: (s: string) => log.push(s),
      printErr: (s: string) => log.push(s),
    });
    return { qpdf, log };
  })();
  // A failed load (offline, blocked asset) must not stick for the session.
  runner.catch(() => {
    runner = null;
  });
  return runner;
}

let seq = 0;

/**
 * Run qpdf on `input` with `args`, where "$IN" and "$OUT" stand for the input
 * and output files. Exit code 3 means "succeeded with warnings", which for a
 * real-world PDF is routine.
 */
async function run(input: Uint8Array, args: string[]): Promise<Uint8Array> {
  const { qpdf, log } = await load();
  const n = ++seq;
  const inPath = `/in-${n}.pdf`;
  const outPath = `/out-${n}.pdf`;
  log.length = 0;
  qpdf.FS.writeFile(inPath, input);
  try {
    let code: number;
    try {
      code = qpdf.callMain(
        args.map((a) => (a === "$IN" ? inPath : a === "$OUT" ? outPath : a)),
      );
    } catch (e) {
      throw new QpdfError("failed", `qpdf threw: ${String(e)}`);
    }
    if (code !== 0 && code !== 3) {
      const detail = log.join("\n");
      throw new QpdfError(
        /invalid password/i.test(detail) ? "wrong-password" : "failed",
        `qpdf exit ${code}: ${detail}`,
      );
    }
    return qpdf.FS.readFile(outPath);
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        qpdf.FS.unlink(p);
      } catch {
        /* never written */
      }
    }
  }
}

/**
 * Remove a PDF's encryption. `password` is "" for a file that opens without
 * one (owner-password only, which is how editing restrictions are set).
 */
export function decryptPdf(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  return run(bytes, [`--password=${password}`, "--decrypt", "$IN", "$OUT"]);
}

/**
 * Lock a PDF with `password`, AES-256. The same password is used as the owner
 * password, so whoever can open the file can also do everything else with it:
 * that is what they could do with the signed copy anyway, and inventing a
 * second password nobody knows would lock the file against its own owner.
 */
export function encryptPdf(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  // Key=value flags, never qpdf's positional `--encrypt user owner bits` form:
  // a positional password that starts with "@" is read as a file to load
  // arguments from, and one that starts with "-" is parsed as an option.
  return run(bytes, [
    "$IN",
    "--encrypt",
    `--user-password=${password}`,
    `--owner-password=${password}`,
    "--bits=256",
    "--",
    "$OUT",
  ]);
}
