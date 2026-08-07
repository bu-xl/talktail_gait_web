/**
 * Minimal, dependency-free PDF writer: wraps a single baseline-JPEG image into a
 * one-page PDF (via /DCTDecode). Embedding the report as an image lets us render
 * arbitrary text — including Korean — on a canvas with the browser's fonts, then
 * place it in a PDF without embedding any CJK font program.
 */

const A4_W = 595.28;
const A4_H = 841.89;

/** Concatenate a list of (string | bytes) parts into one Uint8Array (latin1). */
function concatParts(parts: Array<string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface JpegPdfOptions {
  /** Page size in points. Defaults to A4 portrait. */
  pageWidth?: number;
  pageHeight?: number;
  /** Margin in points around the fitted image. */
  margin?: number;
}

/**
 * Build a one-page PDF embedding `jpeg` (a baseline JPEG, DeviceRGB) sized
 * imgW x imgH pixels. The image is scaled to fit the page within the margin,
 * preserving aspect ratio, and centred.
 */
export function jpegToPdf(
  jpeg: Uint8Array,
  imgW: number,
  imgH: number,
  opts: JpegPdfOptions = {},
): Uint8Array {
  const pageW = opts.pageWidth ?? A4_W;
  const pageH = opts.pageHeight ?? A4_H;
  const margin = opts.margin ?? 28;

  const availW = pageW - 2 * margin;
  const availH = pageH - 2 * margin;
  const scale = Math.min(availW / imgW, availH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;

  const objects: Array<string | Uint8Array> = [];
  // 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Image
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  );
  const content =
    `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  // Object 5 = image. Placeholder keeps the count right; the loop special-cases
  // it to splice in the binary JPEG stream (handled below).
  objects.push("");
  // Image object header (stream bytes appended separately).
  const imgHeader =
    `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`;

  // Assemble the file, tracking byte offsets for the xref table.
  const parts: Array<string | Uint8Array> = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (p: string | Uint8Array): void => {
    parts.push(p);
    pos += typeof p === "string" ? new TextEncoder().encode(p).length : p.length;
  };

  push("%PDF-1.4\n%\xff\xff\xff\xff\n");

  for (let i = 0; i < objects.length; i++) {
    offsets[i] = pos;
    const objNum = i + 1;
    if (objNum === 5) {
      push(`${objNum} 0 obj\n`);
      push(imgHeader);
      push(jpeg);
      push("\nendstream\nendobj\n");
    } else {
      push(`${objNum} 0 obj\n`);
      push(objects[i]);
      push("\nendobj\n");
    }
  }

  const xrefPos = pos;
  const count = objects.length + 1; // + free object 0
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
  );

  return concatParts(parts);
}
