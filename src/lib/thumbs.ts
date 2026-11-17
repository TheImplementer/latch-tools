// Swap a file row's format tile ("JFIF", "PNG") for a real preview once the
// browser has decoded the bytes. Formats it can't display — JPEG XL outside
// Safari, HEIC outside Safari — keep the text tile, so a failed decode looks
// exactly like it did before rather than like a broken image.
//
// The object URL is revoked as soon as the image settles either way: the
// decoded <img> keeps painting, and a 10-file batch of 50 MB photos would
// otherwise pin every original in memory until the tab closes.
export function attachThumb(tile: Element | null, blob: Blob): void {
  if (!tile) return;
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.className = "thumb-img";
  img.alt = "";
  img.decoding = "async";
  img.onload = () => {
    tile.replaceChildren(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}
