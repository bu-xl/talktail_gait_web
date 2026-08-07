/**
 * Browser download helpers + RGBA->PNG via an offscreen canvas. These are the
 * only DOM-dependent parts of the export path.
 */

/** Trigger a browser download of a Blob under `filename`. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mime = "text/csv"): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

export function downloadBytes(filename: string, bytes: Uint8Array, mime = "image/gif"): void {
  // Copy into a plain ArrayBuffer-backed view so the Blob part type is satisfied.
  const part = bytes.slice().buffer as ArrayBuffer;
  downloadBlob(filename, new Blob([part], { type: mime }));
}

/** Render an RGBA buffer into a PNG Blob (composited over an opaque background). */
export async function rgbaToPngBlob(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  background: [number, number, number] = [5, 7, 10],
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for PNG export");

  // Opaque background first, then the heatmap (with its own alpha) on top.
  ctx.fillStyle = `rgb(${background[0]},${background[1]},${background[2]})`;
  ctx.fillRect(0, 0, width, height);
  const img = new ImageData(new Uint8ClampedArray(rgba), width, height);
  // Use a temp canvas so alpha compositing is honoured by drawImage.
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("2D canvas context unavailable for PNG export");
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/** Build a yyyymmdd-hhmmss timestamp for filenames. */
export function fileStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
